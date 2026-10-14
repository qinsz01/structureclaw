"""Compile authored member weight, independently of native reference carriers.

This is load input translation, not a second structural solver. Native automatic
material weights stay zero; each source member receives its own rho*A*g load in
the explicitly resolved source case. The saved and executed native loads are
audited before any result is published.
"""
from __future__ import annotations

import math
from structure_protocol.self_weight import resolve_self_weight


class SelfWeightCapabilityError(ValueError):
    error_code = "ENGINE_INPUT_UNSUPPORTED"


def compile_self_weight(model: dict) -> dict:
    resolved = resolve_self_weight(model)
    result = {**resolved, "method": "authored-member-density-area-native-line-loads", "members": []}
    if not resolved["enabled"]:
        return result
    if resolved["direction"] not in {"z", "-z"}:
        raise SelfWeightCapabilityError("YJK horizontal gravity needs a native global-direction load mapping / YJK 水平重力尚需原生全局方向荷载映射")
    from yjk_native_materials import section_representation
    nodes = {str(row["id"]): row for row in model["nodes"]}
    materials = {str(row["id"]): row for row in model["materials"]}
    sections = {str(row["id"]): row for row in model["sections"]}
    for member in model["elements"]:
        kind = member.get("type")
        if kind not in {"beam", "column"}:
            raise SelfWeightCapabilityError("YJK member weight requires a mapped native beam/column / 构件自重缺少原生梁柱映射")
        a, b = (nodes[str(node)] for node in member["nodes"])
        length = math.dist([a[k] for k in ("x", "y", "z")], [b[k] for k in ("x", "y", "z")])
        plan_length = math.hypot(b["x"]-a["x"], b["y"]-a["y"])
        if kind == "column" and plan_length != 0:
            raise SelfWeightCapabilityError("YJK inclined-column selfweight needs the native automatic-weight path; external rod loads are removed by the vendor / 斜柱自重须接原生自动自重通道，软件会删除该类外加杆件荷载")
        section = sections[str(member["section"])]
        area = (section.get("properties") or {}).get("A")
        if area is None:
            area = section_representation(section)["baseline"]["A"]
        density = materials[str(member["material"])].get("rho")
        if any(type(v) not in (int, float) or not math.isfinite(v) or v <= 0 for v in (area, density, length)):
            raise ValueError("Member selfweight requires finite positive area, density and length / 构件自重须有有限正值面积、密度与长度")
        intensity = density*area*resolved["vectorMps2"][2]/1000
        factor = length/plan_length if kind == "beam" else 1.
        result["members"].append({"elementId": str(member["id"]), "materialId": str(member["material"]),
            "sectionId": str(member["section"]), "densityKgM3": density, "areaM2": area,
            "lengthM": length, "intensityKnM": intensity, "intensityVectorKnM": [0., 0., intensity],
            "totalForceKn": intensity*length, "totalForceVectorKn": [0., 0., intensity*length],
            "elementKind": 12 if kind == "beam" else 11,
            "actualToPlanLengthFactor": factor})
    return result
