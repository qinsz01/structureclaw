"""Pushover input helpers: record access, member plastic-hinge definitions, convergence settings.

Split verbatim from ``pushover.py``, which re-exports these names.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple
from modal import _element_type, _is_opensees_line_element_type
from seismic_contracts import optional_number


def _field(record: Any, key: str, default: Any = None) -> Any:
    if isinstance(record, dict):
        return record.get(key, default)
    return getattr(record, key, default)


def _records(payload: Dict[str, Any], model: Any, key: str) -> List[Any]:
    value = payload.get(key)
    if isinstance(value, list):
        return value
    return list(getattr(model, key, []) or [])


def _performance_objective(parameters: Dict[str, Any]) -> Dict[str, Any]:
    value = parameters.get("performanceObjective")
    return value if isinstance(value, dict) else {}


def _as_record(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _first_string(*values: Any) -> Optional[str]:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
    return None


def _first_number(*values: Any) -> Optional[float]:
    for value in values:
        number = optional_number(value)
        if number is not None:
            return number
    return None


def _looks_like_hinge_record(value: Dict[str, Any]) -> bool:
    return any(key in value for key in (
        "elementId",
        "memberId",
        "element",
        "member",
        "end",
        "nodeEnd",
        "position",
        "yieldMoment",
        "yieldMomentKNm",
        "momentYield",
        "My",
        "positiveYieldMoment",
        "yieldRotation",
        "rotationYield",
        "thetaY",
        "positiveYieldRotation",
        "backbone",
        "momentRotation",
        "momentRotationBackbone",
        "rotationBackbone",
    ))


def _structured_entries(section: Dict[str, Any], *keys: str) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    for key in keys:
        value = section.get(key)
        if isinstance(value, list):
            entries.extend([item for item in value if isinstance(item, dict)])
            continue
        if not isinstance(value, dict):
            continue
        if _looks_like_hinge_record(value):
            entries.append(value)
            continue
        for outer_key, item in value.items():
            if not isinstance(item, dict):
                continue
            if _looks_like_hinge_record(item):
                entry = {**item}
                if _first_string(entry.get("elementId"), entry.get("memberId"), entry.get("element"), entry.get("member")) is None:
                    entry["elementId"] = str(outer_key)
                entries.append(entry)
                continue
            for nested_key, nested_item in item.items():
                if not isinstance(nested_item, dict):
                    continue
                entry = {**nested_item}
                if _first_string(entry.get("elementId"), entry.get("memberId"), entry.get("element"), entry.get("member")) is None:
                    entry["elementId"] = str(outer_key)
                if _first_string(entry.get("end"), entry.get("nodeEnd"), entry.get("position")) is None:
                    entry["end"] = str(nested_key)
                entries.append(entry)
    return entries


def _hinge_ends(entry: Dict[str, Any]) -> List[str]:
    raw = entry.get("end")
    if raw is None:
        raw = entry.get("nodeEnd")
    if raw is None:
        raw = entry.get("position")
    if isinstance(raw, list):
        ends: List[str] = []
        for item in raw:
            ends.extend(_hinge_ends({"end": item}))
        return list(dict.fromkeys(ends))
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return ["i"] if int(raw) == 0 else ["j"] if int(raw) == 1 else []
    value = str(raw or "").strip().lower()
    if value in {"i", "i-end", "i_end", "start", "start-node", "start_node", "near"}:
        return ["i"]
    if value in {"j", "j-end", "j_end", "end", "end-node", "end_node", "far"}:
        return ["j"]
    if value in {"both", "ij", "i+j", "i-j"}:
        return ["i", "j"]
    return []


def _backbone_yield_point(entry: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    candidates: List[Any] = []
    for key in ("backbone", "momentRotation", "momentRotationBackbone", "rotationBackbone"):
        value = entry.get(key)
        if isinstance(value, dict):
            for nested_key in ("positive", "points", "values", "envelope"):
                nested = value.get(nested_key)
                if nested is not None:
                    candidates.append(nested)
        if value is not None:
            candidates.append(value)
    for candidate in candidates:
        points = candidate if isinstance(candidate, list) else []
        for point in points:
            if isinstance(point, (list, tuple)) and len(point) >= 2:
                rotation = optional_number(point[0])
                moment = optional_number(point[1])
            elif isinstance(point, dict):
                rotation = _first_number(
                    point.get("rotation"),
                    point.get("theta"),
                    point.get("yieldRotation"),
                    point.get("deformation"),
                )
                moment = _first_number(
                    point.get("moment"),
                    point.get("momentKNm"),
                    point.get("yieldMoment"),
                    point.get("force"),
                )
            else:
                continue
            if rotation is not None and moment is not None:
                return float(moment), abs(float(rotation))
    return None, None


def _member_plastic_hinge_definitions(
    parameters: Dict[str, Any],
    elements: Sequence[Any],
) -> Tuple[List[Dict[str, Any]], List[str]]:
    nonlinear_model = _as_record(parameters.get("nonlinearModel"))
    entries = _structured_entries(
        nonlinear_model,
        "memberPlasticHinges",
        "plasticHinges",
        "memberHinges",
        "hinges",
    )
    if not entries:
        return [], ["nonlinearModel.memberPlasticHinges"]

    line_element_ids = {
        str(_field(element, "id"))
        for element in elements
        if _is_opensees_line_element_type(_element_type(element))
    }
    missing: List[str] = []
    hinges: List[Dict[str, Any]] = []
    seen: set[Tuple[str, str]] = set()
    default_post_yield_ratio = _first_number(
        nonlinear_model.get("postYieldStiffnessRatio"),
        nonlinear_model.get("hardeningRatio"),
        parameters.get("postYieldStiffnessRatio"),
        parameters.get("hardeningRatio"),
    )
    for entry in entries:
        element_id = _first_string(
            entry.get("elementId"),
            entry.get("memberId"),
            entry.get("element"),
            entry.get("member"),
        )
        if not element_id or element_id not in line_element_ids:
            missing.append("nonlinearModel.memberPlasticHinges.elementId")
            continue
        ends = _hinge_ends(entry)
        if not ends:
            missing.append("nonlinearModel.memberPlasticHinges.end")
            continue
        backbone_moment, backbone_rotation = _backbone_yield_point(entry)
        yield_moment = _first_number(
            entry.get("yieldMoment"),
            entry.get("yieldMomentKNm"),
            entry.get("momentYield"),
            entry.get("My"),
            entry.get("positiveYieldMoment"),
            backbone_moment,
        )
        yield_rotation = _first_number(
            entry.get("yieldRotation"),
            entry.get("rotationYield"),
            entry.get("thetaY"),
            entry.get("positiveYieldRotation"),
            backbone_rotation,
        )
        if yield_moment is None or yield_rotation is None or abs(float(yield_moment)) <= 0.0 or abs(float(yield_rotation)) <= 0.0:
            missing.append("nonlinearModel.memberPlasticHingeBackboneCalibration")
            continue
        post_yield_ratio = _first_number(
            entry.get("postYieldStiffnessRatio"),
            entry.get("hardeningRatio"),
            entry.get("b"),
            default_post_yield_ratio,
            0.03,
        )
        for end in ends:
            identity = (element_id, end)
            if identity in seen:
                continue
            seen.add(identity)
            hinges.append({
                "elementId": element_id,
                "end": end,
                "yieldMomentKNm": abs(float(yield_moment)),
                "yieldRotationRad": abs(float(yield_rotation)),
                "postYieldStiffnessRatio": max(float(post_yield_ratio or 0.0), 0.0),
            })
    return hinges, list(dict.fromkeys(missing))


def _convergence_settings(parameters: Dict[str, Any]) -> Dict[str, Any]:
    nonlinear_model = _as_record(parameters.get("nonlinearModel"))
    convergence = _as_record(parameters.get("convergenceCriteria")) or _as_record(nonlinear_model.get("convergenceCriteria"))
    test_name = _first_string(convergence.get("test"), convergence.get("testType")) or "NormDispIncr"
    if test_name not in {"NormDispIncr", "NormUnbalance", "EnergyIncr", "RelativeNormDispIncr"}:
        test_name = "NormDispIncr"
    tolerance = _first_number(convergence.get("tolerance"), convergence.get("tol")) or 1.0e-8
    max_iterations = int(_first_number(convergence.get("maxIterations"), convergence.get("iterations")) or 25)
    return {
        "test": test_name,
        "tolerance": max(float(tolerance), 1.0e-12),
        "maxIterations": max(1, min(max_iterations, 200)),
    }
