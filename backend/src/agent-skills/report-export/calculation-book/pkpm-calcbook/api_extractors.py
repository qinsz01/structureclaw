"""PKPM APIPyInterface extractors — supplementary data from the PKPM Python SDK."""
from __future__ import annotations

import logging
import math
from contextvars import ContextVar
from typing import Any, Dict, List

_logger = logging.getLogger(__name__)
_extraction_issues: ContextVar[list | None] = ContextVar("pkpm_extraction_issues", default=None)


def _issue(method: str, reason: str) -> None:
    issues = _extraction_issues.get()
    if issues is not None:
        issues.append({"source": "APIPyInterface", "method": method, "reason": reason})


def _number(obj: Any, method: str, digits: int) -> float | None:
    value = _safe_call(obj, method)
    if type(value) not in (int, float) or not math.isfinite(value) or value in (-99999, -999999):
        _issue(method, "missing-or-invalid-native-value")
        return None
    return round(value, digits)


def _numbers(obj: Any, method: str, digits: int) -> list | None:
    values = _safe_call(obj, method)
    if not isinstance(values, (list, tuple)) or not values or any(
            type(value) not in (int, float) or not math.isfinite(value) or value in (-99999, -999999)
            for value in values):
        _issue(method, "missing-or-invalid-native-array")
        return None
    return [round(value, digits) for value in values]


def _aggregate(values: list, fn) -> float | None:
    return fn(values) if values and all(value is not None for value in values) else None


# ── Helpers ──────────────────────────────────────────────────────────────


def _safe_call(obj: Any, method: str, default: Any = None, *args: Any) -> Any:
    try:
        return getattr(obj, method)(*args)
    except Exception as exc:
        _logger.debug("APIPyInterface.%s failed: %s", method, exc)
        _issue(method, f"{type(exc).__name__}: {exc}")
        return default


# ── APIPyInterface extractors (supplementary) ───────────────────────────


def _extract_modal(result: Any) -> List[Dict[str, Any]]:
    periods = _safe_call(result, "GetModePeriods", [])
    out: List[Dict[str, Any]] = []
    for p in periods:
        out.append({
            "index": _safe_call(p, "GetIndex"),
            "period_s": _number(p, "GetCycle", 4),
            "angle": _number(p, "GetAngle", 2),
            "damping_ratio": _number(p, "GetDampingRatio", 4),
            "torsion_ratio": _number(p, "GetTorsi", 4),
            "x_side": _number(p, "GetxSide", 4),
            "y_side": _number(p, "GetySide", 4),
        })
    return out


def _extract_story_stiffness(result: Any) -> List[Dict[str, Any]]:
    data = _safe_call(result, "GetStoreyStifs", [])
    out: List[Dict[str, Any]] = []
    for s in data:
        out.append({
            "floor_index": _safe_call(s, "Getfloorindex"),
            "tower_index": _safe_call(s, "GetTowerIndex"),
            "RJX": _number(s, "GetRJX", 2),
            "RJY": _number(s, "GetRJY", 2),
            "ratio_x": _number(s, "GetRatx", 4),
            "ratio_y": _number(s, "GetRaty", 4),
        })
    return out


def _extract_story_drift(result: Any) -> Dict[str, Any]:
    eq_drift = _safe_call(result, "GetStoryDrift_Earthquake", {})
    wind_drift = _safe_call(result, "GetStoryDrift_Wind", {})
    drift_limit = _number(result, "GetAngStoryDriftConsVal", 6)

    def _drift_entries(data: Any) -> Dict[str, List[Dict[str, Any]]]:
        if not isinstance(data, dict):
            return {}
        out: Dict[str, List[Dict[str, Any]]] = {}
        for key, entries in data.items():
            items: List[Dict[str, Any]] = []
            for e in entries:
                items.append({
                    "floor": _safe_call(e, "Getifloor"),
                    "tower": _safe_call(e, "Getitower"),
                    "loadcase": _safe_call(e, "Getiloadcase"),
                    "max_drift": _number(e, "GetmaxD", 4),
                    "min_drift": _number(e, "GetminD", 4),
                    "drift_angle": _number(e, "GetratioA", 6),
                    "inter_max_angle": _number(e, "GetinterMaxA", 6),
                })
            out[key] = items
        return out

    return {
        "earthquake": _drift_entries(eq_drift),
        "wind": _drift_entries(wind_drift),
        "limit_value": drift_limit,
    }


def _extract_base_shear(result: Any) -> Dict[str, Any]:
    data = _safe_call(result, "GetBearingShear", [])
    limit_val = _number(result, "GetRatShearWeightConsVal", 6)
    out: List[Dict[str, Any]] = []
    for s in data:
        out.append({
            "floor": _safe_call(s, "GetFloorNum"),
            "tower": _safe_call(s, "GetTowerNum"),
            "ratio_x": _number(s, "GetRatx", 4),
            "ratio_y": _number(s, "GetRaty", 4),
            "limit_value": _number(s, "GetLimitVal", 4),
        })
    return {"entries": out, "shear_weight_limit": limit_val}


def _extract_story_mass(result: Any) -> List[Dict[str, Any]]:
    data = _safe_call(result, "GetStoreyUnitMass", [])
    out: List[Dict[str, Any]] = []
    for s in data:
        out.append({
            "floor_index": _safe_call(s, "Getfloorindex"),
            "tower_index": _safe_call(s, "GetTowerIndex"),
            "unit_mass": _number(s, "GetUnitMass", 2),
            "area": _number(s, "GetArea", 2),
            "mass_ratio": _number(s, "GetMassRatio", 4),
            "poid_x": _number(s, "GetpoidX", 2),
            "poid_y": _number(s, "GetpoidY", 2),
        })
    return out


def _extract_stiff_weight_ratio(result: Any) -> Dict[str, Any]:
    data = _safe_call(result, "GetStiffWeightRatioFrame", [])
    limit_val = _number(result, "GetRigidWeightRatioConsVal", 6)
    out: List[Dict[str, Any]] = []
    for s in data:
        out.append({
            "floor": _safe_call(s, "Getifloor"),
            "tower": _safe_call(s, "Getitower"),
            "height": _number(s, "GetHeight", 2),
            "stiff_x": _number(s, "GetStiffX", 2),
            "stiff_y": _number(s, "GetStiffY", 2),
            "ratio_x": _number(s, "GetStiffWeightRatioX", 4),
            "ratio_y": _number(s, "GetStiffWeightRatioY", 4),
        })
    return {"entries": out, "limit_value": limit_val}


def _extract_beam_design(result: Any) -> Dict[str, Any]:
    beams_by_floor: Dict[int, List[Dict[str, Any]]] = {}
    shear_values, reinforce_values = [], []
    max_floors = 500
    floor_idx = 1
    while floor_idx <= max_floors:
        beams = _safe_call(result, "GetDesignBeams", [], floor_idx)
        if not beams:
            break
        floor_beams: List[Dict[str, Any]] = []
        for b in beams:
            shear_ratio = _number(b, "GetShearCompressionRatio", 4)
            shear_values.append(shear_ratio)
            reinforce = _number(b, "GetReinForceQuantity", 2)
            reinforce_values.append(reinforce)
            floor_beams.append({
                "pmid": _safe_call(b, "GetPmid"),
                "shear_compression_ratio": shear_ratio,
                "reinforce_quantity": reinforce,
                "concrete_quantity": _number(b, "GetConcreteQuantity", 2),
                "steel_quantity": _number(b, "GetSteelQuantity", 2),
            })
        beams_by_floor[floor_idx] = floor_beams
        floor_idx += 1
    return {
        "floors": beams_by_floor,
        "total_beams": sum(len(v) for v in beams_by_floor.values()),
        "max_shear_compression_ratio": _aggregate(shear_values, max),
        "total_reinforce_quantity": _aggregate(reinforce_values, sum),
        "floors_analyzed": floor_idx - 1,
    }


def _extract_column_design(result: Any) -> Dict[str, Any]:
    columns_by_floor: Dict[int, List[Dict[str, Any]]] = {}
    axial_values, reinforce_values = [], []
    max_floors = 500
    floor_idx = 1
    while floor_idx <= max_floors:
        columns = _safe_call(result, "GetDesignColumns", [], floor_idx)
        if not columns:
            break
        floor_columns: List[Dict[str, Any]] = []
        for c in columns:
            axial_ratios = _numbers(c, "GetAxialCompresRatio", 4)
            axial_max = max(axial_ratios) if axial_ratios else None
            axial_values.append(axial_max)
            reinforce = _number(c, "GetReinForceQuantity", 2)
            reinforce_values.append(reinforce)
            floor_columns.append({
                "pmid": _safe_call(c, "GetPmid"),
                "element_id": _safe_call(c, "GetElementid"),
                "axial_compression_ratio": axial_ratios,
                "max_axial_compression": axial_max,
                "reinforce_quantity": reinforce,
                "concrete_quantity": _number(c, "GetConcreteQuantity", 2),
                "steel_quantity": _number(c, "GetSteelQuantity", 2),
                "slender_ratio": _numbers(c, "GetSlenderRatio", 4),
            })
        columns_by_floor[floor_idx] = floor_columns
        floor_idx += 1
    return {
        "floors": columns_by_floor,
        "total_columns": sum(len(v) for v in columns_by_floor.values()),
        "max_axial_compression_ratio": _aggregate(axial_values, max),
        "total_reinforce_quantity": _aggregate(reinforce_values, sum),
        "floors_analyzed": floor_idx - 1,
    }
