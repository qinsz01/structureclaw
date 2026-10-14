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
from pathlib import Path


SOLVER_SHA256 = "28adde523fe58491f96727da7250c21e6304e56aef3d0ba0330da9c57e3adaf3"
PROFILES = {"C30": {"family": "concrete", "E": 30000., "G": 12000., "nativeGrade": 30., "resultGrade": 30.},
            "Q355": {"family": "steel", "E": 206000., "G": 79000., "nativeGrade": -355., "resultGrade": 29.}}


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
    if request.get("parameters") or source.get("site_seismic") or source.get("wind") or (source.get("analysis_control") or {}).get("design_params"):
        reject("Unmapped explicit native design parameters / 显式设计参数尚未逐项映射", "ENGINE_INPUT_UNSUPPORTED")
    from commercial_context import project_commercial_model
    fields = project_commercial_model(source, "pkpm")["designInputs"]["fields"]
    if any(value is not None and value != {} for value in fields.values()):
        reject("Unmapped explicit member/material design values / 构件或材料设计值尚未映射", "ENGINE_INPUT_UNSUPPORTED")
    if any((source.get("analysis_control") or {}).get(key) is not False for key in
           ("self_weight", "rigid_floor", "rigid_offsets", "construction_stage", "p_delta")):
        reject("Native profile requires explicit linear bare-frame controls / 原生配置须明确线性裸杆设置", "ENGINE_INPUT_UNSUPPORTED")
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
    return {"schema": "sclaw-pkpm-native-design-request/v1", "request": {**request, "mode": mode},
            "materials": materials, "defaultPolicy": "adopt-and-read-back",
            "combinationScope": "software-automatic-design-combinations"}


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
        ("执行全国规范版本", "钢结构设计执行规范", "保护层", "钢筋强度", "钢筋间距", "箍筋间距", "组合系数", "分项系数"))]
    if not any("通用规范2021版" in line for line in lines):
        raise NativeDesignError("Native general code profile is not identified / 原生通用规范配置无法识别")
    if plan["request"]["code"] == "GB50017-2017" and not any("GB50017-2017" in line for line in lines):
        raise NativeDesignError("Native steel code readback differs / 原生钢规范回读不符")
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
        checks.append({"id": identity + ":native-limit-report", "elementId": identity,
            "check": "native-design-limit-report", "status": "fail" if row["limits"] else "pass",
            "nativeLimitCodes": row["limits"], "nativeCombination": {"scope": "all-native-design-combinations"},
            "source": {**origin, "method": "GetExceedLimitInfo"}})
    context = result["nativeDesignContext"]
    context.update(status="completed", eligibleForConclusion=True, missingInputs=[],
        defaultPolicy=plan["defaultPolicy"], effectiveCodeProfile={"code": plan["request"]["code"], "nativeReportLines": lines},
        materialProfiles=plan["materials"], conclusionScope="reported-native-checks-only; not-installed-reinforcement-certification",
        evidence=[{"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                  for path in (raw_path, report, directory / "DATA.SAT", directory / "WPJ1.OUT")])
    result["nativeDesignResults"] = {"status": "completed", "verification": "documented-sdk-fields-and-native-readback",
        "context": context, "records": records, "checks": checks, "rawMembers": raw,
        "boundToSelectedResult": False, "complianceScope": "reported-native-checks-only",
        "reinforcementScope": "required-not-installed"}
    return result
