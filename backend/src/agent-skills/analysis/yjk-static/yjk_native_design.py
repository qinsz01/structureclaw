"""YJK 8 design requests and documented native result schemas.

Result layouts: vendor 8.0 设计结果接口说明, dsnGetBeamAsWithCal,
dsnGetColumnAs/ZYB and dsnGetSteelBeamCheck/SteelColumnCheck. Native
combinations remain native combinations; no selected elastic case is substituted.
"""
from __future__ import annotations

import math
import hashlib
import json
import re
from pathlib import Path


class NativeDesignError(ValueError):
    def __init__(self, message, error_code="NATIVE_RESULT_UNAVAILABLE"):
        self.error_code = error_code
        super().__init__(message)


PARAMETERS = {"beamCoverMm": ("int", "709", 10, 100),
              "columnCoverMm": ("int", "710", 10, 100),
              "beamStirrupSpacingMm": ("int", "816", 25, 500),
              "columnStirrupSpacingMm": ("int", "817", 25, 500)}
# Vendor preprocessing interface: YP_GZCY / YP_GZCYY. These select the
# native column effective-length method; they are not authored lengths l0.
STEEL_LENGTH_METHODS = {"steelColumnSwayX": "706", "steelColumnSwayY": "734"}
MAIN_REBAR_PARAMETERS = {"beamMainRebarGrade": "beam", "columnMainRebarGrade": "column"}
MAIN_REBAR_CODES = {"HRB400": {"model": 3, "result": 81104}, "HRB500": {"model": 4, "result": 81105}}


def compile_main_rebar(source: dict, supplied: dict) -> dict:
    """Use documented floor main-bar settings without changing other members."""
    explicit = {str(row["id"]): row["rebar_grade"] for row in source.get("elements", []) if row.get("rebar_grade") is not None}
    by_role = {role: supplied[key] for key, role in MAIN_REBAR_PARAMETERS.items() if key in supplied}
    if not explicit and not by_role:
        return {"floors": {}, "members": {}}
    if any(not isinstance(value, str) or value not in MAIN_REBAR_CODES for value in [*explicit.values(), *by_role.values()]):
        raise NativeDesignError("Main reinforcement grade must be HRB400 or HRB500 / 纵筋牌号须为 HRB400 或 HRB500", "ENGINE_INPUT_UNSUPPORTED")
    from native_story_geometry import compile_story_geometry
    layout = compile_story_geometry(source)
    groups = {}
    for row in source["elements"]:
        key = (layout["members"][str(row["id"])]["floor"], row["type"])
        groups.setdefault(key, []).append(row)
    floors, members = {}, {}
    for (floor, role), group in groups.items():
        requested = {explicit[str(row["id"])] for row in group if str(row["id"]) in explicit}
        global_grade = by_role.get(role)
        if global_grade is not None:
            requested.add(global_grade)
        if not requested:
            continue
        if len(requested) != 1:
            raise NativeDesignError("Native floor main-bar grades conflict / 同层同类构件纵筋牌号冲突", "ENGINE_INPUT_UNSUPPORTED")
        if global_grade is None and any(str(row["id"]) not in explicit for row in group):
            raise NativeDesignError("Native member-only main-bar override needs a mapped individual setter; other members must not change / 单构件纵筋覆盖尚缺专用映射，不能改同层其它构件", "ENGINE_INPUT_UNSUPPORTED")
        grade = requested.pop()
        floors.setdefault(floor, {})[role] = grade
        members.update({str(row["id"]): grade for row in group})
    return {"floors": floors, "members": members}


def _compile_design_request(request: dict | None, source: dict) -> dict | None:
    if not request:
        return None
    allowed = {"requested", "mode", "code", "adoptedNativeDefaults", "parameters"}
    if not isinstance(request, dict) or set(request) - allowed or request.get("requested") is not True:
        raise NativeDesignError("Unknown or incomplete native design request / 原生设计请求字段不明确")
    request = {**request, "mode": request.get("mode") or "code-check"}
    if request.get("mode") not in {"required-reinforcement", "code-check"}:
        raise NativeDesignError("Native design mode must be required-reinforcement or code-check / 原生设计模式不支持")
    if request.get("code") not in {"GB/T50010-2010(2024)", "GB50017-2017"}:
        raise NativeDesignError("YJK native design requires an explicit supported code/version / 须明确原生规范及版本")
    if request.get("adoptedNativeDefaults") is not True:
        raise NativeDesignError("Explicit adoption of read-back native design defaults is required / 须明确采用并记录原生设计默认参数")
    if source.get("site_seismic") or source.get("wind") or (source.get("analysis_control") or {}).get("design_params"):
        raise NativeDesignError("Native design has unmapped explicit site_seismic, wind or analysis_control.design_params / 原生设计尚未映射这些显式设计条件")
    expected_family = "steel" if request["code"] == "GB50017-2017" else "concrete"
    if any(row.get("category", row.get("type")) != expected_family for row in source.get("materials", [])):
        raise NativeDesignError("Native design has unmapped explicit mixed material code scopes / 混合材料须分别映射设计规范范围")
    if expected_family == "steel" and request["mode"] == "required-reinforcement":
        raise NativeDesignError("Steel design cannot request concrete reinforcement / 钢构件不能请求混凝土配筋")
    if (source.get("analysis_control") or {}).get("self_weight") is not False:
        raise NativeDesignError("Native design selfweight requires explicit reconciliation; current profile requires self_weight=false / 当前设计配置须明确关闭自重，含自重设计映射待接通")
    from commercial_context import project_commercial_model
    overrides = [path for path, value in project_commercial_model(source, "yjk")["designInputs"]["fields"].items()
                 if value is not None and value != {} and path not in {
                     "elements." + str(row["id"]) + ".rebar_grade" for row in source.get("elements", [])}]
    if overrides:
        raise NativeDesignError("Native design has unmapped explicit input fields / 原生设计存在尚未映射的显式参数: " + ", ".join(overrides))
    supplied = request.get("parameters", {})
    if not isinstance(supplied, dict) or set(supplied) - (set(PARAMETERS) | set(STEEL_LENGTH_METHODS) | set(MAIN_REBAR_PARAMETERS)):
        raise NativeDesignError("Unknown native design parameters / 未知原生设计参数")
    rebar = compile_main_rebar(source, supplied)
    if rebar["members"] and expected_family != "concrete":
        raise NativeDesignError("Main reinforcement settings require concrete members / 纵筋设置须用于混凝土构件", "ENGINE_INPUT_UNSUPPORTED")
    parameters = {"int": {"603": 60301, "604": 60401}, "float": {}}
    # Source cases already include exactly the requested gravity, if any.
    # Disable automatic DEAD selfweight for the native design combination set.
    parameters["float"].update({"801": 0., "803": 0.})
    if request["code"] == "GB50017-2017":
        parameters["int"]["752"] = 1
    for key, value in supplied.items():
        if key in MAIN_REBAR_PARAMETERS:
            continue
        if key in STEEL_LENGTH_METHODS:
            if expected_family != "steel" or type(value) is not bool:
                raise NativeDesignError("Steel length-method parameters require steel members and booleans / 钢柱计算长度方法须用于钢构件并提供布尔值")
            parameters["int"][STEEL_LENGTH_METHODS[key]] = int(value)
            continue
        kind, identifier, lower, upper = PARAMETERS[key]
        if type(value) is not int or not lower <= value <= upper:
            raise NativeDesignError(f"Invalid {key} / 原生设计参数取值无效")
        parameters[kind][identifier] = value
    return {"schema": "sclaw-yjk-design-request/v1", "request": request,
            "parameters": parameters, "loadScope": "explicit-source-cases-only",
            "mainRebar": rebar, "defaultPolicy": "adopt-and-read-back"}


def compile_design_request(request, source):
    try:
        return _compile_design_request(request, source)
    except ValueError as exc:
        if getattr(exc, "error_code", "NATIVE_RESULT_UNAVAILABLE") != "NATIVE_RESULT_UNAVAILABLE":
            raise
        message = str(exc)
        unsupported = "unmapped explicit" in message or "current profile" in message
        raise NativeDesignError(message, "ENGINE_INPUT_UNSUPPORTED" if unsupported else "ANALYSIS_INPUT_REQUIRED") from exc


def _number(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value in {-99999., -999999.}:
        raise NativeDesignError("Missing or invalid native design value / 原生设计数值缺失或无效")
    return value


def _rows(raw, groups, width, force_index, value_index=1):
    if not isinstance(raw, list) or len(raw) <= max(force_index, value_index):
        raise NativeDesignError("Native design tuple is incomplete / 原生设计返回元组不完整")
    count = raw[0]
    if type(count) is not int or not 0 < count <= 1000:
        raise NativeDesignError("Native design has no valid section count / 原生设计截面数量无效")
    values, forces = raw[value_index], raw[force_index]
    if not isinstance(values, list) or not isinstance(forces, list) or min(len(values), len(forces)) < count:
        raise NativeDesignError("Native design section buffer is incomplete / 原生设计截面数组不完整")
    for index in range(count):
        # Python/.NET flattens the final two C++ dimensions into one row.
        vector, actions = values[index], forces[index]
        if len(vector) != groups * width or len(actions) != groups * 6:
            raise NativeDesignError("Native design row differs from the documented SDK schema / 原生返回字段不符合官方接口定义")
        for group in range(groups):
            yield index, group, [_number(value) for value in vector[group*width:(group+1)*width]], [
                _number(value) for value in actions[group*6:(group+1)*6]]


def _combination(value):
    value = _number(value)
    if value < 0 or value != int(value):
        raise NativeDesignError("Invalid native design combination ID / 原生设计组合编号无效")
    return {"engine": "yjk", "scope": "software-automatic-design-combinations", "id": int(value)}


def parse_member_design(element_id: str, raw: dict, family: str, role: str) -> dict:
    records, checks = [], []
    source = {"engine": "yjk", "api": "YJKSDsnDataPy", "schema": "vendor-YJK8-design-results",
              "elementId": element_id, "valueOrigin": "native-sdk"}
    if family == "steel":
        method = "dsnGetSteelBeamCheck" if role == "beam" else "dsnGetSteelColumnCheck"
        names = ("top-strength", "bottom-strength", "top-stability", "bottom-stability", "shear-strength") if role == "beam" else (
            "strength", "x-stability", "y-stability")
        for station, group, values, actions in _rows(raw.get("steel_checks"), len(names), 3, 2):
            demand, capacity, combination = values
            if demand == capacity == combination == 0 and not any(actions):
                checks.append({"id": f"{element_id}:{station}:{names[group]}", "elementId": element_id,
                    "check": names[group], "nativeStationIndex": station, "status": "not_applicable",
                    "reason": "native-zero-action-section-not-designed", "nativeCombination": _combination(0),
                    "nativeDesignActions": actions, "source": {**source, "method": method}})
                continue
            if capacity <= 0:
                raise NativeDesignError("Native steel check has no positive allowable stress / 原生钢构件验算缺少有效允许应力")
            checks.append({"id": f"{element_id}:{station}:{names[group]}", "elementId": element_id,
                "check": names[group], "nativeStationIndex": station, "demand": demand, "capacity": capacity,
                "unit": "MPa", "signedStress": demand, "utilization": abs(demand)/capacity,
                "comparison": "absolute-native-stress-to-native-allowable",
                "status": "pass" if abs(demand) <= capacity else "fail", "nativeCombination": _combination(combination),
                "nativeDesignActions": actions, "source": {**source, "method": method}})
        if not any(row["status"] in {"pass", "fail"} for row in checks):
            raise NativeDesignError("Native steel member has no actual design checks / 原生钢构件无实际设计验算数据: " + element_id)
    elif family == "concrete":
        method = "dsnGetBeamAsWithCal" if role == "beam" else "dsnGetColumnAs"
        names = ("top-longitudinal", "bottom-longitudinal", "stirrup") if role == "beam" else (
            "x-longitudinal-including-corners", "y-longitudinal-including-corners", "x-stirrup", "y-stirrup")
        data = raw.get("reinforcement_with_calculation" if role == "beam" else "reinforcement")
        for station, group, values, actions in _rows(data, len(names), 4 if role == "beam" else 3,
                                                    2 if role == "beam" else 3, 1 if role == "beam" else 2):
            required, calculated = values[:2]
            if required < 0 or calculated < 0:
                raise NativeDesignError("Native reinforcement area is negative / 原生配筋面积无效")
            records.append({"elementId": element_id, "nativeStationIndex": station, "component": names[group],
                "requiredArea": required, "calculatedArea": calculated, "unit": "mm2",
                "nativeCombination": _combination(values[-1]), "nativeDesignActions": actions,
                "source": {**source, "method": method}, "scope": "required-reinforcement-not-installed-bars"})
        if not any(row["requiredArea"] > 0 for row in records):
            raise NativeDesignError("Native concrete member has no actual reinforcement design / 原生混凝土构件无实际配筋设计: " + element_id)
        if role == "column":
            values = raw.get("axial_compression_ratio")
            if not isinstance(values, list) or len(values) != 4:
                raise NativeDesignError("Native column axial-ratio result is missing / 原生柱轴压比结果缺失")
            demand, capacity, axial, combination = map(_number, values)
            if demand < 0 or capacity <= 0:
                raise NativeDesignError("Native column axial-ratio result is invalid / 原生柱轴压比结果无效")
            applicable = capacity <= 1
            checks.append({"id": element_id + ":axial-ratio", "elementId": element_id,
                "check": "axial-compression-ratio", "demand": demand, "capacity": capacity,
                "unit": "ratio", "status": ("pass" if demand <= capacity else "fail") if applicable else "not_applicable",
                "nativeCombination": _combination(combination), "nativeAxialForce": axial,
                "source": {**source, "method": "dsnGetColumnZYB"}})
    else:
        raise NativeDesignError("Native design material family is unsupported / 原生设计材料类型不支持")
    return {"records": records, "checks": checks}


def _read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def verify_physical_design_section(section: dict, native: dict) -> dict:
    """Design consumes actual geometry, not an elastic reference carrier."""
    shape = section.get("shape") or {}
    kind = shape.get("kind") or section.get("type")
    if kind == "rectangular":
        expected = [1, shape.get("B"), shape.get("H"), 0, 0, 0, 0]
    elif kind in {"H", "I"}:
        expected = [2, shape.get("tw"), shape.get("H"), shape.get("B"), shape.get("tf"), shape.get("B"), shape.get("tf")]
    elif kind in {"box", "Box"}:
        expected = [7, shape.get("B"), shape.get("H"), *([shape.get("t")] * 4)]
    else:
        raise NativeDesignError("Native design physical section has no mapped geometry / 原生设计截面几何尚未映射", "ENGINE_INPUT_UNSUPPORTED")
    values = (native or {}).get("section_info")
    if not isinstance(values, list) or len(values) < 7 or any(
            not math.isclose(_number(actual), _number(wanted), rel_tol=2e-7, abs_tol=1e-6)
            for actual, wanted in zip(values, expected)):
        raise NativeDesignError("Native physical design section differs from the source geometry / 原生设计截面与源物理几何不符")
    return {"sourceSectionId": section["id"], "nativeSectionInfo": values,
            "source": "dsnGetBeamSectInfo/dsnGetColumnSectInfo", "verified": True}


def audit_design_load_scope(directory: Path, mapping: dict, extracted: dict) -> dict:
    """Audit additional native load cases; selected source loads have their own audit."""
    text = (directory / "fea.dat").read_bytes().decode("gb18030")
    names = {match[1]: match[2] for match in re.finditer(r"(?m)^(\d+)\s+N=(\S+)\s+T=", text)}
    source_names = {row["nativeName"] for row in mapping["load_cases"]}
    active, section = None, ""
    extras = set()
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("*USE-STLD"):
            match = re.search(r"LCID=(\d+)", line)
            if not match or match[1] not in names:
                raise NativeDesignError("Native design load case is not identified / 原生设计工况缺少身份")
            active = names[match[1]]
            if active not in source_names:
                extras.add(active)
        elif line.startswith("*"):
            section = line[1:].split()[0]
        elif active not in source_names and active is not None and line:
            fields = dict(re.findall(r"\b([A-Z]+)=([^\s]+)", line))
            if section == "NODELOAD":
                values = [float(value) for value in fields.get("F", "").split(",")]
                valid = len(values) == 6 and all(_number(value) == 0 for value in values)
            elif section == "FRAMELOAD":
                values = [float(value) for value in fields.get("F", "").split(",")]
                valid = fields.get("T") == "UNILOAD" and len(values) == 4 and all(_number(values[i]) == 0 for i in (1, 3))
            else:
                raise NativeDesignError("Unmapped automatic native design load section: " + section)
            if not valid:
                raise NativeDesignError("Automatic native design case contains unauthored loads: " + active)
    native_cases = {row["name"]: row for row in extracted["load_cases"]}
    factors = {}
    for name in source_names:
        row = native_cases.get(name)
        values = row.get("nativeDesignCoefficients") if row else None
        # SDK8 includes the eleven documented coefficients plus a final flag.
        if not isinstance(values, list) or len(values) not in (11, 12):
            raise NativeDesignError("Source-case native design coefficients were not read back: " + name)
        factors[name] = {"nativeCaseId": row["id"], "coefficients": [_number(value) for value in values[:11]],
                        "nativeExtension": values[11:]}
    return {"passed": True, "sourceCases": factors, "additionalZeroLoadCases": sorted(extras),
            "combinationPolicy": "explicitly-adopted-software-defaults", "notUserAnalysisCombinations": True,
            "feaSha256": hashlib.sha256((directory / "fea.dat").read_bytes()).hexdigest()}


def complete_native_design(result: dict, source: dict, plan: dict, directory: Path) -> dict:
    """Publish documented SDK fields only after the same native project is bound."""
    context = result["nativeDesignContext"]
    context["request"] = plan["request"]
    if context["missingInputs"] or context["representation"].get("analysisOnly"):
        raise NativeDesignError("Native design needs physical sections/materials: " + str(context["missingInputs"]),
                                "ANALYSIS_INPUT_REQUIRED")
    extracted = _read_json(directory / "results.json")
    receipt = _read_json(directory / "native-design-settings-readback.json")
    from yjk_native_settings import verify_readback, _scalar
    if receipt.get("passed") is not True or receipt.get("audit", {}).get("written") != plan["parameters"]:
        raise NativeDesignError("Native design settings are not bound to this request / 设计参数未绑定当前请求")
    verify_readback(plan["parameters"], receipt["audit"]["readback"])
    effective = extracted.get("native_design_parameters", {})
    scalars = {kind: {key: _scalar(value, kind) for key, value in effective.get(kind, {}).items()}
               for kind in ("int", "float")}
    verify_readback(plan["parameters"], scalars)
    report = directory / "设计结果" / "mainjss.out"
    report_text = report.read_bytes().decode("gb18030")
    def enabled(label):
        return re.search(re.escape(label) + r"\s*[:：]\s*是", report_text) is not None
    code = plan["request"]["code"]
    if code == "GB/T50010-2010(2024)" and not enabled("执行《混凝土结构设计标准》2024"):
        raise NativeDesignError("Requested concrete code profile differs from the native report / 混凝土规范版本读回不符")
    if code == "GB50017-2017" and not enabled("执行《钢结构设计标准》(GB50017-2017)"):
        raise NativeDesignError("Requested steel code differs from the native report / 钢结构规范版本读回不符")
    load_scope = audit_design_load_scope(directory, _read_json(directory / "mapping.json"), extracted)
    materials = {row["id"]: row for row in source["materials"]}
    sections = {row["id"]: row for row in source["sections"]}
    rows = result.get("nativeDesignResults", {}).get("data", {}).get("elements", {})
    if set(rows) != {row["id"] for row in source["elements"]}:
        raise NativeDesignError("Native design members do not cover the physical model / 设计构件未覆盖物理模型")
    records, checks, inputs = [], [], {}
    for member in source["elements"]:
        key = member["id"]; raw = rows[key]["raw"]
        material = materials[member["material"]]
        family = material.get("category", material.get("type"))
        if family != ("steel" if code == "GB50017-2017" else "concrete"):
            raise NativeDesignError("Native design request must specify the code for every material family / 本次设计须匹配全部材料类型", "ENGINE_INPUT_UNSUPPORTED")
        grade = material.get("grade") or material.get("name")
        label = raw.get("native_material_label")
        label_grade = re.search(r"\bRc[cb]=([0-9.]+)(?![A-Za-z0-9])", label or "") if family == "concrete" else re.search(r"\bRs[cb]=(\S+)", label or "")
        identity = "C" + str(int(float(label_grade[1]))) if family == "concrete" and label_grade else (
            "Q" + label_grade[1].removeprefix("Q") if label_grade else None)
        if identity != grade:
            raise NativeDesignError("Native design material identity differs or has no official readback: " + key)
        effective_input = raw.get("effective_inputs")
        if not effective_input or any(value is None for value in effective_input.values()):
            raise NativeDesignError("Native member design inputs were not fully read back: " + key)
        requested_rebar = plan.get("mainRebar", {}).get("members", {}).get(key)
        if requested_rebar:
            prefix = "Beam" if member["type"] == "beam" else "Column"
            if effective_input.get(prefix + "MainStl") != MAIN_REBAR_CODES[requested_rebar]["result"]:
                raise NativeDesignError("Native main reinforcement grade differs from the request / 原生纵筋牌号与请求不一致: " + key)
        geometry = verify_physical_design_section(sections[member["section"]], rows[key].get("nativeGeometry"))
        parsed = parse_member_design(key, raw, family, member["type"])
        for item in parsed["records"] + parsed["checks"]:
            item["source"].update(nativeMemberId=rows[key]["yjk"]["totId"], nativeFloor=rows[key]["floor"])
        records.extend(parsed["records"]); checks.extend(parsed["checks"])
        inputs[key] = {"values": effective_input, "source": "YJKSPrePy post-calculation member readback",
                       "origin": "explicit-parameters-and-adopted-native-defaults", "physicalSection": geometry,
                       "materialIdentity": {"sourceGrade": grade, "nativeLabel": label, "verified": True}}
        rows[key]["interpretation"] = "documented-native-design-schema"
        limits = raw.get("native_limits")
        has_limits = raw.get("has_native_limits")
        if type(has_limits) is not bool or not isinstance(limits, list) or len(limits) != 2 or type(limits[0]) is not int or limits[0] < 0:
            raise NativeDesignError("Native member limit status is unavailable: " + key)
        values = limits[1]
        if not isinstance(values, list) or len(values) < limits[0] or has_limits != (limits[0] > 0):
            raise NativeDesignError("Native member limit count/status conflict: " + key)
        checks.append({"id": key + ":native-limit-report", "elementId": key,
            "check": "native-design-limit-report", "status": "fail" if has_limits else "pass",
            "nativeCombination": {"engine": "yjk", "scope": "all-native-design-combinations"},
            "nativeLimitCodes": values[:limits[0]],
            "source": {"engine": "yjk", "method": "dsnComHasLimitInf + dsnGetComTotLimitInf", "valueOrigin": "native-sdk"}})
    evidence_files = [directory / "results.json", directory / "native-design-settings-readback.json", report, directory / "fea.dat"]
    context.update(status="completed", eligibleForConclusion=True, missingInputs=[],
        defaultPolicy=plan["defaultPolicy"], effectiveParameters=scalars, effectiveMemberInputs=inputs,
        effectiveCodeProfile={"code": code, "adoptedGeneralCode": enabled("执行通用规范"), "report": str(report)},
        loadScope=load_scope, conclusionScope="native-design-results; not-installed-reinforcement-certification",
        evidence=[{"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in evidence_files],
        message={"en": "Documented native design fields under the recorded software combination/default policy.",
                 "zh": "按记录的原生组合与参数，读取官方设计字段；不代表已配钢筋复核。"})
    result["nativeDesignResults"].update(status="completed", verification="documented-sdk-fields-and-native-readback",
        records=records, checks=checks, context=context, boundToSelectedResult=False,
        complianceScope="reported-native-checks-only", reinforcementScope="required-not-installed")
    result["nativeDesignResults"]["data"]["verificationStatus"] = "verified-native-design-readback"
    return result
