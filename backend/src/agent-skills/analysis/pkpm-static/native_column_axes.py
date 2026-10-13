"""Compile orthogonal physical column axes without native angle rounding."""
from __future__ import annotations

from coordinate_semantics import build_element_local_axes, get_reference_vector
from native_model_contract import pkpm_section_shape


def column_axis_plan(model, element):
    if element["type"] != "column":
        return None
    sections = {str(row["id"]): row for row in model["sections"]}
    shape = pkpm_section_shape(sections[str(element["section"])], str(model.get("schema_version", "2.0.0")))
    if not shape or shape["kind"] != "Rectangle":
        raise ValueError("Calibrated column axes require rectangular sections / 已校准柱截面轴映射仅适用矩形")
    nodes = {str(row["id"]): row for row in model["nodes"]}
    points = [[nodes[str(key)][axis] for axis in ("x", "y", "z")] for key in element["nodes"]]
    axes = build_element_local_axes(*points, get_reference_vector(model.get("metadata", {}), str(element["id"])),
                                    float(element.get("rotation_angle") or 0)).tolist()
    depth_axis = axes[2]
    along_x = abs(abs(depth_axis[0]) - 1) < 1e-10 and abs(depth_axis[1]) < 1e-10 and abs(depth_axis[2]) < 1e-10
    along_y = abs(abs(depth_axis[1]) - 1) < 1e-10 and abs(depth_axis[0]) < 1e-10 and abs(depth_axis[2]) < 1e-10
    if not along_x and not along_y:
        raise ValueError("Column section axes must align with global X/Y / 柱截面轴须与全局X/Y正交对齐")
    # Native unrotated B/H are global X/Y, whereas canonical H is local Z.
    return {"kind": "orthogonal-column-section-permutation", "sourceLocalAxes": axes,
            "sourceSectionId": str(element["section"]), "swapBH": along_x,
            "sourceDimensionsMm": {"B": shape["B"], "H": shape["H"]},
            "nativeDimensionsMm": {"B": shape["H"] if along_x else shape["B"],
                                   "H": shape["B"] if along_x else shape["H"]},
            "nativeAngleDegrees": 0.}
