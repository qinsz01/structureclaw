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
from typing import Any

from YJKAPI import DataFunc, Hi_AddToAndReadYjk

M_TO_MM = 1000.0

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
    dead = 5.0
    live = 2.0
    for fl in story.get("floor_loads", []):
        if fl.get("type") == "dead":
            dead = float(fl["value"])
        elif fl.get("type") == "live":
            live = float(fl["value"])
    return dead, live


def _infer_section_roles(data: dict) -> dict[str, str]:
    """Build {section_id: "column"|"beam"} by scanning element types."""
    roles: dict[str, str] = {}
    for elem in data.get("elements", []):
        sec_id = elem.get("section", "")
        etype = elem.get("type", "beam")
        if etype == "column" and roles.get(sec_id) != "column":
            roles[sec_id] = "column"
        elif sec_id not in roles:
            roles[sec_id] = "beam"
    return roles


def _resolve_mat_type(sec: dict, data: dict) -> int:
    """Determine YJK material type integer for a section."""
    props = sec.get("properties", {})
    if "mat" in props:
        return int(props["mat"])

    mat_map: dict[str, dict] = {m["id"]: m for m in data.get("materials", [])}
    for elem in data.get("elements", []):
        if elem.get("section") == sec["id"]:
            mat = mat_map.get(elem.get("material", ""))
            if mat:
                cat = mat.get("category", "steel")
                return _CATEGORY_TO_MAT.get(cat, 6)
            break
    return 5


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
    import re

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

        # Try regex parse for names not in the table
        hw_match = re.match(r"^(HW|HN|HM|HP|HT)(\d+)[Xx\u00d7](\d+)", std_name, re.IGNORECASE)
        if hw_match:
            prefix = hw_match.group(1).upper()
            H = int(hw_match.group(2))
            B = int(hw_match.group(3))
            if prefix == "HW":
                tw = max(8, H // 30)
                tf = max(12, H // 20)
            elif prefix == "HN":
                tw = max(6, H // 40)
                tf = max(9, H // 30)
            else:
                tw = max(7, H // 35)
                tf = max(11, H // 25)
            return 2, f"{tw},{H},{B},{tf},{B},{tf}", ""

        # Unrecognized standard name -> try kind=26 library lookup
        return 26, "", str(std_name)

    # PKPM-style shape dict
    shape = props.get("shape") or sec.get("shape")
    if isinstance(shape, dict):
        sk = shape.get("kind", "")
        if sk in ("H", "I") or kind == 2:
            tw = shape.get("tw", 10)
            H = shape.get("H", sec.get("height", 400))
            B1 = shape.get("B1", shape.get("B", sec.get("width", 200)))
            tf1 = shape.get("tf1", shape.get("tf", 14))
            B2 = shape.get("B2", B1)
            tf2 = shape.get("tf2", tf1)
            return 2, f"{int(tw)},{int(H)},{int(B1)},{int(tf1)},{int(B2)},{int(tf2)}", ""
        if sk == "Box" or kind == 7:
            # kind=7 箱型: ShapeVal "B,H,U,T,D,F" (等厚时后四项相同)
            H = shape.get("H", sec.get("height", 400))
            B = shape.get("B", sec.get("width", 400))
            t = shape.get("T", shape.get("t", 20))
            U = shape.get("U", t)
            T_val = shape.get("T_bottom", t)
            D = shape.get("D", t)
            F = shape.get("F", t)
            return 7, f"{int(B)},{int(H)},{int(U)},{int(T_val)},{int(D)},{int(F)}", ""
        if sk == "Tube" or kind == 8:
            D = shape.get("D", 200)
            d = shape.get("d", D - 20)
            return 8, f"{int(D)},{int(d)}", ""

    # --- Build ShapeVal from properties by kind ---
    if kind == 2:
        tw = props.get("tw", 10)
        H = props.get("H", sec.get("height", 400))
        B1 = props.get("B1", props.get("B", sec.get("width", 200)))
        tf1 = props.get("tf1", props.get("tf", 14))
        B2 = props.get("B2", B1)
        tf2 = props.get("tf2", tf1)
        return 2, f"{int(tw)},{int(H)},{int(B1)},{int(tf1)},{int(B2)},{int(tf2)}", ""

    if kind == 7:
        # 箱型: "B,H,U,T,D,F"
        H = props.get("H", sec.get("height", 400))
        B = props.get("B", sec.get("width", 400))
        t = props.get("t", props.get("T", 20))
        return 7, f"{int(B)},{int(H)},{int(t)},{int(t)},{int(t)},{int(t)}", ""

    if kind == 8:
        D = props.get("D", sec.get("diameter", 200))
        d = props.get("d", D - 20 if D else 180)
        return 8, f"{int(D)},{int(d)}", ""

    if kind == 3:
        D = sec.get("diameter") or props.get("D", 400)
        return 3, f"{int(D)}", ""

    # Fallback: rectangular (kind=1) "B,H"
    w = sec.get("width") or props.get("B", 400)
    h = sec.get("height") or props.get("H", 600)
    return 1, f"{int(w)},{int(h)}", sec.get("name", "")


def _extract_grid_spans(nodes: list[dict]) -> tuple[list[int], list[int]]:
    """Derive axis-grid span arrays from V2 node coordinates (meters -> mm)."""
    xs: set[float] = set()
    ys: set[float] = set()
    for n in nodes:
        xs.add(round(float(n["x"]) * M_TO_MM, 1))
        ys.add(round(float(n["y"]) * M_TO_MM, 1))

    sorted_x = sorted(xs)
    sorted_y = sorted(ys)

    if len(sorted_x) < 2 or len(sorted_y) < 2:
        raise ValueError(
            f"Need at least 2 unique X and 2 unique Y coordinates, "
            f"got {len(sorted_x)} X and {len(sorted_y)} Y"
        )

    xspans = [int(sorted_x[0])]
    for i in range(1, len(sorted_x)):
        xspans.append(int(round(sorted_x[i] - sorted_x[i - 1])))

    yspans = [int(sorted_y[0])]
    for i in range(1, len(sorted_y)):
        yspans.append(int(round(sorted_y[i] - sorted_y[i - 1])))

    return xspans, yspans


def convert_v2_to_ydb(
    data: dict[str, Any],
    work_dir: str,
    ydb_filename: str = "model.ydb",
) -> str:
    """Convert a V2 StructureModelV2 JSON dict to a YJK .ydb file.

    Returns the absolute path to the generated .ydb.
    """
    import sys
    def _log(msg: str) -> None:
        print(f"[yjk_converter] {msg}", file=sys.stderr, flush=True)

    os.makedirs(work_dir, exist_ok=True)
    warnings: list[str] = []

    stories = sorted(
        data.get("stories", []),
        key=lambda s: float(s.get("elevation", 0)),
    )
    if not stories:
        raise ValueError("V2 model has no stories defined")

    first_story = stories[0]
    height_mm = int(round(float(first_story["height"]) * M_TO_MM))
    dead, live = _get_floor_loads(first_story)
    _log(f"Story height: {height_mm}mm, dead={dead}, live={live}")

    data_func = DataFunc()
    std_flr = data_func.StdFlr_Generate(height_mm, dead, live)
    _log(f"StdFlr_Generate returned: {std_flr}")

    section_roles = _infer_section_roles(data)
    _log(f"Section roles: {section_roles}")

    col_defs: dict[str, Any] = {}
    beam_defs: dict[str, Any] = {}

    for sec in data.get("sections", []):
        sec_id = sec["id"]
        role = section_roles.get(sec_id, "beam")

        sec_type_str = sec.get("type", "rectangular")
        kind = _TYPE_TO_KIND.get(sec_type_str, 1)
        mat = _resolve_mat_type(sec, data)

        kind, shape_val, name = _build_shape_val(sec, kind)
        _log(f"Section '{sec_id}' ({role}): mat={mat}, kind={kind}, shape_val='{shape_val}', name='{name}'")

        try:
            if role == "column":
                result = data_func.ColSect_Def(mat, kind, shape_val, name)
                col_defs[sec_id] = result
                _log(f"  ColSect_Def returned: {result}")
            else:
                result = data_func.BeamSect_Def(mat, kind, shape_val, name)
                beam_defs[sec_id] = result
                _log(f"  BeamSect_Def returned: {result}")
        except Exception as exc:
            _log(f"  ERROR: Section '{sec_id}' definition failed: {exc}")
            warnings.append(f"Section '{sec_id}' definition failed: {exc}")

    if not col_defs:
        _log("WARNING: No column sections defined; using fallback")
        # mat=5 (steel), kind=2 (H-section), ShapeVal: tw=20,H=650,B=400,tf1=28,B2=400,tf2=28
        col_defs["_fallback_col"] = data_func.ColSect_Def(5, 2, "20,650,400,28,400,28", "Fallback Column")
        warnings.append("No column sections defined; using default steel I-section")
    if not beam_defs:
        _log("WARNING: No beam sections defined; using fallback")
        # mat=5 (steel), kind=2 (H-section), ShapeVal: tw=18,H=900,B=300,tf1=26,B2=300,tf2=26
        beam_defs["_fallback_beam"] = data_func.BeamSect_Def(5, 2, "18,900,300,26,300,26", "Fallback Beam")
        warnings.append("No beam sections defined; using default steel I-section")

    nodes = data.get("nodes", [])
    if not nodes:
        raise ValueError("V2 model has no nodes")

    xspans, yspans = _extract_grid_spans(nodes)
    _log(f"Grid spans: xspans={xspans}, yspans={yspans}")

    nodelist = data_func.node_generate(xspans, yspans, std_flr)
    _log(f"node_generate returned: {nodelist} (type: {type(nodelist)})")

    first_col = next(iter(col_defs.values()))
    _log(f"Arranging columns with section: {first_col}")
    # NOTE: YJK DataFunc.column_arrange / beam_arrange applies one section to all
    # members in the grid at once.  Per-element section assignment is not supported
    # by this API level; the first defined section is used as the representative
    # section for the whole building.  Models with multiple distinct sections will
    # have their primary section applied uniformly here.
    try:
        col_result = data_func.column_arrange(nodelist, first_col)
        _log(f"column_arrange returned: {col_result}")
    except Exception as exc:
        _log(f"ERROR: column_arrange failed: {exc}")
        raise

    first_beam = next(iter(beam_defs.values()))
    _log(f"Arranging beams with section: {first_beam}")
    # Same API constraint as columns above — one section per grid arrangement call.
    try:
        grid_x = data_func.grid_generate(nodelist, 0, 1)
        _log(f"grid_generate(0,1) returned: {grid_x}")
        grid_y = data_func.grid_generate(nodelist, 1, 0)
        _log(f"grid_generate(1,0) returned: {grid_y}")
        beam_x_result = data_func.beam_arrange(grid_x, first_beam)
        _log(f"beam_arrange(grid_x) returned: {beam_x_result}")
        beam_y_result = data_func.beam_arrange(grid_y, first_beam)
        _log(f"beam_arrange(grid_y) returned: {beam_y_result}")
    except Exception as exc:
        _log(f"ERROR: beam arrangement failed: {exc}")
        raise

    # Assemble floors story by story to support varying story heights.
    # Each story gets its own StdFlr with the correct height and loads.
    # If all stories share the same height the loop degenerates to a single call.
    for i, story in enumerate(stories):
        s_height_mm = int(round(float(story.get("height", first_story["height"])) * M_TO_MM))
        if s_height_mm <= 0:
            s_height_mm = height_mm
        s_dead, s_live = _get_floor_loads(story)
        s_flr = data_func.StdFlr_Generate(s_height_mm, s_dead, s_live) if (
            s_height_mm != height_mm or s_dead != dead or s_live != live
        ) else std_flr
        _log(f"Assembling floor {i + 1}/{len(stories)}: height={s_height_mm}mm, dead={s_dead}, live={s_live}")
        try:
            data_func.Floors_Assemb(i, s_flr, 1, s_height_mm)
        except Exception as exc:
            _log(f"ERROR: Floors_Assemb failed for story {i + 1}: {exc}")
            raise
    _log("Floors_Assemb completed")

    _log("Assigning model to database...")
    try:
        data_func.DbModel_Assign()
        _log("DbModel_Assign completed")
    except Exception as exc:
        _log(f"ERROR: DbModel_Assign failed: {exc}")
        raise

    _log("Getting model data...")
    model = data_func.GetDbModelData()
    _log(f"GetDbModelData returned: {model}")

    _log(f"Creating YDB file: {ydb_filename}")
    reader = Hi_AddToAndReadYjk(model)
    reader.CreateYDB(work_dir, ydb_filename)

    ydb_path = os.path.join(work_dir, ydb_filename)
    _log(f"YDB file created: {ydb_path}")
    return ydb_path
