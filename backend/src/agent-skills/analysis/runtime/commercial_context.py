"""Keep authored design information separate from elastic solver projections.

Only known design-only fields are removed. Unknown extension fields remain in
the solver input so the existing physics contracts can reject them explicitly.
The projection never modifies the canonical model or certifies native design.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from pathlib import Path
from structure_protocol.design_properties import MaterialDesign, MemberDesign


MATERIAL_DESIGN_FIELDS = frozenset(MaterialDesign.model_fields)
MEMBER_DESIGN_FIELDS = frozenset(MemberDesign.model_fields) | {"rebar_grade"}


def content_hash(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def project_commercial_model(source: dict, engine: str) -> dict:
    """Produce an elastic projection plus a lossless, path-addressed design record."""
    if engine not in {"pkpm", "yjk"}:
        raise ValueError("Unknown commercial engine / 未知商业引擎")
    for section in source.get("sections", []):
        if "derived_properties" in (section.get("extra") or {}):
            from structure_protocol.section_properties import validate_derived_section_metadata
            validate_derived_section_metadata(section)
    analysis = copy.deepcopy(source)
    from native_defaults import apply_native_defaults
    assumptions = apply_native_defaults(analysis, engine)
    separated = {}
    input_evidence = {}
    for section in analysis.get("sections", []):
        extra = section.get("extra")
        if not isinstance(extra, dict):
            continue
        prefix = f"sections.{section['id']}.extra"
        confirmation = extra.get("confirmation")
        if confirmation is not None:
            if (not isinstance(confirmation, dict) or set(confirmation) != {"clarificationId", "candidateIds"}
                    or not isinstance(confirmation["clarificationId"], str) or not confirmation["clarificationId"]
                    or not isinstance(confirmation["candidateIds"], list) or not confirmation["candidateIds"]
                    or any(not isinstance(value, str) or not value for value in confirmation["candidateIds"])):
                raise ValueError("Invalid section confirmation evidence / 截面确认依据无效")
            input_evidence[prefix + ".confirmation"] = extra.pop("confirmation")
        if isinstance(extra.get("source"), str) and extra["source"].strip():
            input_evidence[prefix + ".source"] = extra.pop("source")
        if not extra:
            section.pop("extra")
    for material in analysis.get("materials", []):
        extra = material.get("extra")
        if not isinstance(extra, dict):
            continue
        prefix = f"materials.{material['id']}.extra"
        quantity = extra.get("densityInput")
        if quantity is not None:
            factors = {"kg/m3": 1., "t/m3": 1000., "N/m3": 1./9.80665, "kN/m3": 1000./9.80665}
            if (not isinstance(quantity, dict) or set(quantity) != {"value", "unit"}
                    or type(quantity.get("value")) not in (int, float) or not math.isfinite(quantity["value"])
                    or quantity["value"] <= 0 or not isinstance(quantity.get("unit"), str) or quantity["unit"] not in factors
                    or not math.isclose(float(material.get("rho", 0)), quantity["value"]*factors[quantity["unit"]], rel_tol=1e-12, abs_tol=0)):
                raise ValueError("Material density source conflicts with canonical rho / 原始密度数值及单位与规范rho不一致")
            input_evidence[prefix + ".densityInput"] = extra.pop("densityInput")
        if isinstance(extra.get("source"), str) and extra["source"].strip():
            input_evidence[prefix + ".source"] = extra.pop("source")
        if not extra:
            material.pop("extra")
    for collection, fields in (("materials", MATERIAL_DESIGN_FIELDS), ("elements", MEMBER_DESIGN_FIELDS)):
        for row in analysis.get(collection, []):
            prefix = f"{collection}.{row['id']}"
            for container, path in ((row, prefix), (row.get("extra"), prefix + ".extra")):
                if not isinstance(container, dict):
                    continue
                for key in ("design", *sorted(fields)):
                    if key in container:
                        if key == "design" and container[key] is not None:
                            if not isinstance(container[key], dict) or set(container[key]) - fields:
                                raise ValueError(f"Unknown design fields at {path}.design / 设计字段不明确，不能静默移除物理参数")
                        separated[f"{path}.{key}"] = container.pop(key)
            if row.get("extra") == {}:
                row.pop("extra")
    design_inputs = {
        "fields": separated,
        "project": copy.deepcopy(source.get("project", {})),
        "structureSystem": copy.deepcopy(source.get("structure_system")),
        "siteSeismic": copy.deepcopy(source.get("site_seismic", {})),
        "wind": copy.deepcopy(source.get("wind", {})),
        "analysisControl": copy.deepcopy(source.get("analysis_control", {})),
    }
    return {"schema": "sclaw-commercial-projection/v1", "engine": engine,
            "sourceModelHash": content_hash(source), "analysisModelHash": content_hash(analysis),
            "analysisModel": analysis, "designInputs": design_inputs, "inputEvidence": input_evidence, "assumptions": assumptions,
            "designInputsHash": content_hash(design_inputs)}


def build_native_design_context(source: dict, projection: dict, *, native_project: str,
                                parameters: dict, representation: dict | None = None) -> dict:
    """Bind raw native design to its source; never infer suitability from stiffness."""
    request = parameters.get("design") or {}
    if not isinstance(request, dict):
        raise ValueError("design must be an object / 设计请求必须是对象")
    requested = request.get("requested") is True
    gaps = []
    sections = {str(row["id"]): row for row in source.get("sections", [])}
    materials = {str(row["id"]): row for row in source.get("materials", [])}
    for member in source.get("elements", []):
        section = sections.get(str(member.get("section")), {})
        material = materials.get(str(member.get("material")), {})
        # A numerical section has no recoverable design geometry. A named
        # section is only eligible after the engine maps its actual shape.
        if not section.get("shape") and not section.get("standard_steel_name") and not (
                section.get("width") and section.get("height")):
            gaps.append({"field": f"sections.{section.get('id', member.get('section'))}",
                         "reason": "physical-design-geometry-required"})
        if not (material.get("grade") or material.get("name")):
            gaps.append({"field": f"materials.{member.get('material')}.grade",
                         "reason": "native-design-material-identity-required"})
        if request.get("mode") == "check-provided" and material.get("category", material.get("type")) == "concrete":
            reinforcement = (member.get("design") or {}).get("reinforcement") or {}
            if reinforcement.get("confirmed") is not True or not reinforcement.get("values"):
                gaps.append({"field": f"elements.{member['id']}.design.reinforcement",
                             "reason": "confirmed-existing-reinforcement-required"})
    if requested and not request.get("code"):
        gaps.append({"field": "parameters.design.code", "reason": "design-code-and-version-required"})
    if representation and representation.get("analysisOnly"):
        gaps.append({"field": "nativeRepresentation", "reason": "analysis-reference-carrier-not-design-geometry"})
    unique = {(row["field"], row["reason"]): row for row in gaps}
    path = Path(native_project)
    return {"schema": "sclaw-native-design-context/v1", "engine": projection["engine"],
            "sourceModelHash": projection["sourceModelHash"],
            "analysisModelHash": projection["analysisModelHash"],
            "designInputsHash": projection["designInputsHash"],
            "designInputs": projection["designInputs"], "request": copy.deepcopy(request),
            "nativeProject": str(path),
            "nativeProjectSha256": hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None,
            "requestBinding": copy.deepcopy(parameters.get("requestBinding")),
            "representation": copy.deepcopy(representation),
            "status": "not-requested" if not requested else "needs-input" if gaps else "native-design-adaptation-required",
            "missingInputs": list(unique.values()), "eligibleForConclusion": False,
            "boundToSelectedAnalysisResult": False,
            "combinationScope": "software-automatic-design-combinations",
            "message": {"en": "Native design conclusions require mapped design inputs and documented SDK result fields.",
                        "zh": "原生设计结论须具备已映射的设计输入及有文档依据的 SDK 结果字段。"}}


def attach_native_design_context(result: dict, source: dict, projection: dict, *,
                                 native_project: str, parameters: dict, representation: dict | None = None) -> dict:
    result["modelProjection"] = {key: value for key, value in projection.items() if key != "analysisModel"}
    result["assumptions"] = [*result.get("assumptions", []), *projection.get("assumptions", []),
                             *source.get("metadata", {}).get("materialDefaultAssumptions", [])]
    context = build_native_design_context(source, projection, native_project=native_project,
                                         parameters=parameters, representation=representation)
    result["nativeDesignContext"] = context
    if isinstance(result.get("nativeDesignResults"), dict):
        result["nativeDesignResults"]["context"] = context
    return result


def attach_native_result_set(result: dict, model: dict, parameters: dict, select) -> dict:
    """Project requested views of one completed native job; never rerun its solver."""
    selections = parameters.get("_internalResultSelections")
    if selections is None:
        return result
    if not isinstance(selections, list) or not selections:
        raise ValueError("NATIVE_RESULT_SELECTION_INVALID")
    combinations = {str(row["id"]): row for row in model.get("load_combinations", [])}
    cases = {str(row["id"]) for row in model.get("load_cases", [])}
    entries = {}
    for row in selections:
        if not isinstance(row, dict) or row.get("kind") not in ("case", "combination"):
            raise ValueError("NATIVE_RESULT_SELECTION_INVALID")
        key, identity, kind = row.get("key"), row.get("id"), row["kind"]
        if key != f"{kind}:{identity}" or key in entries:
            raise ValueError("NATIVE_RESULT_SELECTION_INVALID")
        if (kind == "case" and identity not in cases) or (kind == "combination" and identity not in combinations):
            raise ValueError("NATIVE_RESULT_SELECTION_NOT_FOUND")
        combo = combinations.get(identity) if kind == "combination" else None
        selected_ids = list(combo["factors"]) if combo else [identity]
        try:
            selected = select(copy.deepcopy(result), selected_ids, combo)
            if selected.get("selectedResult") != {"kind": kind, "id": identity}:
                raise ValueError("NATIVE_RESULT_SELECTION_MISMATCH")
            # All raw cases remain on the primary result; views carry their own
            # signed selected values and the same native project provenance.
            for field in ("caseResults", "envelopeTables", "nativeResultSet"):
                selected.pop(field, None)
            entries[key] = {"success": True, "data": selected}
        except Exception as exc:
            entries[key] = {"success": False, "data": {},
                            "error_code": getattr(exc, "error_code", "NATIVE_RESULT_PROJECTION_FAILED"),
                            "message": str(exc)}
    return {**result, "nativeResultSet": {"schema": "sclaw-native-result-set/v1", "results": entries}}
