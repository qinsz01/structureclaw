"""Explicit native-grade design, separate from exact user-material analysis.

The installed SDK documents reinforcement areas and native limit reports. Raw
stress arrays without documented layouts are retained, never reduced with max().
Native-grade stiffness profiles are version-bound and independently calibrated;
a conflicting canonical material is rejected rather than silently replaced.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path


SOLVER_SHA256 = "28adde523fe58491f96727da7250c21e6304e56aef3d0ba0330da9c57e3adaf3"
PROFILES = {"C30": {"family": "concrete", "E": 30000., "G": 12000., "nativeGrade": 30., "resultGrade": 30.},
            "C35": {"family": "concrete", "E": 31500., "G": 12600., "nativeGrade": 35., "resultGrade": 35.},
            "Q355": {"family": "steel", "E": 206000., "G": 79000., "nativeGrade": -355., "resultGrade": 29.}}
PARAMETERS = {"beamCoverMm": (709, "BCB", 10, 100), "columnCoverMm": (710, "ACA", 10, 100),
              "beamStirrupSpacingMm": (816, "SB", 25, 300), "columnStirrupSpacingMm": (817, "SC", 25, 300),
              "beamMainRebarGrade": (808, "IB", None, None), "columnMainRebarGrade": (809, "IC", None, None),
              "beamStirrupGrade": (811, "JB", None, None), "columnStirrupGrade": (812, "JC", None, None)}
# Actual SATREINFORCE_PARA_BY_LAYER.PM declares these native IDs. They are
# different from the older Python ReinforcingbarGrade enum after HRB400.
REBAR = {"HPB235": (1, 210.), "HRB335": (2, 300.), "HRB400": (3, 360.), "HPB300": (12, 270.), "HRB500": (13, 435.)}
# StandFloor is the data API (API 5.0, "settings codes"), not P-TRANS's
# interchange schema or the older Python enum. HRB500 is 13 here, not 6.
MODEL_REBAR = {"HRB400": 3, "HRB500": 13}


class NativeDesignError(ValueError):
    def __init__(self, message, error_code="NATIVE_RESULT_UNAVAILABLE"):
        self.error_code = error_code
        super().__init__(message)


def compile_design_request(request, source):
    if not request or request == {"requested": False}:
        return None
    def reject(message, code="ANALYSIS_INPUT_REQUIRED"):
        raise NativeDesignError(message, code)
    if (not isinstance(request, dict) or set(request) - {"requested", "mode", "code", "adoptedNativeDefaults", "parameters"}
            or request.get("requested") is not True):
        reject("Incomplete native design request / 原生设计请求不完整")
    mode = request.get("mode") or "code-check"
    if mode not in {"code-check", "required-reinforcement"} or request.get("adoptedNativeDefaults") is not True:
        reject("Adopt read-back native defaults and choose a supported design mode / 须明确采用回读的原生默认参数与设计模式")
    if request.get("code") not in {"PKPM-2025R2.5-native", "GB50017-2017"}:
        reject("Specify PKPM-2025R2.5-native or GB50017-2017 / 须明确已验收原生规范配置")
    if source.get("site_seismic") or source.get("wind") or (source.get("analysis_control") or {}).get("design_params"):
        reject("Unmapped explicit native design parameters / 显式设计参数尚未逐项映射", "ENGINE_INPUT_UNSUPPORTED")
    from commercial_context import project_commercial_model
    fields = project_commercial_model(source, "pkpm")["designInputs"]["fields"]
    supplied = request.get("parameters") or {}
    if not isinstance(supplied, dict) or set(supplied) - set(PARAMETERS):
        reject("Unknown native design parameters / 未知原生设计参数")
    supplied = dict(supplied)
    consumed = set()
    for role, parameter in (("beam", "beamMainRebarGrade"), ("column", "columnMainRebarGrade")):
        members = [row for row in source.get("elements", []) if row.get("type") == role]
        grades = []
        for member in members:
            prefix = "elements." + str(member["id"])
            values = []
            for path in (prefix, prefix + ".extra"):
                if fields.get(path + ".rebar_grade") is not None:
                    values.append(fields[path + ".rebar_grade"]); consumed.add(path + ".rebar_grade")
                data = fields.get(path + ".design")
                if isinstance(data, dict) and set(data) == {"rebar_grade"}:
                    values.append(data["rebar_grade"]); consumed.add(path + ".design")
            if values:
                if len(set(values)) != 1:
                    reject("Conflicting member reinforcement grade / 构件钢筋牌号冲突")
                grades.append(values[0])
        if grades:
            if len(grades) != len(members) or len(set(grades)) != 1:
                reject("Native per-role rebar profile requires one explicit grade on every affected member / 当前原生钢筋配置须同类构件全部指定同一牌号", "ENGINE_INPUT_UNSUPPORTED")
            if parameter in supplied and supplied[parameter] != grades[0]:
                reject("Requested rebar profile conflicts with the canonical model / 设计请求钢筋牌号与模型冲突")
            supplied[parameter] = grades[0]
    if any(value is not None and value != {} for path, value in fields.items() if path not in consumed):
        reject("Unmapped explicit member/material design values / 构件或材料设计值尚未映射", "ENGINE_INPUT_UNSUPPORTED")
    if any((source.get("analysis_control") or {}).get(key) is not False for key in
           ("rigid_offsets", "construction_stage", "p_delta")):
        reject("Native profile requires explicit linear bare-frame controls / 原生配置须明确线性裸杆设置", "ENGINE_INPUT_UNSUPPORTED")
    from native_settings import resolved_rigid_floor
    if type(resolved_rigid_floor(source)) is not bool:
        reject("Native design requires explicit diaphragm setting / 原生设计须明确楼板约束", "ENGINE_INPUT_UNSUPPORTED")
    from native_self_weight import compile_self_weight
    compile_self_weight(source)
    from native_model_contract import pkpm_section_shape
    for section in source.get("sections", []):
        if pkpm_section_shape(section) is None:
            reject("Native design requires explicit physical section geometry / 原生设计须提供真实截面几何", "ENGINE_INPUT_UNSUPPORTED")
    materials = {}
    for material in source.get("materials", []):
        grade = str(material.get("grade") or material.get("name") or "").upper()
        profile = PROFILES.get(grade)
        if profile is None:
            reject("Native design material profile is not calibrated: " + grade + " / 材料原生配置尚未校准", "ENGINE_INPUT_UNSUPPORTED")
        effective_g = material.get("G") or float(material.get("E", 0)) / (2 * (1 + float(material.get("nu", 0))))
        if not math.isclose(float(material.get("E", 0)), profile["E"], rel_tol=1e-10) or not math.isclose(effective_g, profile["G"], rel_tol=1e-10):
            reject(f"Native {grade} requires E={profile['E']} MPa, G={profile['G']} MPa; source model is unchanged / 原生材料刚度与源模型冲突，须显式修改模型", "ENGINE_INPUT_UNSUPPORTED")
        if request["code"] == "GB50017-2017" and profile["family"] != "steel":
            reject("Steel code cannot govern concrete / 钢规范不适用于混凝土")
        if mode == "required-reinforcement" and profile["family"] != "concrete":
            reject("Steel cannot request concrete reinforcement / 钢构件不能请求混凝土配筋")
        materials[str(material["id"])] = {**profile, "grade": grade, "nativeMaterialId": None,
            "sourceDensityKgM3": material.get("rho"), "selfWeightEnabled": False}
    if supplied and any(row["family"] != "concrete" for row in materials.values()):
        reject("Concrete reinforcement settings require concrete members / 钢筋参数只适用于混凝土")
    parameters = {}
    for key, value in supplied.items():
        identifier, report_symbol, lower, upper = PARAMETERS[key]
        if lower is None:
            if value not in REBAR:
                reject("Unmapped rebar grade: " + key + " / 钢筋牌号未映射")
            if "MainRebar" in key and value not in MODEL_REBAR:
                reject("Native main-bar profiles currently support HRB400 and HRB500 / 原生主筋配置当前支持HRB400与HRB500", "ENGINE_INPUT_UNSUPPORTED")
            native, effective = REBAR[value]
        else:
            if type(value) is not int or not lower <= value <= upper:
                reject("Invalid native design dimension: " + key + " / 设计尺寸无效")
            if "StirrupSpacing" in key and value != 100:
                reject("SATWE fixes beam/column design stirrup spacing at 100 mm; other detailing spacings require separately labelled area conversion / SATWE原生箍筋设计间距固定为100mm，其他实配间距须单独标明面积折算", "ENGINE_INPUT_UNSUPPORTED")
            native = effective = value
        parameters[key] = {"id": identifier, "nativeValue": native, "reportSymbol": report_symbol,
                           "expectedEffectiveValue": effective, "requested": value}
    return {"schema": "sclaw-pkpm-native-design-request/v1", "request": {**request, "mode": mode},
            "materials": materials, "parameters": parameters, "defaultPolicy": "adopt-and-read-back",
            "combinationScope": "software-automatic-design-combinations"}


def write_design_parameters(model, plan):
    """Official PMProjectPara fields; verify persisted inputs and solved report."""
    para = model.GetProjectPara()
    for row in plan["parameters"].values():
        para.SetParaDouble(row["id"], row["nativeValue"])
    for floor_index in range(1, model.GetStandFloorCount() + 1):
        model.SetCurrentStandFloor(floor_index)
        floor = model.GetCurrentStandFloor()
        for key, index in (("beamMainRebarGrade", 6), ("columnMainRebarGrade", 7)):
            row = plan["parameters"].get(key)
            if row:
                model_grade = MODEL_REBAR[row["requested"]]
                floor.SetInfoValue(index, model_grade)
                if floor.GetInfoValue(index) != model_grade:
                    raise NativeDesignError("Native floor rebar grade did not persist / 标准层钢筋牌号未保存")
        model.SaveOneStandFloor(floor_index)
    model.SetCurrentStandFloor(1)
    model.SaveProjectPara()
    for row in plan["parameters"].values():
        if para.GetPara_Double(row["id"]) != row["nativeValue"]:
            raise NativeDesignError("Native design input did not persist / 原生设计参数未保存")


def reapply_design_parameters(jws, plan):
    """PMCAD AUTORIB restores floor defaults; reapply before SATWE preprocessing.

    Use the official model setters, not generated result/input-file rewriting.
    Both the saved model and the eventual WMASS design values must agree.
    """
    import os
    import APIPyInterface as api
    previous = Path.cwd()
    jws = Path(jws).resolve()
    try:
        native = api.Model()
        if native.OpenPMModel(str(jws)) != 1:
            raise NativeDesignError("Cannot reopen native model for design parameters / 无法重开原生模型写入设计参数")
        write_design_parameters(native, plan)
        native.SavePMModel()
        if native.OpenPMModel(str(jws)) != 1:
            raise NativeDesignError("Cannot read persisted native design parameters / 无法读取已保存的原生设计参数")
        floors = []
        for index in range(1, native.GetStandFloorCount() + 1):
            native.SetCurrentStandFloor(index)
            floor = native.GetCurrentStandFloor()
            actual = {}
            for key, field in (("beamMainRebarGrade", 6), ("columnMainRebarGrade", 7)):
                row = plan["parameters"].get(key)
                if row:
                    actual[key] = floor.GetInfoValue(field)
                    if actual[key] != MODEL_REBAR[row["requested"]]:
                        raise NativeDesignError("Reopened native floor rebar grade differs / 重开后的标准层钢筋牌号不符")
            floors.append({"standardFloor": index, "parameters": actual})
        para = native.GetProjectPara()
        actual = {key: para.GetPara_Double(row["id"]) for key, row in plan["parameters"].items()}
        if any(actual[key] != row["nativeValue"] for key, row in plan["parameters"].items()):
            raise NativeDesignError("Reopened native project design parameter differs / 重开后的工程设计参数不符")
        receipt = {"schema": "pkpm-design-parameter-readback/v1", "stage": "after-pmcad-before-satwe-data",
                   "source": "APIPyInterface.Model/StandFloor; save-and-reopen", "floors": floors,
                   "parameters": actual, "requestSha256": hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest(),
                   "nativeProjectSha256": hashlib.sha256(jws.read_bytes()).hexdigest()}
        jws.with_name("native-design-parameter-readback.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
        return receipt
    finally:
        os.chdir(previous)


def verify_standard_materials(directory, model, plan, cycle_path):
    """Bind native grade records to the calibrated, versioned elastic profile."""
    directory = Path(directory)
    solver = Path(cycle_path).parent.parent / "Ribbon/SAT/SAT64/WINSAT-A_x64.exe"
    if hashlib.sha256(solver.read_bytes()).hexdigest() != SOLVER_SHA256:
        raise NativeDesignError("Native grade solver profile differs / 原生材料求解器版本不符")
    from native_numeric_sections import _members
    path = directory / "DATA.SAT"
    payload = path.read_bytes()
    members = _members(payload, model, (1., 2., 7.))
    for identity, row in members.items():
        material = plan["materials"][str(row["member"]["material"])]
        if row["row"][12] != material["nativeGrade"]:
            raise NativeDesignError("Native material grade differs: " + identity + " / 原生材料牌号不符")
    return {"source": "DATA.SAT; calibrated-standard-grade-profile", "sha256": hashlib.sha256(payload).hexdigest(),
            "solverSha256": SOLVER_SHA256, "materials": plan["materials"], "verified": True,
            "nativeCodeDesignSupported": True,
            "stiffnessSource": "version-bound native grade; independent axial/shear/torsion acceptance"}


def _number(value):
    if type(value) not in (float, int) or not math.isfinite(value) or value in {-99999., -999999.}:
        raise NativeDesignError("Missing native design value / 缺少有效原生设计值")
    return float(value)


def read_native_design(jws, member_map, source, plan):
    import APIPyInterface as api
    result = api.ResultData(); result.InitialResult(str(jws))
    members = {str(row["id"]): row for row in source["elements"]}
    output = {}
    for floor in sorted({key[1] for key in member_map}):
        for role, rows in (("beam", result.GetDesignBeams(floor)), ("column", result.GetDesignColumns(floor))):
            for row in rows:
                identity = member_map.get((int(row.GetPmid()), floor))
                if identity is None or identity in output:
                    raise NativeDesignError("Native design member mapping differs / 原生设计构件映射不符")
                profile = plan["materials"][str(members[identity]["material"])]
                grade = _number(row.GetConcreteGrade() if profile["family"] == "concrete" else row.GetSteelGrade())
                if grade != profile["resultGrade"]:
                    raise NativeDesignError("Native design grade differs: " + identity + " / 原生设计牌号不符")
                values = {"role": role, "grade": grade, "family": profile["family"], "pmid": int(row.GetPmid()), "floor": floor,
                          "limits": [{"code": int(item.m_ExceedType), "text": item.m_ExceedStr.rstrip("\0 ")} for item in row.GetExceedLimitInfo()]}
                names = (["GetTopReinforce", "GetDownReinforce"] if role == "beam" else ["GetXReinArea", "GetYReinArea", "GetAxialCompresRatio"]) if profile["family"] == "concrete" else ["GetCalcMax1", "GetCalcMax2", "GetCalcMax3"]
                for name in names:
                    value = getattr(row, name)()
                    values[name] = [_number(v) for v in value] if isinstance(value, list) else _number(value)
                output[identity] = values
    if set(output) != set(members):
        raise NativeDesignError("Native design coverage differs / 原生设计覆盖不完整")
    return output


def finish_native_design(result, source, plan, jws, member_map):
    if plan is None:
        return result
    directory = Path(jws).parent
    raw = read_native_design(jws, member_map, source, plan)
    raw_path = directory / "native-design-sdk.json"
    raw_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    report = directory / "WMASS.OUT"
    text = report.read_text(encoding="gb18030")
    lines = [line.strip() for line in text.splitlines() if any(word in line for word in
        ("执行全国规范版本", "钢结构设计执行规范", "保护层", "主筋强度", "箍筋强度", "箍筋最大间距", "组合系数", "分项系数"))]
    if not any("通用规范2021版" in line for line in lines):
        raise NativeDesignError("Native general code profile is not identified / 原生通用规范配置无法识别")
    if plan["request"]["code"] == "GB50017-2017" and not any("GB50017-2017" in line for line in lines):
        raise NativeDesignError("Native steel code readback differs / 原生钢规范回读不符")
    effective_parameters = {}
    for key, (_, symbol, _, _) in PARAMETERS.items():
        matches = re.findall(r"\b" + symbol + r"\s*=\s*([0-9.]+)", text)
        if len(matches) != 1:
            raise NativeDesignError("Missing effective native design parameter: " + key + " / 缺少原生有效设计参数")
        actual = float(matches[0])
        requested = plan.get("parameters", {}).get(key)
        if requested and actual != requested["expectedEffectiveValue"]:
            raise NativeDesignError("Native design setting differs: " + key + " / 原生设计参数未生效")
        effective_parameters[key] = {"value": actual, "unit": "MPa" if "Grade" in key else "mm",
            "requested": requested["requested"] if requested else None, "origin": "explicit" if requested else "adopted-native-default",
            "source": "WMASS.OUT:" + symbol}
    records, checks = [], []
    for identity, row in raw.items():
        origin = {"engine": "pkpm", "valueOrigin": "native-sdk", "elementId": identity,
                  "nativeFloor": row["floor"], "nativeMemberId": row["pmid"]}
        if row["family"] == "concrete":
            fields = (("GetTopReinforce", "top-longitudinal"), ("GetDownReinforce", "bottom-longitudinal")) if row["role"] == "beam" else (("GetXReinArea", "x-longitudinal-including-corners"), ("GetYReinArea", "y-longitudinal-including-corners"))
            for method, component in fields:
                values = row[method] if isinstance(row[method], list) else [row[method]]
                if not values or any(value < 0 for value in values) or not any(value > 0 for value in values):
                    raise NativeDesignError("Native reinforcement was not calculated: " + identity + " / 原生配筋未实际计算")
                if row["role"] == "beam" and len(values) != 9:
                    raise NativeDesignError("Native beam reinforcement stations differ / 原生梁配筋截面数不符")
                records.extend({"elementId": identity, "nativeStationIndex": index, "component": component,
                    "requiredArea": value, "unit": "mm2", "scope": "required-reinforcement-not-installed-bars",
                    "nativeCombination": {"scope": "software-automatic-design-envelope"},
                    "source": {**origin, "method": method}} for index, value in enumerate(values))
            if row["role"] == "column":
                ratio = row["GetAxialCompresRatio"]
                if len(ratio) != 4 or ratio[0] < 0 or ratio[0] != int(ratio[0]) or ratio[2] < 0 or ratio[3] <= 0:
                    raise NativeDesignError("Native axial-ratio tuple is incomplete / 原生轴压比元组不完整")
                checks.append({"id": identity + ":axial-ratio", "elementId": identity,
                    "check": "axial-compression-ratio", "demand": ratio[2], "capacity": ratio[3], "unit": "ratio",
                    "status": "pass" if ratio[2] <= ratio[3] else "fail", "nativeAxialForce": ratio[1],
                    "nativeCombination": {"scope": "software-automatic-design-combinations", "id": int(ratio[0])},
                    "source": {**origin, "method": "GetAxialCompresRatio; tuple calibrated against WPJ*.OUT"}})
        else:
            if not any(row[method] and any(value != 0 for value in row[method]) for method in ("GetCalcMax1", "GetCalcMax2", "GetCalcMax3")):
                raise NativeDesignError("Native steel member has no actual design checks: " + identity + " / 原生钢构件未实际验算")
            if row["role"] == "column":
                # Independently bound against all F1/F2/F3 / F printed for
                # six native Q355 box columns at normal and excess loads.
                # The remaining tuple positions are retained raw, not guessed.
                for method, check in (("GetCalcMax1", "strength"), ("GetCalcMax2", "x-stability"), ("GetCalcMax3", "y-stability")):
                    values = row[method]
                    if len(values) != 7 or values[0] < 0:
                        raise NativeDesignError("Native steel check ratio is unavailable / 原生钢验算比值缺失")
                    checks.append({"id": identity + ":" + check, "elementId": identity, "check": check,
                        "demand": values[0], "capacity": 1., "unit": "ratio", "utilization": values[0],
                        "status": "pass" if values[0] <= 1 else "fail",
                        "nativeCombination": {"scope": "software-automatic-design-envelope"},
                        "source": {**origin, "method": method + "; ratio calibrated against WPJ*.OUT"}})
        checks.append({"id": identity + ":native-limit-report", "elementId": identity,
            "check": "native-design-limit-report", "status": "fail" if row["limits"] else "pass",
            "nativeLimitCodes": row["limits"], "nativeCombination": {"scope": "all-native-design-combinations"},
            "source": {**origin, "method": "GetExceedLimitInfo"}})
    evidence_paths = [raw_path, report, directory / "DATA.SAT", directory / "WPJ1.OUT"]
    readback = directory / "native-design-parameter-readback.json"
    if readback.is_file():
        evidence_paths.append(readback)
    context = result["nativeDesignContext"]
    context.update(status="completed", eligibleForConclusion=True, missingInputs=[],
        defaultPolicy=plan["defaultPolicy"], effectiveCodeProfile={"code": plan["request"]["code"], "nativeReportLines": lines},
        effectiveParameters=effective_parameters,
        materialProfiles=plan["materials"], conclusionScope="reported-native-checks-only; not-installed-reinforcement-certification",
        evidence=[{"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                  for path in evidence_paths])
    result["nativeDesignResults"] = {"status": "completed", "verification": "documented-sdk-fields-and-native-readback",
        "context": context, "records": records, "checks": checks, "rawMembers": raw,
        "boundToSelectedResult": False, "complianceScope": "reported-native-checks-only",
        "reinforcementScope": "required-not-installed"}
    return result
