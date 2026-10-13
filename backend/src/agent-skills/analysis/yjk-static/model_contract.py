"""SDK-independent validation for the native YJK floor compiler."""
from __future__ import annotations
import math
from native_story_geometry import compile_story_geometry, exact_mm

def validate_execution_settings(data: dict) -> None:
    from yjk_native_settings import compile_settings
    compile_settings(data)

def _validate_story_derived_loads(data: dict, *, native_load_precision: bool = True) -> None:
    from native_model_contract import validate_story_load_totals
    validate_story_load_totals(data, "YJK")
    from yjk_native_loads import compile_load_definitions
    compile_load_definitions(data, native_precision=native_load_precision)


def validate_building_model(model_dict: dict, *, native_load_precision: bool = True) -> None:
    """Validate the physical subset supported by per-floor native compilation."""
    validate_execution_settings(model_dict)
    nodes = [node for node in model_dict.get("nodes", []) if isinstance(node, dict)]
    elements = [element for element in model_dict.get("elements", []) if isinstance(element, dict)]
    if not nodes or not elements:
        raise ValueError("YJK conversion requires non-empty nodes and elements")

    _validate_story_derived_loads(model_dict, native_load_precision=native_load_precision)

    def coordinate(node: dict) -> tuple[int, int, int]:
        node_id = str(node.get("id"))
        return (
            exact_mm(node.get("x"), f"Node '{node_id}' global X"),
            exact_mm(node.get("y"), f"Node '{node_id}' global Y"),
            exact_mm(node.get("z"), f"Node '{node_id}' global Z"),
        )

    positions = {str(node.get("id")): coordinate(node) for node in nodes}
    if len(positions) != len(nodes):
        raise ValueError("YJK conversion requires unique node ids")
    if len(set(positions.values())) != len(nodes):
        raise ValueError("YJK conversion cannot preserve multiple nodes at the same millimetre coordinate")
    xs = sorted({position[0] for position in positions.values()})
    ys = sorted({position[1] for position in positions.values()})
    zs = sorted({position[2] for position in positions.values()})
    if len(xs) < 2 or len(ys) < 2 or len(zs) < 2:
        raise ValueError("YJK conversion requires a genuine 3-D building grid")
    if zs[0] != 0:
        raise ValueError("YJK building conversion requires the base at global Z=0")

    compile_story_geometry(model_dict)
    stories = sorted(model_dict["stories"], key=lambda story: exact_mm(story["elevation"], "Story elevation"))
    for story in stories:
        story_id = str(story.get("id"))
        floor_loads = story.get("floor_loads", [])
        if not isinstance(floor_loads, list):
            raise ValueError(f"Story '{story_id}' floor_loads must be an array")
        seen_load_types: set[str] = set()
        for floor_load in floor_loads:
            if not isinstance(floor_load, dict):
                raise ValueError(f"Story '{story_id}' contains an invalid floor load")
            load_type = str(floor_load.get("type", ""))
            value = float(floor_load.get("value", 0.0))
            if not math.isfinite(value):
                raise ValueError(f"Story '{story_id}' contains a non-finite floor load")
            if load_type not in {"dead", "live"} and abs(value) > 1e-12:
                raise ValueError(
                    f"YJK floor conversion cannot preserve story load type '{load_type}' on '{story_id}'"
                )
            if load_type in seen_load_types:
                raise ValueError(f"Story '{story_id}' contains duplicate '{load_type}' floor loads")
            seen_load_types.add(load_type)
        for field in ("dead_load", "live_load"):
            if story.get(field) is None:
                continue
            value = float(story[field])
            if not math.isfinite(value):
                raise ValueError(f"Story '{story_id}' contains a non-finite {field}")

    base_z = zs[0]
    for node in nodes:
        restraints = node.get("restraints")
        position = positions[str(node.get("id"))]
        values = tuple(bool(value) for value in restraints) if isinstance(restraints, list) else (False,) * 6
        expected = (True,) * 6 if position[2] == base_z else (False,) * 6
        if values != expected:
            raise ValueError(
                f"YJK floor support mapping cannot preserve restraints for node '{node.get('id')}'"
            )

    actual_edges: set[tuple[tuple[float, float, float], tuple[float, float, float]]] = set()
    role_sections: dict[str, set[str]] = {"beam": set(), "column": set()}
    section_ids = {str(section.get("id")) for section in model_dict.get("sections", []) if isinstance(section, dict)}
    materials = {
        str(material.get("id")): material
        for material in model_dict.get("materials", [])
        if isinstance(material, dict)
    }
    for element in elements:
        element_type = str(element.get("type", "")).lower()
        if element_type not in {"beam", "column"}:
            raise ValueError(f"YJK floor conversion does not preserve element type '{element_type}'")
        node_ids = element.get("nodes", [])
        if not isinstance(node_ids, list) or len(node_ids) != 2:
            raise ValueError(f"YJK floor conversion requires two-node members; element '{element.get('id')}' is invalid")
        try:
            start = positions[str(node_ids[0])]
            end = positions[str(node_ids[1])]
        except KeyError as error:
            raise ValueError(f"Element '{element.get('id')}' references an unknown node") from error
        if element_type == "column" and start[2] == end[2]:
            raise ValueError(f"Element '{element.get('id')}' column has no height")
        if element_type == "column" and start[2] >= end[2]:
            raise ValueError(
                f"Column '{element.get('id')}' must be ordered from lower global Z to upper global Z"
            )
        if element_type == "beam" and start[:2] == end[:2]:
            raise ValueError(f"YJK beam '{element.get('id')}' must have a nonzero horizontal span")
        if element_type == "column":
            inclination = math.degrees(math.atan2(math.hypot(end[0]-start[0], end[1]-start[1]), end[2]-start[2]))
            if inclination >= 20:
                raise ValueError(f"YJK ordinary column '{element.get('id')}' exceeds the calibrated native column inclination (<20 degrees)")
        if element_type == "beam" and start[2] == 0:
            raise ValueError(f"YJK beam '{element.get('id')}' cannot be assigned below the first floor")
        rotation = float(element.get("rotation_angle", 0.0) or 0.0)
        if not math.isfinite(rotation):
            raise ValueError(f"YJK member '{element.get('id')}' rotation_angle must be finite")
        if abs(rotation) > 1e-12 and not materials.get(str(element.get("material")), {}).get("E"):
            raise ValueError(f"YJK explicit rotation on '{element.get('id')}' requires an audited elastic model")
        if element.get("offsets"):
            raise ValueError(f"YJK floor conversion cannot preserve end offsets on '{element.get('id')}'")
        if element.get("releases"):
            raise ValueError(f"YJK floor conversion cannot preserve end releases on '{element.get('id')}'")
        actual_edges.add(tuple(sorted((start, end))))
        section_id = str(element.get("section", ""))
        material_id = str(element.get("material", ""))
        if section_id not in section_ids:
            raise ValueError(f"Element '{element.get('id')}' references an unavailable section")
        if material_id not in materials:
            raise ValueError(f"Element '{element.get('id')}' references an unavailable material")
        if materials[material_id].get("category") not in {"steel", "concrete"}:
            raise ValueError(
                f"Material '{material_id}' must explicitly declare category='steel' or 'concrete' for YJK"
            )
        role_sections[element_type].add(section_id)

    if len(actual_edges) != len(elements):
        raise ValueError("YJK cannot preserve duplicate members at the same endpoints")
    if role_sections["beam"] & role_sections["column"]:
        raise ValueError("YJK requires distinct section ids for beams and columns at this API level")


