"""Shared regularity helpers: severity ordering, payload/story access, explicit classification.

Split verbatim from ``regularity.py``, which re-exports these names.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence
from seismic_contracts import as_record, optional_number


SEVERITY_ORDER = {
    "regular": 0,
    "unknown": 0,
    "irregular": 1,
    "particularly_irregular": 2,
}
G_ACCEL = 9.80665


def _model_payload(model: Any) -> Dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(mode="python")
    return model if isinstance(model, dict) else {}


def _severity_max(left: str, right: str) -> str:
    return left if SEVERITY_ORDER.get(left, 0) >= SEVERITY_ORDER.get(right, 0) else right


def _classification_from_explicit(value: Any) -> Optional[str]:
    text = str(value or "").strip().lower()
    if not text:
        return None
    if text in {"regular", "规则", "regularity_regular"}:
        return "regular"
    if text in {"irregular", "不规则", "general_irregular", "一般不规则"}:
        return "irregular"
    if text in {"particularly_irregular", "special_irregular", "severe", "serious", "特别不规则", "严重不规则"}:
        return "particularly_irregular"
    return None


def _is_true(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.strip().lower() in {"true", "yes", "1"})


def _stories(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = payload.get("stories")
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def _records_by_id(payload: Dict[str, Any], key: str) -> Dict[str, Dict[str, Any]]:
    raw = payload.get(key)
    records = [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []
    return {
        str(item.get("id")).strip(): item
        for item in records
        if str(item.get("id") or "").strip()
    }


def _section_inertia(section: Dict[str, Any]) -> Optional[float]:
    properties = as_record(section.get("properties"))
    values: List[float] = []
    for source in (properties, section):
        for key in ("I", "Ix", "Iy", "Iz"):
            value = optional_number(source.get(key))
            if value is not None and value > 0.0:
                values.append(value)
    if values:
        return max(values)

    shape = as_record(section.get("shape"))
    width_mm = optional_number(section.get("width")) or optional_number(shape.get("B"))
    height_mm = optional_number(section.get("height")) or optional_number(shape.get("H"))
    if width_mm is None or height_mm is None or width_mm <= 0.0 or height_mm <= 0.0:
        return None
    width_m = width_mm / 1000.0
    height_m = height_mm / 1000.0
    return max(width_m * height_m ** 3 / 12.0, height_m * width_m ** 3 / 12.0)


def _material_elastic_modulus(material: Dict[str, Any]) -> Optional[float]:
    value = optional_number(material.get("E")) or optional_number(material.get("elasticModulus"))
    if value is not None and value > 0.0:
        return value
    extra = as_record(material.get("extra"))
    value = optional_number(extra.get("E")) or optional_number(extra.get("elasticModulus"))
    return value if value is not None and value > 0.0 else None


def _node_value(node: Dict[str, Any], key: str) -> Optional[float]:
    return optional_number(node.get(key))


def _node_story_key(node: Dict[str, Any]) -> Optional[str]:
    if isinstance(node.get("story"), str) and str(node.get("story")).strip():
        return str(node.get("story")).strip()
    z = _node_value(node, "z")
    if z is not None and z > 0.0:
        return f"z={round(z, 4)}"
    return None


def _bbox_area(nodes: Sequence[Dict[str, Any]]) -> Optional[float]:
    xs = [_node_value(node, "x") for node in nodes]
    ys = [_node_value(node, "y") for node in nodes]
    x_values = [value for value in xs if value is not None]
    y_values = [value for value in ys if value is not None]
    if len(x_values) < 2 or len(y_values) < 2:
        return None
    width = max(x_values) - min(x_values)
    depth = max(y_values) - min(y_values)
    if width <= 0.0 or depth <= 0.0:
        return None
    return width * depth


def _story_nodes_by_key(payload: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    raw_nodes = payload.get("nodes")
    nodes = [node for node in raw_nodes if isinstance(node, dict)] if isinstance(raw_nodes, list) else []
    by_story: Dict[str, List[Dict[str, Any]]] = {}
    for node in nodes:
        key = _node_story_key(node)
        if key:
            by_story.setdefault(key, []).append(node)
    return by_story
