"""Explicit, recorded defaults for native elastic projections (never authored data)."""
from structure_protocol.design_code_tables import CONCRETE_GRADES, normalize_steel_grade

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
    for material in model.get("materials", []):
        grade = str(material.get("grade") or material.get("name") or "").strip().upper()
        if grade in CONCRETE_GRADES:
            defaults = {"E": CONCRETE_GRADES[grade]["Ec"], "nu": .2, "rho": 2500.}
        elif normalize_steel_grade(grade):
            defaults = {"E": 206000., "nu": .3, "rho": 7850.}
        else:
            continue  # Unknown grades still pass through the capability validation.
        for key, value in defaults.items():
            if material.get(key) is None:
                material[key] = value
                assumptions.append({"field": f"materials.{material['id']}.{key}", "value": value,
                    "grade": grade, "units": {"E": "MPa", "rho": "kg/m3", "nu": "1"}[key],
                    "reason": {"en": "Grade elastic default; explicit properties take precedence.",
                               "zh": "牌号弹性默认值；显式材料属性优先。"}})
    return assumptions
