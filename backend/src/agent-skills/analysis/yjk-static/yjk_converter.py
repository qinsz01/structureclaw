# -*- coding: utf-8 -*-
"""V2 StructureModelV2 JSON -> YJK .ydb via YJKAPI DataFunc.

Runs under YJK's bundled Python 3.10.  Imported by yjk_driver.py.

Supported section kinds (YJK 8.0 API):
  Basic geometry:
    kind=1  矩形        ShapeVal "B,H"
    kind=2  工字形/H形   ShapeVal "tw,H,B,tf1,B2,tf2" (6 params)
    kind=3  圆形        ShapeVal "D"
    kind=4  正多边形     ShapeVal (per YJK docs)
    kind=5  槽形        ShapeVal (per YJK docs)
    kind=6  十字形       ShapeVal (per YJK docs)
    kind=7  箱型        ShapeVal "B,H,U,T,D,F" (6 params; equal-thickness: B,H,t,t,t,t)
    kind=8  圆管        ShapeVal "D,d" (outer, inner) or "D,t" (outer, wall)
    kind=9  双槽形       ShapeVal (per YJK docs)
    kind=10 十字工       ShapeVal (per YJK docs)
    kind=11 梯形        ShapeVal (per YJK docs)
    kind=28 L形         ShapeVal (per YJK docs)
    kind=29 T形         ShapeVal (per YJK docs)
  Composite / SRC:
    kind=12 钢管混凝土   kind=13 工字劲   kind=14 箱形劲
    kind=-14 方管混凝土  kind=15 十字劲
    kind=24 带盖板钢组合  kind=25 组合截面
  Tapered:
    kind=21 矩形变截面   kind=22 H形变截面  kind=23 箱形变截面
    kind=33 正多边形变截面 kind=52 工字劲变截面
  Library:
    kind=26 型钢 (热轧库截面, ShapeVal="", name=规格名)
    kind=303 薄壁型钢    kind=304 薄壁型钢组合  kind=306 铝合金梁

Unit conventions:
  V2 JSON coordinates: meters   -> YJK: mm  (multiply by 1000)
  V2 section dims:     mm       -> YJK: mm  (pass through)
  V2 floor heights:    meters   -> YJK: mm  (multiply by 1000)
  V2 floor loads:      kN/m2    -> YJK: kN/m2 (pass through)
"""
from __future__ import annotations

import os
import copy
import json
import math
import re
from typing import Any

from YJKAPI import BzcPara, DataFunc, Hi_AddToAndReadYjk
from model_contract import validate_building_model

M_TO_MM = 1000.0
CANONICAL_DOF_ORDER = ["ux", "uy", "uz", "rx", "ry", "rz"]


def _require_canonical_3d_coordinate_contract(data: dict[str, Any]) -> dict[str, Any]:
    coordinate_system = data.get("coordinate_system")
    if not isinstance(coordinate_system, dict):
        raise ValueError("YJK conversion requires the typed coordinate_system contract")
    if (
        coordinate_system.get("semantics") != "global-z-up"
        or coordinate_system.get("version") != 1
        or coordinate_system.get("dimension") != "3d"
        or coordinate_system.get("plane") is not None
        or coordinate_system.get("dof_order") != CANONICAL_DOF_ORDER
    ):
        raise ValueError("YJK conversion requires the complete canonical global-z-up 3-D coordinate contract")
    return coordinate_system


def _metres_to_exact_mm(value: Any, label: str) -> int:
    try:
        millimetres = float(value) * M_TO_MM
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be a finite value in metres") from error
    rounded = round(millimetres)
    if not math.isfinite(millimetres) or abs(millimetres - rounded) > 1e-6:
        raise ValueError(f"{label} is not exactly representable in integer millimetres")
    return int(rounded)

# material category -> YJK mat type
_CATEGORY_TO_MAT: dict[str, int] = {
    "steel": 5,
    "concrete": 6,
    "rebar": 6,
    "other": 6,
}

# V2 section type string -> YJK section kind integer
# Reference: YJK 8.0 建模接口说明 + 案例/二次开发
_TYPE_TO_KIND: dict[str, int] = {
    # --- 基本型钢 / 几何截面 ---
    "rectangular": 1,   # 矩形          ShapeVal "B,H"
    "I": 2,             # 工字形         ShapeVal "tw,H,B,tf1,B2,tf2"
    "H": 2,             # H形 (同工字形)
    "circular": 3,      # 圆形          ShapeVal "D"
    "polygon": 4,       # 正多边形
    "channel": 5,       # 槽形
    "cross": 6,         # 十字形
    "box": 7,           # 箱型          ShapeVal "B,H,U,T,D,F" (等厚: B,H,t,t,t,t)
    "tube": 8,          # 圆管          ShapeVal "D,d"
    "pipe": 8,          # V2 alias for circular hollow section
    "hollow-circular": 8,  # V2 alias for circular hollow section
    "double-channel": 9,  # 双槽形
    "cross-I": 10,      # 十字工
    "trapezoid": 11,    # 梯形
    "L": 28,            # L形 (角钢)
    "T": 29,            # T形
    # --- 组合 / 劲性 / 钢管混凝土 ---
    "CFT": 12,          # 钢管混凝土
    "SRC-I": 13,        # 工字劲
    "SRC-box": 14,      # 箱形劲
    "CFT-square": -14,  # 方管混凝土
    "SRC-cross": 15,    # 十字劲
    "steel-cap": 24,    # 带盖板钢组合截面
    "composite": 25,    # 组合截面
    # --- 变截面 ---
    "tapered-rect": 21,     # 矩形变截面
    "tapered-H": 22,        # H形变截面
    "tapered-box": 23,      # 箱形变截面
    "tapered-polygon": 33,  # 正多边形变截面
    "tapered-SRC-I": 52,    # 工字劲变截面
    # --- 型钢库 / 薄壁 / 铝合金 ---
    "standard": 26,     # 型钢 (热轧库截面, ShapeVal="", name=规格名)
    "cold-formed": 303, # 薄壁型钢
    "cold-formed-composite": 304,  # 薄壁型钢组合
    "aluminum": 306,    # 铝合金梁截面
}


def _get_floor_loads(story: dict) -> tuple[float, float]:
    """Extract dead and live load values from a V2 story dict."""
    dead = 0.0
    live = 0.0
    for fl in story.get("floor_loads", []):
        if fl.get("type") == "dead":
            dead = float(fl["value"])
        elif fl.get("type") == "live":
            live = float(fl["value"])
    if story.get("dead_load") is not None:
        dead = float(story["dead_load"])
    if story.get("live_load") is not None:
        live = float(story["live_load"])
    return dead, live


def _infer_section_roles(data: dict) -> dict[str, str]:
    """Build {section_id: "column"|"beam"} by scanning element types."""
    roles: dict[str, str] = {}
    for elem in data.get("elements", []):
        sec_id = elem.get("section", "")
        etype = elem.get("type", "beam")
        if etype not in {"beam", "column"}:
            raise ValueError(f"YJK grid conversion does not support element type '{etype}'")
        prior = roles.get(sec_id)
        if prior is not None and prior != etype:
            raise ValueError(f"Section '{sec_id}' is shared by beams and columns and cannot be preserved")
        roles[sec_id] = etype
    return roles


def _resolve_mat_type(sec: dict, data: dict) -> int:
    """Determine YJK material type integer for a section."""
    mat_map: dict[str, dict] = {m["id"]: m for m in data.get("materials", [])}
    native_types: set[int] = set()
    for elem in data.get("elements", []):
        if elem.get("section") == sec["id"]:
            mat = mat_map.get(elem.get("material", ""))
            if mat:
                cat = mat.get("category")
                if cat not in _CATEGORY_TO_MAT:
                    raise ValueError(
                        f"Material '{mat.get('id')}' must declare a supported category for YJK conversion"
                    )
                native_types.add(_CATEGORY_TO_MAT[cat])
    if not native_types:
        raise ValueError(f"Section '{sec.get('id')}' is not referenced by a material-backed element")
    if len(native_types) != 1:
        raise ValueError(f"Section '{sec.get('id')}' requires separate native definitions for different material categories")
    native_type = native_types.pop()
    declared = sec.get("properties", {}).get("mat")
    if declared is not None and int(declared) != native_type:
        raise ValueError(f"Section '{sec.get('id')}' native material type conflicts with its element materials")
    return native_type


def _positive_dimension(value: Any, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be a finite positive dimension in millimetres") from error
    if not math.isfinite(number) or number <= 0.0:
        raise ValueError(f"{label} must be a finite positive dimension in millimetres")
    return number


def _dimension_text(value: Any, label: str) -> str:
    number = _positive_dimension(value, label)
    return str(int(number)) if number.is_integer() else format(number, ".12g")


# --- Precise H-section lookup table (GB/T 11263 hot-rolled H-beams) ---
# (H, B, tw, tf) in mm.
_H_SECTION_DIMS: dict[str, tuple[int, int, int, int]] = {
    # HW 宽翼缘 (H≈B)
    "HW100X100": (100, 100, 6, 8),
    "HW125X125": (125, 125, 6, 9),
    "HW150X150": (150, 150, 7, 10),
    "HW175X175": (175, 175, 7, 11),
    "HW200X200": (200, 200, 8, 12),
    "HW250X250": (250, 250, 9, 14),
    "HW300X300": (300, 300, 10, 15),
    "HW350X350": (350, 350, 12, 19),
    "HW400X400": (400, 400, 13, 21),
    # HN 窄翼缘
    "HN150X75":  (150, 75, 5, 7),
    "HN200X100": (200, 100, 5, 8),
    "HN250X125": (250, 125, 6, 9),
    "HN300X150": (300, 150, 6, 9),
    "HN350X175": (350, 175, 7, 11),
    "HN400X200": (400, 200, 8, 13),
    "HN450X200": (450, 200, 9, 14),
    "HN500X200": (500, 200, 10, 16),
    "HN600X200": (600, 200, 11, 17),
    "HN700X300": (700, 300, 13, 24),
    "HN800X300": (800, 300, 14, 26),
    "HN900X300": (900, 300, 16, 28),
    # HM 中翼缘
    "HM200X150": (200, 150, 6, 9),
    "HM250X175": (250, 175, 7, 11),
    "HM300X200": (300, 200, 8, 12),
    "HM350X250": (350, 250, 9, 14),
    "HM400X300": (400, 300, 10, 16),
    "HM450X300": (450, 300, 11, 18),
    "HM500X300": (500, 300, 11, 15),
    "HM600X300": (600, 300, 12, 17),
}


def _build_shape_val(sec: dict, kind: int) -> tuple[int, str, str]:
    """Return (kind, ShapeVal, name) for a V2 section dict.

    Priority:
      1. standard_steel_name -> lookup in _H_SECTION_DIMS for exact geometry,
         fallback to kind=26 library name
      2. properties with detailed geometry -> build ShapeVal per kind
      3. top-level width/height -> rectangular fallback (kind=1)

    ShapeVal formats (YJK 8.0, verified from SDK examples):
      kind=1  矩形:     "B,H"
      kind=2  工字形:    "tw,H,B,tf1,B2,tf2"
      kind=3  圆形:     "D"
      kind=7  箱型:     "B,H,U,T,D,F" (等厚时 "B,H,t,t,t,t")
      kind=8  圆管:     "D,d" (外径,内径)
      kind=26 型钢库:   ShapeVal="", name=规格名
    """
    props = sec.get("properties", {})
    extra = sec.get("extra", {})

    std_name = (
        sec.get("standard_steel_name")       # V2 canonical top-level field
        or props.get("standard_steel_name")  # legacy: written into properties
        or extra.get("standard_steel_name")  # extra dict fallback
        or ""
    )

    if std_name:
        normalized_name = std_name.upper().replace("\u00d7", "X").replace("x", "X")
        # Try exact lookup first
        dims = _H_SECTION_DIMS.get(normalized_name)
        if dims:
            H, B, tw, tf = dims
            return 2, f"{tw},{H},{B},{tf},{B},{tf}", ""

        # Unknown standard names must be resolved by YJK's own catalogue;
        # dimensions must never be approximated from the designation.
        return 26, "", str(std_name)

    # PKPM-style shape dict
    shape = props.get("shape") or sec.get("shape")
    if isinstance(shape, dict):
        sk = str(shape.get("kind", ""))
        sk_lower = sk.lower()
        if sk_lower in ("rectangular", "rectangle", "rect") or kind == 1:
            H = shape.get("H", shape.get("height", sec.get("height")))
            B = shape.get("B", shape.get("width", sec.get("width")))
            return 1, f"{_dimension_text(B, 'Rectangle B')},{_dimension_text(H, 'Rectangle H')}", sec.get("name", "")
        if sk in ("H", "I") or kind == 2:
            tw = shape.get("tw")
            H = shape.get("H", sec.get("height"))
            B1 = shape.get("B1", shape.get("B", sec.get("width")))
            tf1 = shape.get("tf1", shape.get("tf"))
            B2 = shape.get("B2", B1)
            tf2 = shape.get("tf2", tf1)
            values = (tw, H, B1, tf1, B2, tf2)
            labels = ("I tw", "I H", "I B1", "I tf1", "I B2", "I tf2")
            return 2, ",".join(_dimension_text(value, label) for value, label in zip(values, labels)), ""
        if sk == "Box" or kind == 7:
            # kind=7 箱型: ShapeVal "B,H,U,T,D,F" (等厚时后四项相同)
            H = shape.get("H", sec.get("height"))
            B = shape.get("B", sec.get("width"))
            t = shape.get("T", shape.get("t"))
            U = shape.get("U", t)
            T_val = shape.get("T_bottom", t)
            D = shape.get("D", t)
            F = shape.get("F", t)
            values = (B, H, U, T_val, D, F)
            labels = ("Box B", "Box H", "Box U", "Box T", "Box D", "Box F")
            return 7, ",".join(_dimension_text(value, label) for value, label in zip(values, labels)), ""
        if sk == "Tube" or kind == 8:
            D = _positive_dimension(shape.get("D"), "Tube outer D")
            inner = shape.get("d")
            if inner is None and shape.get("t") is not None:
                inner = D - 2.0 * _positive_dimension(shape.get("t"), "Tube thickness t")
            d = _positive_dimension(inner, "Tube inner d")
            if d >= D:
                raise ValueError("Tube inner diameter must be smaller than outer diameter")
            return 8, f"{_dimension_text(D, 'Tube outer D')},{_dimension_text(d, 'Tube inner d')}", ""

    # --- Build ShapeVal from properties by kind ---
    if kind == 2:
        tw = props.get("tw")
        H = props.get("H", sec.get("height"))
        B1 = props.get("B1", props.get("B", sec.get("width")))
        tf1 = props.get("tf1", props.get("tf"))
        B2 = props.get("B2", B1)
        tf2 = props.get("tf2", tf1)
        values = (tw, H, B1, tf1, B2, tf2)
        labels = ("I tw", "I H", "I B1", "I tf1", "I B2", "I tf2")
        return 2, ",".join(_dimension_text(value, label) for value, label in zip(values, labels)), ""

    if kind == 7:
        # 箱型: "B,H,U,T,D,F"
        H = props.get("H", sec.get("height"))
        B = props.get("B", sec.get("width"))
        t = props.get("t", props.get("T"))
        return 7, ",".join((
            _dimension_text(B, "Box B"),
            _dimension_text(H, "Box H"),
            *[_dimension_text(t, "Box thickness") for _ in range(4)],
        )), ""

    if kind == 8:
        D = _positive_dimension(props.get("D", sec.get("diameter")), "Tube outer D")
        inner = props.get("d")
        if inner is None and props.get("t") is not None:
            inner = D - 2.0 * _positive_dimension(props.get("t"), "Tube thickness t")
        d = _positive_dimension(inner, "Tube inner d")
        if d >= D:
            raise ValueError("Tube inner diameter must be smaller than outer diameter")
        return 8, f"{_dimension_text(D, 'Tube outer D')},{_dimension_text(d, 'Tube inner d')}", ""

    if kind == 3:
        D = sec.get("diameter") or props.get("D")
        return 3, _dimension_text(D, "Circle D"), ""

    # Legacy rectangular sections are accepted only with explicit dimensions.
    w = sec.get("width") or props.get("B")
    h = sec.get("height") or props.get("H")
    return 1, f"{_dimension_text(w, 'Rectangle B')},{_dimension_text(h, 'Rectangle H')}", sec.get("name", "")






def _json_safe(value: Any) -> Any:
    """Convert YJKAPI return values to JSON-safe diagnostics."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return repr(value)


def _extract_yjk_id(value: Any) -> Any | None:
    """Best-effort extraction of an object id from a YJKAPI return value."""
    if value is None:
        return None
    if isinstance(value, (str, int)):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        for key in ("id", "Id", "ID", "node_id", "NodeID", "model_id", "ModelID"):
            if key in value:
                return _extract_yjk_id(value[key])
        return None

    for attr in ("id", "Id", "ID", "node_id", "NodeID", "model_id", "ModelID", "m_id", "m_ID"):
        try:
            attr_value = getattr(value, attr)
        except Exception:
            continue
        extracted = _extract_yjk_id(attr_value)
        if extracted is not None:
            return extracted

    for method in ("GetID", "GetId", "get_id"):
        try:
            method_value = getattr(value, method)
        except Exception:
            continue
        if not callable(method_value):
            continue
        try:
            extracted = _extract_yjk_id(method_value())
        except Exception:
            continue
        if extracted is not None:
            return extracted

    return None




def _plan_key(x_mm: int, y_mm: int) -> str:
    return f"{x_mm},{y_mm}"










def _build_story_infos(stories: list[dict]) -> list[dict[str, Any]]:
    """Normalize story ids/elevations for mapping output."""
    infos: list[dict[str, Any]] = []
    cumulative_elevation = 0.0
    for index, story in enumerate(stories, start=1):
        raw_elevation = story.get("elevation")
        elevation = float(raw_elevation) if raw_elevation is not None else cumulative_elevation
        height = float(story.get("height", 0))
        top_elevation = elevation + height
        story_id = str(story.get("id") or f"F{index}")
        infos.append({
            "id": story_id,
            "index": index,
            "height_m": height,
            "elevation_m": elevation,
            "top_elevation_m": top_elevation,
            "height_mm": _metres_to_exact_mm(height, f"Story '{story_id}' height"),
            "elevation_mm": _metres_to_exact_mm(elevation, f"Story '{story_id}' elevation"),
            "top_elevation_mm": _metres_to_exact_mm(top_elevation, f"Story '{story_id}' top elevation"),
        })
        cumulative_elevation = top_elevation
    return infos










def _classify_element_geometry(elem: dict, nodes_by_id: dict[str, dict]) -> str:
    node_ids = elem.get("nodes", [])
    if len(node_ids) < 2:
        return "unknown"
    n1 = nodes_by_id.get(str(node_ids[0]))
    n2 = nodes_by_id.get(str(node_ids[1]))
    if not n1 or not n2:
        return "unknown"

    x1 = _metres_to_exact_mm(n1.get("x"), f"Element '{elem.get('id')}' node 1 X")
    y1 = _metres_to_exact_mm(n1.get("y"), f"Element '{elem.get('id')}' node 1 Y")
    z1 = _metres_to_exact_mm(n1.get("z"), f"Element '{elem.get('id')}' node 1 Z")
    x2 = _metres_to_exact_mm(n2.get("x"), f"Element '{elem.get('id')}' node 2 X")
    y2 = _metres_to_exact_mm(n2.get("y"), f"Element '{elem.get('id')}' node 2 Y")
    z2 = _metres_to_exact_mm(n2.get("z"), f"Element '{elem.get('id')}' node 2 Z")

    if x1 == x2 and y1 == y2 and z1 != z2:
        return "vertical"
    if z1 == z2 and y1 == y2 and x1 != x2:
        return "horizontal_x"
    if z1 == z2 and x1 == x2 and y1 != y2:
        return "horizontal_y"
    if z1 != z2:
        return "diagonal_3d"
    return "plan_diagonal"




def _section_summary(section: dict | None) -> dict[str, Any] | None:
    if not section:
        return None
    return {
        "id": section.get("id"),
        "name": section.get("name"),
        "type": section.get("type"),
        "purpose": section.get("purpose"),
        "standard_steel_name": section.get("standard_steel_name"),
        "shape": _json_safe(section.get("shape")),
        "properties": _json_safe(section.get("properties", {})),
    }


def _material_summary(material: dict | None) -> dict[str, Any] | None:
    if not material:
        return None
    return {
        "id": material.get("id"),
        "name": material.get("name"),
        "category": material.get("category"),
        "grade": material.get("grade"),
        "fy": material.get("fy"),
    }


def _concrete_grade(material: dict) -> int | None:
    """Native grade identity only; stiffness equivalence needs solver evidence."""
    if material.get("category") != "concrete":
        return None
    match = re.fullmatch(r"C(\d+)", str(material.get("grade") or "").strip().upper())
    if match is None or int(match[1]) not in range(15, 85, 5):
        raise ValueError(f"YJK concrete material '{material.get('id')}' requires an explicit C15–C80 grade")
    return int(match[1])


def convert_v2_to_ydb(
    data: dict[str, Any], work_dir: str, ydb_filename: str = "model.ydb",
) -> str:
    """Compile the supplied topology, one independent native floor at a time."""
    stiffness_plan = None
    if any(material.get("E") is not None for material in data.get("materials", [])):
        from native_materials import compile_stiffness_plan, normalize_material
        stiffness_plan = compile_stiffness_plan(data)
        data = {**copy.deepcopy(data), "materials": [normalize_material(m) for m in data["materials"]]}
    _require_canonical_3d_coordinate_contract(data)
    validate_building_model(data)
    os.makedirs(work_dir, exist_ok=True)
    stories = sorted(data["stories"], key=lambda story: float(story["elevation"]))
    story_infos = _build_story_infos(stories)
    data_func = DataFunc()
    section_roles = _infer_section_roles(data)
    native_sections: dict[str, Any] = {}
    inclined_sections: dict[str, Any] = {}
    node_map = {str(node["id"]): node for node in data["nodes"]}
    inclined_ids = {str(element["id"]) for element in data["elements"]
        if element["type"] == "column" and any(node_map[str(element["nodes"][0])][key] !=
            node_map[str(element["nodes"][1])][key] for key in ("x", "y"))}
    inclined_section_ids = {str(element["section"]) for element in data["elements"]
                            if str(element["id"]) in inclined_ids}
    section_defs: dict[str, dict[str, Any]] = {}
    for section in data["sections"]:
        section_id = str(section["id"])
        role = section_roles.get(section_id)
        if role is None:
            continue
        material_type = _resolve_mat_type(section, data)
        section_type = section.get("type", "rectangular")
        if section_type not in _TYPE_TO_KIND:
            raise ValueError(f"Unsupported YJK section type '{section_type}'")
        kind, shape, name = _build_shape_val(section, _TYPE_TO_KIND[section_type])
        define = data_func.ColSect_Def if role == "column" else data_func.BeamSect_Def
        native_section = define(material_type, kind, shape, name)
        native_sections[section_id] = native_section
        if section_id in inclined_section_ids:
            inclined_sections[section_id] = data_func.BraceSect_Def(material_type, kind, shape, name)
        section_defs[section_id] = {
            "id": section_id, "role": role, "type": section.get("type"),
            "yjk_mat_type": material_type, "yjk_kind": kind, "shape_val": shape, "name": name,
            "yjk_section_id": _extract_yjk_id(native_section),
        }
    nodes = {str(node["id"]): node for node in data["nodes"]}
    sections = {str(section["id"]): section for section in data["sections"]}
    materials = {str(material["id"]): material for material in data["materials"]}
    grades = {key: _concrete_grade(material) for key, material in materials.items()}
    node_mappings: dict[str, dict[str, Any]] = {}
    element_mappings: dict[str, dict[str, Any]] = {}
    all_native_nodes: dict[str, Any] = {}
    all_native_members: dict[str, Any] = {}
    floor_mappings: list[dict[str, Any]] = []
    for node_id, node in nodes.items():
        level = float(node["z"])
        floor_index = next((info["index"] for info in story_infos if abs(info["top_elevation_m"] - level) < 1e-6), 0)
        node_mappings[node_id] = {
            "v2_id": node_id,
            **{f"{axis}_m": float(node[axis]) for axis in ("x", "y", "z")},
            **{f"{axis}_mm": _metres_to_exact_mm(node[axis], f"Node '{node_id}' {axis}") for axis in ("x", "y", "z")},
            "floor": stories[floor_index - 1]["id"] if floor_index else None,
            "floor_index": floor_index,
            "floor_source": "exact-global-elevation",
            "plan_key": _plan_key(_metres_to_exact_mm(node["x"], "X"), _metres_to_exact_mm(node["y"], "Y")),
            "yjk_std_floor_node_id": None,
            "yjk_std_floor_node_id_source": None,
        }
    for story, info in zip(stories, story_infos):
        dead, live = _get_floor_loads(story)
        # Story-derived nodal forces are already the declared load distribution.
        # Do not add the same area load again through the native floor defaults.
        if any(load.get("source") == "story_floor_loads" and str(load.get("story")) == str(story["id"])
               for case in data.get("load_cases", []) for load in case.get("loads", [])):
            dead = live = 0.0
        native_floor = data_func.StdFlr_Generate(info["height_mm"], dead, live)
        # Initialize the SDK's complete floor defaults, then write every RC
        # member's grade explicitly below. Zero-filled Para is not a C30 floor.
        floor_parameters = BzcPara()
        if (data.get("analysis_control") or {}).get("rigid_floor") is False:
            floor_parameters.setVal(1, 0)  # No authored floor plate in the rod model.
        native_floor.Para = floor_parameters.GetValString()
        floor_id = _extract_yjk_id(native_floor)
        if floor_id is None:
            raise RuntimeError("YJK StdFlr_Generate did not return an identifiable floor")
        native_nodes: dict[str, Any] = {}
        plan_nodes: dict[tuple[int, int], Any] = {}
        for node_id, entry in node_mappings.items():
            if entry["floor_index"] != info["index"]:
                continue
            native_node = data_func.Joint_Generate(floor_id, entry["x_mm"], entry["y_mm"])
            native_nodes[node_id] = native_node
            plan_nodes[(entry["x_mm"], entry["y_mm"])] = native_node
            all_native_nodes[node_id] = native_node
            entry["yjk_std_floor_node_id"] = _extract_yjk_id(native_node)
            entry["yjk_std_floor_node_id_source"] = "Joint_Generate"
        for element in data["elements"]:
            node_ids = [str(value) for value in element["nodes"]]
            top = max(float(nodes[node_id]["z"]) for node_id in node_ids)
            if abs(top - info["top_elevation_m"]) > 1e-6:
                continue
            element_id = str(element["id"])
            section_id = str(element["section"])
            if section_id not in native_sections:
                raise ValueError(f"YJK element '{element_id}' has no registered section")
            rotation = (float(stiffness_plan["members"][element_id]["nativeRotationDegrees"])
                        if stiffness_plan is not None else 0.0)
            if element_id in inclined_ids:
                # YJK's documented ordinary inclined-column route uses a
                # two-endpoint rod. Keep the physical type column; acceptance
                # requires native COL classification and six rigid DOFs.
                lower = node_mappings[node_ids[0]]
                lower_key = (lower["x_mm"], lower["y_mm"])
                if lower_key not in plan_nodes:
                    plan_nodes[lower_key] = data_func.Joint_Generate(floor_id, *lower_key)
                native_member = data_func.brace_arrange(plan_nodes[lower_key], native_nodes[node_ids[1]],
                    inclined_sections[section_id], HDiff1=0, HDiff2=info["height_mm"], Rotation=rotation)
            elif element["type"] == "column":
                native_member = data_func.column_arrange(native_nodes[node_ids[1]], native_sections[section_id], Rotation=rotation)
            else:
                start = _extract_yjk_id(native_nodes[node_ids[0]])
                end = _extract_yjk_id(native_nodes[node_ids[1]])
                axis = data_func.Axis_Generate(floor_id, start, end)
                grid = data_func.Grid_Generate(floor_id, start, end, _extract_yjk_id(axis))
                native_member = data_func.beam_arrange(grid, native_sections[section_id], Rotation=rotation)
                if (data.get("analysis_control") or {}).get("rigid_floor") is False:
                    native_member.NoSlab = 1
            member_id = _extract_yjk_id(native_member)
            if member_id is None:
                raise RuntimeError(f"YJK member '{element_id}' did not return an identifiable native object")
            all_native_members[element_id] = native_member
            if element_id in inclined_ids:
                from YJKAPI import Property
                fixed_ends = Property("SpBrac")
                fixed_ends.setVal(0, 0)
                fixed_ends.setVal(1, 0)
                data_func.property_arrange(member_id, "SpBrac", 27, fixed_ends.GetValString())
            grade = grades[str(element["material"])]
            if grade is not None:
                # Public SDK encoding, also used by the audited YJK Flow API:
                # HNTDJ is a scalar grade property (type 5), not elastic E.
                data_func.property_arrange(member_id, "HNTDJ", 5, str(grade))
            if stiffness_plan is not None:
                from native_materials import assign_member_stiffness
                assign_member_stiffness(data_func, member_id, stiffness_plan["members"][element_id])
            element_mappings[element_id] = {
                "v2_id": element_id, "type": element["type"], "nodes": node_ids,
                "floor": story["id"], "floor_index": info["index"],
                "floor_source": "exact-global-elevation",
                "geometry_role": _classify_element_geometry(element, nodes),
                "section_id": section_id, "material_id": str(element["material"]),
                "section": _section_summary(sections[section_id]),
                "material": _material_summary(materials[str(element["material"])]),
                "yjk_section_id": section_defs[section_id]["yjk_section_id"],
                "yjk_model_id": member_id, "yjk_model_id_source": "individual-native-member",
                "native_endpoint_order": node_ids,
                "native_geometry_route": "ordinary-inclined-column" if element_id in inclined_ids else element["type"],
                "required_native_classification": {"brace_kind": 2, "is_truss": 0, "releases": [0] * 6}
                    if element_id in inclined_ids else None,
                "native_concrete_grade": grade,
            }
        data_func.Floors_Assemb(info["elevation_mm"], native_floor, 1, info["height_mm"])
        floor_mappings.append({"story": story["id"], "floor_index": info["index"], "native_floor_id": floor_id})
    if len(element_mappings) != len(data["elements"]):
        raise RuntimeError("YJK native compilation did not map every input member")
    from native_loads import arrange_native_loads
    load_case_mapping = (arrange_native_loads(data_func, data, all_native_nodes, all_native_members)
                         if data.get("load_cases") else [])
    data_func.DbModel_Assign()
    reader = Hi_AddToAndReadYjk(data_func.GetDbModelData())
    if not reader.CreateYDB(work_dir, ydb_filename):
        raise RuntimeError("YJK SDK CreateYDB failed / YJK 原生模型文件生成失败")
    ydb_path = os.path.join(work_dir, ydb_filename)
    if stiffness_plan is not None:
        from native_materials import repair_exchange_precision
        repair_exchange_precision(ydb_path, work_dir, element_mappings, stiffness_plan)
    mapping = {
        "schema_version": "2.0.0", "engine": "yjk-static", "ydb_path": ydb_path,
        "coordinate_contract": {**data["coordinate_system"], "coordinate_transform": "identity", "source_length_unit": "m", "target_length_unit": "mm"},
        "source": {"schema_version": data.get("schema_version"), "node_count": len(nodes), "element_count": len(element_mappings), "story_count": len(stories)},
        "stories": story_infos, "standard_floors": floor_mappings,
        "nodes": node_mappings, "elements": element_mappings, "sections": section_defs,
        "load_cases": load_case_mapping,
        "compiler": "individual-members-per-floor", "warnings": [],
    }
    with open(os.path.join(work_dir, "mapping.json"), "w", encoding="utf-8") as stream:
        json.dump(mapping, stream, ensure_ascii=False, indent=2, sort_keys=True)
    if stiffness_plan is not None:
        with open(os.path.join(work_dir, "native-stiffness-plan.json"), "w", encoding="utf-8") as stream:
            json.dump(stiffness_plan, stream, ensure_ascii=False, indent=2, sort_keys=True)
    return ydb_path
