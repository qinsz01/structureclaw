"""Grade defaults shared by model input and native projections."""
from .design_code_tables import CONCRETE_GRADES, normalize_steel_grade


def apply_grade_defaults(materials):
    assumptions = []
    for material in materials:
        grade = str(material.get("grade") or material.get("name") or "").strip().upper()
        if grade in CONCRETE_GRADES:
            defaults = {"E": CONCRETE_GRADES[grade]["Ec"], "nu": .2, "rho": 2500.}
        elif normalize_steel_grade(grade):
            defaults = {"E": 206000., "nu": .3, "rho": 7850.}
        else:
            continue
        for key, value in defaults.items():
            if key not in material:
                material[key] = value
                assumptions.append({"field": f"materials.{material['id']}.{key}", "value": value,
                    "grade": grade, "units": {"E": "MPa", "rho": "kg/m3", "nu": "1"}[key],
                    "reason": {"en": "Grade elastic default; explicit properties take precedence.",
                               "zh": "牌号弹性默认值；显式材料属性优先。"}})
    return assumptions
