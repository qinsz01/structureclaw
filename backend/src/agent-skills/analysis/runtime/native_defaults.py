"""Explicit, recorded defaults for native elastic projections (never authored data)."""
from structure_protocol.material_defaults import apply_grade_defaults

CONTROLS = ("self_weight", "rigid_offsets", "construction_stage", "p_delta")


def apply_native_defaults(model, engine):
    assumptions = []
    controls = model.setdefault("analysis_control", {})
    for key in CONTROLS + ("rigid_floor",):
        # Story declarations are resolved by each adapter, including conflicts.
        if key == "rigid_floor" and any(s.get("rigid_diaphragm") is not None for s in model.get("stories", [])):
            continue
        if controls.get(key) is None:
            controls[key] = False
            assumptions.append({"field": "analysis_control." + key, "value": False,
                "reason": {"en": "Omitted control defaults to off.", "zh": "未指定的控制项默认为关闭。"}})
    if engine != "pkpm":
        return assumptions
    assumptions.extend(apply_grade_defaults(model.get("materials", [])))
    return assumptions
