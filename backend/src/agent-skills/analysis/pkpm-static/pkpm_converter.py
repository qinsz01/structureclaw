"""
V2 StructureModelV2 JSON → PKPM JWS (via APIPyInterface)

保留的编译基础: 逐层水平梁与竖直柱；正式 V2 求解等待材料/截面属性原生校准。
支持的截面:
  - H/I 型: kind="H" → IDSec_I  (PKPM字段: B=tw, H, U=bf, T=tf, D=bf, F=tf)
  - 箱型:   kind="Box"  → IDSec_Box
  - 管型:   kind="Tube" → IDSec_Tube
  - 矩形:   kind="Rectangle" / "rectangular" → IDSec_Rectangle
  标准型钢名称(standard_steel_name)与参数化 shape 不可同时提供。
牌号枚举解析不是自定义材料常数校准；显式 E/nu/rho/G 和截面 A/I/J 等求解前拒绝。
多层处理: 每个自然层独立编译节点、构件、截面和荷载，不复制模板楼层。

单位约定:
  - V2 JSON: 坐标(m), 截面尺寸(mm), 力(kN), 应力(MPa)
  - PKPM APIPyInterface: 坐标(mm), 截面尺寸(mm)
  - RealFloor.SetBottomElevation: m（与 SetFloorHeight 的 mm 约定不同）

重要: I截面字段映射参考 APIPythonTest.py:
      V2(H,B,tw,tf) → PKPM(H,B=tw,U=B,T=tf,D=B,F=tf)
"""
from __future__ import annotations

import math
import os
import re
import sys
from pathlib import Path
from typing import Any

import APIPyInterface
from coordinate_semantics import resolve_model_dimension, validate_coordinate_contract
from contracts import AnalysisCapabilityError
from native_model_contract import pkpm_section_shape, validate_pkpm_material_properties, validate_pkpm_sections


def validate_execution_settings(data: dict) -> None:
    """Do not silently inherit native defaults for explicit physical controls."""
    controls = _as_dict(data.get("analysis_control"))
    unverified = [name for name in ("self_weight", "rigid_floor", "rigid_offsets", "construction_stage", "p_delta")
                  if controls.get(name) is not None]
    unverified.extend(f"stories.{story.get('id')}.rigid_diaphragm" for story in data.get("stories", [])
                      if story.get("rigid_diaphragm") is not None)
    if unverified:
        raise AnalysisCapabilityError(
            engine="pkpm", capability="explicit-native-analysis-settings",
            reason="PKPM native mapping/readback is not yet verified for: " + ", ".join(unverified),
        )


# ---------------------------------------------------------------------------
# Steel grade helpers
# ---------------------------------------------------------------------------

_GRADE_ALIASES: dict[str, str] = {
    "Q355B": "Q355",
    "Q345B": "Q345",
}


def _resolve_steel_grade(grade_str: str) -> Any:
    """Map V2 steel grade string to APIPyInterface.SteelGrade enum value."""
    sg = APIPyInterface.SteelGrade
    raw = grade_str.strip().upper()
    match = re.search(r"(?:Q|S)\d{3}(?:GJ|B)?", raw)
    token = match.group(0) if match else raw
    key = _GRADE_ALIASES.get(token, token)
    if hasattr(sg, key):
        return getattr(sg, key)
    raise ValueError(f"Unsupported PKPM steel grade '{grade_str}'")


def _resolve_concrete_grade(grade_str: str) -> Any:
    """Map V2 concrete grade string to APIPyInterface.ConcreteGrade enum value."""
    cg = APIPyInterface.ConcreteGrade
    raw = grade_str.strip().upper()
    match = re.search(r"C\d{1,2}", raw)
    key = match.group(0) if match else raw
    if hasattr(cg, key):
        return getattr(cg, key)
    raise ValueError(f"Unsupported PKPM concrete grade '{grade_str}'")


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _require_member_id(member: Any, *, element_id: str, member_type: str) -> int:
    get_id = getattr(member, "GetID", None)
    if not callable(get_id):
        raise RuntimeError(
            f"PKPM {member_type} '{element_id}' did not expose its result member ID"
        )
    pmid = int(get_id())
    if pmid <= 0:
        raise RuntimeError(
            f"PKPM {member_type} '{element_id}' returned an invalid result member ID {pmid}"
        )
    return pmid


def _detect_material_family(data: dict) -> str:
    """Resolve one explicit material family without silently choosing a default."""
    metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    material_system = str(metadata.get("materialSystem", "")).lower()
    declared_family = (
        "concrete" if "concrete" in material_system
        else "steel" if "steel" in material_system
        else None
    )

    structure_system = data.get("structure_system") if isinstance(data.get("structure_system"), dict) else {}
    structure_extra = structure_system.get("extra") if isinstance(structure_system.get("extra"), dict) else {}
    structure_material = str(structure_extra.get("materialSystem", "")).lower()
    structure_family = (
        "concrete" if "concrete" in structure_material
        else "steel" if "steel" in structure_material
        else None
    )
    if declared_family and structure_family and declared_family != structure_family:
        raise ValueError("PKPM material-family metadata is contradictory")
    declared_family = declared_family or structure_family

    materials = data.get("materials")
    if not isinstance(materials, list) or not materials:
        raise ValueError("PKPM conversion requires explicit materials")
    material_families: dict[str, str] = {}
    for mat in materials:
        if not isinstance(mat, dict):
            raise ValueError("PKPM material entries must be objects")
        material_id = str(mat.get("id", ""))
        family = str(mat.get("family", "")).lower()
        category = str(mat.get("category", "")).lower()
        explicit = family if family in ("steel", "concrete") else category
        grade_text = str(mat.get("grade") or mat.get("name") or "")
        inferred = (
            "concrete"
            if "concrete" in grade_text.lower() or re.search(r"C\d{1,2}", grade_text, re.IGNORECASE)
            else "steel"
            if "steel" in grade_text.lower() or re.search(r"(?:Q|S)\d{3}", grade_text, re.IGNORECASE)
            else None
        )
        resolved = explicit if explicit in ("steel", "concrete") else inferred
        if resolved is None:
            continue
        if explicit in ("steel", "concrete") and inferred and explicit != inferred:
            raise ValueError(f"PKPM material '{material_id}' family conflicts with its grade/name")
        material_families[material_id] = resolved

    used_families: set[str] = set()
    for element in data.get("elements", []):
        material_id = str(element.get("material", ""))
        family = material_families.get(material_id)
        if family is None:
            raise ValueError(f"PKPM element '{element.get('id')}' references an unknown material")
        used_families.add(family)
    if len(used_families) != 1:
        raise ValueError("PKPM conversion requires all modeled members to use one material family")
    resolved_family = next(iter(used_families))
    if declared_family and declared_family != resolved_family:
        raise ValueError("PKPM material-family metadata conflicts with modeled members")
    return resolved_family


# ---------------------------------------------------------------------------
# Section helpers
# ---------------------------------------------------------------------------

_KIND_MAP: dict[str, Any] = {
    # PascalCase (legacy / internal)
    "H":           "IDSec_I",
    "I":           "IDSec_I",
    "Box":         "IDSec_Box",
    "Tube":        "IDSec_Tube",
    "Rectangle":   "IDSec_Rectangle",
    "Circle":      "IDSec_Circle",
    "T":           "IDSec_T",
    "L":           "IDSec_L",
    # V2 schema lowercase aliases
    "h":           "IDSec_I",
    "i":           "IDSec_I",
    "box":         "IDSec_Box",
    "tube":        "IDSec_Tube",
    "pipe":        "IDSec_Tube",   # V2 uses "pipe" for circular hollow
    "hollow-circular": "IDSec_Tube",
    "rectangular": "IDSec_Rectangle",
    "circular":    "IDSec_Circle",
    "t":           "IDSec_T",
    "l":           "IDSec_L",
}


def _make_section_shape(
    shape: dict,
    material_family: str = "steel",
) -> tuple[Any, APIPyInterface.SectionShape]:
    """Build (SectionKind, SectionShape) from a V2 shape dict.

    PKPM IDSec_I field mapping (per official APIPythonTest.py):
      B = web thickness (tw),  H = total height,
      U = top flange width,    T = top flange thickness (tf),
      D = bottom flange width, F = bottom flange thickness.

    V2 JSON uses: H=height, B=flange width, tw=web thickness, tf=flange thickness.
    """
    sk = APIPyInterface.SectionKind
    sh = APIPyInterface.SectionShape()

    kind = shape.get("kind", "Rectangle")
    sec_kind_attr = _KIND_MAP[kind]
    sec_kind = getattr(sk, sec_kind_attr)

    H  = shape.get("H") or shape.get("h")
    B  = shape.get("B") or shape.get("b")   # V2: flange width
    T  = shape.get("T") or shape.get("t")
    tw = shape.get("tw")                     # V2: web thickness
    tf = shape.get("tf")                     # V2: flange thickness
    D  = shape.get("D") or shape.get("d")    # V2: diameter (Tube/Circle)

    if sec_kind_attr == "IDSec_I":
        # PKPM I-section: B=tw, H=height, U=flange_width, T=tf, D=flange_width, F=tf
        if H  is not None: sh.Set_H(round(H))
        if tw is not None: sh.Set_B(round(tw))     # web thickness → B
        if B  is not None: sh.Set_U(round(B))      # flange width  → U (top)
        if tf is not None: sh.Set_T(round(tf))      # flange thick  → T (top)
        if B  is not None: sh.Set_D(round(B))      # flange width  → D (bottom, symmetric)
        if tf is not None: sh.Set_F(round(tf))      # flange thick  → F (bottom, symmetric)
    elif sec_kind_attr == "IDSec_Box":
        if H is not None: sh.Set_H(round(H))
        if B is not None: sh.Set_B(round(B))
        if T is not None: sh.Set_T(round(T))
    elif sec_kind_attr == "IDSec_Tube":
        if D is not None: sh.Set_D(round(D))
        if T is not None: sh.Set_T(round(T))
    else:
        if H is not None: sh.Set_H(round(H))
        if B is not None: sh.Set_B(round(B))
        if T is not None: sh.Set_T(round(T))
        if D is not None: sh.Set_D(round(D))

    # Material type: 5=steel, 6=concrete
    sh.Set_M(5 if material_family == "steel" else 6)

    return sec_kind, sh


def _infer_section_roles(data: dict) -> dict[str, str]:
    """Build an unambiguous {section_id: "col"|"beam"} mapping."""
    roles: dict[str, str] = {}
    for elem in data.get("elements", []):
        sec_id = elem.get("section", "")
        if not sec_id:
            continue
        etype = elem.get("type", "")
        role = "col" if etype == "column" else "beam" if etype == "beam" else None
        if role is None:
            continue
        if sec_id in roles and roles[sec_id] != role:
            raise ValueError(
                f"PKPM conversion requires separate section ids for beams and columns; '{sec_id}' is shared"
            )
        roles[sec_id] = role
    return roles


def _safe_coord(node: dict, axis: str) -> float:
    try:
        value = float(node[axis])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"Node '{node.get('id')}' global {axis.upper()} must be finite") from error
    if not math.isfinite(value):
        raise ValueError(f"Node '{node.get('id')}' global {axis.upper()} must be finite")
    return value


def _finite_number(value: Any, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be finite") from error
    if not math.isfinite(number):
        raise ValueError(f"{label} must be finite")
    return number


def _normalize_generic_frame_for_pkpm(data: dict) -> tuple[dict, dict[str, Any]]:
    """Validate canonical member roles without reinterpreting coordinates."""
    nodes = [dict(node) for node in data.get("nodes", [])]

    node_by_id = {str(node.get("id")): node for node in nodes}
    elements: list[dict] = []
    tol = 1e-6
    for elem in data.get("elements", []):
        normalized = dict(elem)
        node_ids = list(normalized.get("nodes", []))
        element_id = str(normalized.get("id", "?"))
        element_type = str(normalized.get("type", ""))
        if element_type not in {"beam", "column"}:
            raise ValueError(f"PKPM coordinate-preserving conversion does not support element type '{element_type}'")
        if len(node_ids) != 2:
            raise ValueError(f"PKPM line element '{element_id}' must reference exactly two nodes")
        n1 = node_by_id.get(str(node_ids[0]))
        n2 = node_by_id.get(str(node_ids[1]))
        if n1 is None or n2 is None:
            raise ValueError(f"PKPM element '{element_id}' references an unknown node")
        same_plan = (
            abs(_safe_coord(n1, "x") - _safe_coord(n2, "x")) <= tol
            and abs(_safe_coord(n1, "y") - _safe_coord(n2, "y")) <= tol
        )
        z1 = _safe_coord(n1, "z")
        z2 = _safe_coord(n2, "z")
        if element_type == "column" and (not same_plan or z2 <= z1 + tol):
            raise ValueError(
                f"PKPM column '{element_id}' must be ordered from lower to upper node on one global X/Y plan point"
            )
        if element_type == "beam" and (same_plan or abs(z2 - z1) > tol):
            raise ValueError(f"PKPM beam '{element_id}' must be horizontal in the global X-Y floor plane")
        if abs(float(normalized.get("rotation_angle", 0.0) or 0.0)) > tol:
            raise ValueError(f"PKPM adapter cannot yet preserve rotation_angle on element '{element_id}'")
        if normalized.get("offsets"):
            raise ValueError(f"PKPM adapter cannot yet preserve end offsets on element '{element_id}'")
        elements.append(normalized)

    raw_stories = data.get("stories", [])
    if not isinstance(raw_stories, list) or not raw_stories:
        raise ValueError("PKPM conversion requires explicit stories; story elevations and loads are not inferred")
    stories = sorted(
        [dict(story) for story in raw_stories],
        key=lambda story: float(story.get("elevation", 0.0)),
    )
    z_levels = sorted({_safe_coord(node, "z") for node in nodes})
    if len(stories) != len(z_levels) - 1:
        raise ValueError("PKPM conversion requires one explicit story for every adjacent global Z interval")
    if abs(z_levels[0]) > tol:
        raise ValueError("PKPM floor conversion currently requires the base at global Z=0")

    story_ids: list[str] = []
    for index, story in enumerate(stories):
        story_id = str(story.get("id", ""))
        try:
            elevation = float(story["elevation"])
            height = float(story["height"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"Story '{story_id}' must declare finite elevation and height") from error
        if (
            not math.isfinite(elevation)
            or not math.isfinite(height)
            or abs(elevation - z_levels[index]) > tol
            or abs(elevation + height - z_levels[index + 1]) > tol
        ):
            raise ValueError(f"Story '{story_id}' elevation/height conflicts with global Z levels")
        if not story_id or story_id in story_ids:
            raise ValueError("PKPM conversion requires unique non-empty story ids")
        declared_loads = story.get("floor_loads")
        if declared_loads:
            if not isinstance(declared_loads, list):
                raise ValueError(f"Story '{story_id}' floor_loads must be a list")
            load_values: dict[str, float] = {}
            for load in declared_loads:
                if not isinstance(load, dict) or load.get("type") not in {"dead", "live"}:
                    raise ValueError(
                        f"Story '{story_id}' floor_loads supports explicit dead/live entries only"
                    )
                load_type = str(load["type"])
                if load_type in load_values:
                    raise ValueError(f"Story '{story_id}' has duplicate {load_type} floor loads")
                load_values[load_type] = _nonnegative_float(
                    load.get("value"), field=f"floor_loads[{load_type}]", story_id=story_id
                )
            dead_load, live_load = _story_dead_live_pair(story)
            if (
                abs(load_values.get("dead", 0.0) - dead_load) > tol
                or abs(load_values.get("live", 0.0) - live_load) > tol
            ):
                raise ValueError(f"Story '{story_id}' floor_loads conflict with dead_load/live_load")
        story_ids.append(story_id)

    plan_by_level: dict[float, set[tuple[float, float]]] = {}
    for node in nodes:
        z = _safe_coord(node, "z")
        plan = (_safe_coord(node, "x"), _safe_coord(node, "y"))
        level = min(z_levels, key=lambda candidate: abs(candidate - z))
        if abs(level - z) > tol:
            raise ValueError(f"Node '{node.get('id')}' does not lie on a declared PKPM floor level")
        plans = plan_by_level.setdefault(level, set())
        if plan in plans:
            raise ValueError(f"PKPM conversion cannot preserve coincident node '{node.get('id')}'")
        plans.add(plan)
        restraints = tuple(node.get("restraints") or [False] * 6)
        if len(restraints) != 6 or any(type(value) is not bool for value in restraints):
            raise ValueError(f"Node '{node.get('id')}' restraints must contain six booleans")
        if abs(z - z_levels[0]) <= tol:
            if restraints not in {
                (True, True, True, True, True, True),
                (True, True, True, False, False, False),
            }:
                raise ValueError(f"PKPM cannot preserve base restraints for node '{node.get('id')}'")
        elif any(restraints):
            raise ValueError(f"PKPM standard-floor replication cannot preserve restraints on node '{node.get('id')}'")

    topology_by_floor: dict[int, dict[str, dict[tuple[tuple[float, float], tuple[float, float]], tuple[str, str, Any, Any]]]] = {
        index: {"beam": {}, "column": {}}
        for index in range(1, len(z_levels))
    }
    for element in elements:
        element_id = str(element.get("id", ""))
        node_ids = element.get("nodes", [])
        start = node_by_id[str(node_ids[0])]
        end = node_by_id[str(node_ids[1])]
        start_z = _safe_coord(start, "z")
        end_z = _safe_coord(end, "z")
        element_type = str(element.get("type"))
        level_z = end_z if element_type == "column" else start_z
        try:
            floor_index = next(
                index for index, value in enumerate(z_levels)
                if index > 0 and abs(value - level_z) <= tol
            )
        except StopIteration as error:
            raise ValueError(f"Element '{element_id}' does not map to a natural floor") from error
        expected_story = story_ids[floor_index - 1]
        if element.get("story") is not None and str(element.get("story")) != expected_story:
            raise ValueError(f"Element '{element_id}' story conflicts with its global Z level")
        if element.get("releases"):
            raise ValueError(f"PKPM adapter cannot yet preserve end releases on element '{element_id}'")
        if element_type == "column" and abs(start_z - z_levels[floor_index - 1]) > tol:
            raise ValueError(f"PKPM column '{element_id}' must connect adjacent declared floors")
        start_plan = (_safe_coord(start, "x"), _safe_coord(start, "y"))
        end_plan = (_safe_coord(end, "x"), _safe_coord(end, "y"))
        topology_key = (start_plan, end_plan) if element_type == "beam" else (start_plan, start_plan)
        signature = (
            str(element.get("section", "")),
            str(element.get("material", "")),
            element.get("steel_grade") or element.get("concrete_grade"),
            element.get("rebar_grade"),
        )
        floor_topology = topology_by_floor[floor_index][element_type]
        if topology_key in floor_topology:
            raise ValueError(f"PKPM conversion cannot preserve duplicate {element_type} '{element_id}'")
        floor_topology[topology_key] = signature

    normalized_data = dict(data)
    normalized_data["nodes"] = nodes
    normalized_data["elements"] = elements
    normalized_data["stories"] = stories
    return normalized_data, {
        "vertical_axis": "z",
        "coordinate_transform": "identity",
        "inferred_columns": 0,
        "inferred_stories": 0,
    }


def _validate_story_derived_loads(data: dict) -> None:
    from native_model_contract import validate_story_load_totals
    validate_story_load_totals(data, "PKPM")


def _register_section(
    model: APIPyInterface.Model,
    sec: dict,
    inferred_role: str,
    material_family: str = "steel",
) -> tuple[str, int]:
    """
    Register one V2 section entry.
    Returns (role, pm_section_idx) where role is "col" or "beam".

    Geometry and standard-section names are mutually exclusive.
    Explicit mechanical-property overrides are rejected before native calls.
    """
    std_name: str | None = sec.get("standard_steel_name")
    shape_dict: dict | None = pkpm_section_shape(sec)
    use_standard_steel = bool(std_name) and material_family == "steel" and not shape_dict

    def _set_standard_steel(api_section: Any) -> Exception | None:
        if not std_name:
            return ValueError("standard steel section name is empty")
        try:
            api_section.SetStandSteelSect(std_name, APIPyInterface.SectionShape())
            return None
        except TypeError:
            try:
                api_section.SetStandSteelSect(std_name)
                return None
            except Exception as exc:
                return exc
        except Exception as exc:
            return exc

    if inferred_role == "col":
        csec = APIPyInterface.ColumnSection()
        if shape_dict:
            _sec_kind, sh = _make_section_shape(shape_dict, material_family)
            csec.SetUserSect(_sec_kind, sh)
        elif use_standard_steel:
            standard_error = _set_standard_steel(csec)
            if standard_error is not None:
                raise ValueError(f"Section '{sec['id']}' standard steel section failed: {standard_error}")
        else:
            raise ValueError(f"Section '{sec['id']}' has no usable PKPM section shape.")
        pm_idx = model.AddColumnSection(csec)
    else:
        bsec = APIPyInterface.BeamSection()
        if shape_dict:
            _sec_kind, sh = _make_section_shape(shape_dict, material_family)
            bsec.SetUserSect(_sec_kind, sh)
        elif use_standard_steel:
            standard_error = _set_standard_steel(bsec)
            if standard_error is not None:
                raise ValueError(f"Section '{sec['id']}' standard steel section failed: {standard_error}")
        else:
            raise ValueError(f"Section '{sec['id']}' has no usable PKPM section shape.")
        pm_idx = model.AddBeamSection(bsec)

    return inferred_role, pm_idx


def _build_section_registry(
    model: APIPyInterface.Model,
    sections: list[dict],
    data: dict,
    material_family: str = "steel",
) -> dict[str, tuple[str, int]]:
    """Register all sections. Returns {sec_id: (role, pm_idx)}."""
    inferred = _infer_section_roles(data)
    registry: dict[str, tuple[str, int]] = {}
    for sec in sections:
        role = inferred.get(sec["id"])
        if role is None:
            continue
        r, pm_idx = _register_section(model, sec, role, material_family)
        registry[sec["id"]] = (r, pm_idx)
    return registry


# ---------------------------------------------------------------------------
# Plan (x,y) node mapping
# ---------------------------------------------------------------------------

def _build_plan_nodes(
    floor: APIPyInterface.StandFloor,
    nodes: list[dict],
) -> tuple[dict[str, int], dict[str, tuple[float, float]]]:
    """
    Deduplicate nodes by (x,y) plan position and add them to the PKPM floor.
    Returns:
      v2_to_pm:  {v2_node_id → pm_node_id}
      v2_to_xy:  {v2_node_id → (x_mm, y_mm)}
    """
    m_to_mm = 1000.0
    xy_to_pm: dict[tuple[float, float], int] = {}
    v2_to_pm: dict[str, int] = {}
    v2_to_xy: dict[str, tuple[float, float]] = {}

    for n in nodes:
        x_mm = float(n["x"]) * m_to_mm
        y_mm = float(n["y"]) * m_to_mm
        xy = (x_mm, y_mm)

        if xy not in xy_to_pm:
            pm_node = floor.AddNode(x_mm, y_mm)
            xy_to_pm[xy] = pm_node.GetID()

        pm_id = xy_to_pm[xy]
        v2_to_pm[n["id"]] = pm_id
        v2_to_xy[n["id"]] = xy

    return v2_to_pm, v2_to_xy


# ---------------------------------------------------------------------------
# Element default steel grade fallback
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# SATWE design parameter configuration
# ---------------------------------------------------------------------------

def _configure_satwe_params(
    model: APIPyInterface.Model,
    material_family: str,
    site_seismic: dict[str, Any] | None = None,
    wind: dict[str, Any] | None = None,
    analysis_control: dict[str, Any] | None = None,
) -> None:
    """Set PMCAD/SATWE design parameters through the official API.

    `GetAllDesignPara` / `SetAllDesignPara` indices are defined in
    PKPMAPI5.0参考手册, "楼层-设计参数":
      24 = 设计地震分组
      25 = 地震烈度
      26 = 场地类别
      30 = 计算振型个数
      31 = 周期折减系数
      33 = 修正后的基本风压
      34 = 地面粗糙度类别
      35/36/37 = 体型变化分段数 / 第一段最高层号 / 第一段体型系数

    Some SATWE control values such as Tg and alpha max are persisted through
    PMProjectPara field ids from PKPM结构数据SQLite化数据表及字段说明:
      312 = 特征周期Tg
      313 = 多遇地震影响系数最大值
    The installed API stores 301/303 as compact internal values:
      301 = 0/1/2 for 第一/第二/第三组
      303 = 0/1/2/3/4 for I0/I1/II/III/IV
    """
    para = model.GetProjectPara()

    # Field 103: 结构材料信息
    if material_family == "steel":
        para.SetParaInt(103, 2)   # Native enum: steel (documentation option ID 10303 is not a value)
    else:
        para.SetParaInt(103, 0)   # Native enum: reinforced concrete

    # Field 101: 结构体系 — default 框架结构
    para.SetParaInt(101, 0)

    model.SaveProjectPara()

    project_para_updates_int: dict[int, int] = {}
    project_para_updates_double: dict[int, float] = {}
    design_param_updates: dict[int, float] = {}

    def _as_float(value: Any) -> float | None:
        try:
            if value is None:
                return None
            return float(value)
        except (TypeError, ValueError):
            return None

    def _design_group_code(value: Any) -> float | None:
        text = str(value or "")
        if "1" in text or "一" in text:
            return 1.0
        if "2" in text or "二" in text or "两" in text:
            return 2.0
        if "3" in text or "三" in text:
            return 3.0
        return None

    def _site_category_code(value: Any) -> float | None:
        text = str(value or "").strip().upper().replace("类", "")
        mapping = {
            "1": 1.0, "一": 1.0, "I": 1.0,
            "2": 2.0, "二": 2.0, "两": 2.0, "II": 2.0,
            "3": 3.0, "三": 3.0, "III": 3.0,
            "4": 4.0, "四": 4.0, "IV": 4.0,
        }
        return mapping.get(text)

    def _terrain_roughness_code(value: Any) -> float | None:
        text = str(value or "").strip().upper().replace("类", "")
        mapping = {"A": 1.0, "B": 2.0, "C": 3.0, "D": 4.0}
        return mapping.get(text)

    site_seismic = _as_dict(site_seismic)
    wind = _as_dict(wind)
    analysis_control = _as_dict(analysis_control)

    if site_seismic:
        intensity = _as_float(site_seismic.get("intensity"))
        site_category = _site_category_code(site_seismic.get("site_category"))
        design_group = _design_group_code(site_seismic.get("design_group"))
        if intensity is not None:
            design_param_updates[25] = intensity
        if site_category is not None:
            design_param_updates[26] = site_category
            project_para_updates_int[303] = int(site_category)
        if design_group is not None:
            design_param_updates[24] = design_group
            project_para_updates_int[301] = max(int(design_group) - 1, 0)
        characteristic_period = _as_float(site_seismic.get("characteristic_period"))
        if characteristic_period is not None:
            project_para_updates_double[312] = characteristic_period
        max_influence_coefficient = _as_float(site_seismic.get("max_influence_coefficient"))
        if max_influence_coefficient is not None:
            project_para_updates_double[313] = max_influence_coefficient
        damping_ratio = _as_float(site_seismic.get("damping_ratio"))
        if damping_ratio is not None:
            project_para_updates_double[311] = damping_ratio * 100 if damping_ratio <= 1 else damping_ratio

    if wind:
        basic_pressure = _as_float(wind.get("basic_pressure"))
        shape_factor = _as_float(wind.get("shape_factor"))
        terrain_roughness = _terrain_roughness_code(wind.get("terrain_roughness"))
        if basic_pressure is not None:
            design_param_updates[33] = basic_pressure
            project_para_updates_double[202] = basic_pressure
        if terrain_roughness is not None:
            design_param_updates[34] = terrain_roughness
            project_para_updates_int[201] = int(terrain_roughness)
        if shape_factor is not None:
            design_param_updates[35] = 1.0
            design_param_updates[37] = shape_factor

    if analysis_control:
        modal_count = _as_float(analysis_control.get("modal_count"))
        if modal_count is not None:
            design_param_updates[30] = modal_count
            project_para_updates_int[308] = int(modal_count)
        period_reduction = _as_float(analysis_control.get("period_reduction_factor"))
        if period_reduction is not None:
            design_param_updates[31] = period_reduction
            project_para_updates_double[310] = period_reduction
        basement_count = _as_float(analysis_control.get("basement_count"))
        if basement_count is not None:
            design_param_updates[4] = basement_count
        importance_factor = _as_float(analysis_control.get("structure_importance_factor"))
        if importance_factor is not None:
            design_param_updates[2] = importance_factor

    explicit_design_params = _as_dict(analysis_control.get("design_params"))
    pkpm_design_params = _as_dict(explicit_design_params.get("pkpm"))
    satwe_indices = _as_dict(pkpm_design_params.get("satwe_indices"))
    for raw_index, raw_value in satwe_indices.items():
        try:
            index = int(raw_index)
        except (TypeError, ValueError):
            continue
        value = _as_float(raw_value)
        if value is not None:
            design_param_updates[index] = value

    for key, value in sorted(project_para_updates_int.items()):
        try:
            para.SetParaInt(key, value)
        except Exception as exc:
            sys.stderr.write(f"[pkpm_converter] ProjectPara.SetParaInt({key}, {value}) failed: {exc}\n")
    for key, value in sorted(project_para_updates_double.items()):
        try:
            para.SetParaDouble(key, value)
        except Exception as exc:
            sys.stderr.write(f"[pkpm_converter] ProjectPara.SetParaDouble({key}, {value}) failed: {exc}\n")
    if project_para_updates_int or project_para_updates_double:
        try:
            model.SaveProjectPara()
        except Exception as exc:
            sys.stderr.write(f"[pkpm_converter] SaveProjectPara failed: {exc}\n")

    if not design_param_updates:
        return

    try:
        design_params = list(model.GetAllDesignPara())
    except Exception:
        design_params = []
    if len(design_params) < 128:
        design_params.extend([0.0] * (128 - len(design_params)))
    for index, value in sorted(design_param_updates.items()):
        if 0 <= index < len(design_params):
            design_params[index] = value

    try:
        model.SetAllDesignPara(design_params)
        return
    except Exception as exc:
        sys.stderr.write(f"[pkpm_converter] SetAllDesignPara failed: {exc}\n")

    for index, value in sorted(design_param_updates.items()):
        try:
            model.SetOneDesignParaValue(index, value)
        except Exception as exc:
            sys.stderr.write(f"[pkpm_converter] SetOneDesignParaValue({index}, {value}) failed: {exc}\n")


def _log_design_params(model: APIPyInterface.Model) -> None:
    """Log meaningful SATWE design parameters for diagnostic index discovery."""
    try:
        all_params = model.GetAllDesignPara()
        for i, v in enumerate(all_params):
            # Skip garbage/uninitialized values (extremely large or zero)
            if abs(v) > 0.001 and abs(v) < 1e10:
                sys.stderr.write(f"[pkpm_satwe_param] index={i}, value={v}\n")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Element default steel grade fallback
# ---------------------------------------------------------------------------

def _elem_grade(elem: dict, mat_id_to_grade: dict[str, str]) -> Any:
    """Resolve steel grade for one element."""
    grade = elem.get("steel_grade") or mat_id_to_grade.get(elem.get("material", ""))
    if not isinstance(grade, str) or not grade.strip():
        raise ValueError(f"PKPM steel element '{elem.get('id')}' requires an explicit material grade")
    return _resolve_steel_grade(grade)


def _elem_concrete_grade(elem: dict, mat_id_to_grade: dict[str, str]) -> Any:
    """Resolve concrete grade for one element."""
    grade = elem.get("concrete_grade") or mat_id_to_grade.get(elem.get("material", ""))
    if not isinstance(grade, str) or not grade.strip():
        raise ValueError(f"PKPM concrete element '{elem.get('id')}' requires an explicit material grade")
    return _resolve_concrete_grade(grade)


def _nonnegative_float(value: Any, *, field: str, story_id: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Story '{story_id}' {field} must be a finite nonnegative number") from error
    if not math.isfinite(number) or number < 0:
        raise ValueError(f"Story '{story_id}' {field} must be a finite nonnegative number")
    return number


def _story_dead_live_pair(story: dict[str, Any]) -> tuple[float, float]:
    story_id = str(story.get("id", ""))
    return (
        _nonnegative_float(story.get("dead_load") or 0.0, field="dead_load", story_id=story_id),
        _nonnegative_float(story.get("live_load") or 0.0, field="live_load", story_id=story_id),
    )


def _coordinate_key(x: Any, y: Any) -> tuple[float, float]:
    """Return a stable millimetre plan-coordinate key for PKPM entities."""
    return (round(float(x), 6), round(float(y), 6))


def refresh_result_mappings(
    jws_path: Path,
    mappings: dict[str, Any],
) -> dict[str, Any]:
    """Reopen the completed native model and match IDs by floor and geometry."""
    model = APIPyInterface.Model()
    if model.OpenPMModel(str(jws_path)) == 0:
        raise RuntimeError(f"Failed to reopen completed PKPM model '{jws_path}' for result mapping")

    floor_load_mapping = mappings.get("floor_load_mapping", [])
    stories = mappings.get("stories", [])
    standard_floor_by_natural_floor = {
        index + 1: int(item["stand_floor_index"])
        for index, item in enumerate(floor_load_mapping)
    }
    used_standard_floors = sorted(set(standard_floor_by_natural_floor.values()))
    snapshots: dict[int, dict[str, dict[Any, int]]] = {}

    for standard_floor_index in used_standard_floors:
        model.SetCurrentStandFloor(standard_floor_index)
        floor = model.GetCurrentStandFloor()
        node_xy_by_id = {
            int(node.GetID()): _coordinate_key(*node.Get())
            for node in floor.GetNodes()
        }
        node_by_xy = {xy: node_id for node_id, xy in node_xy_by_id.items()}
        if len(node_by_xy) != len(node_xy_by_id):
            raise RuntimeError(f"PKPM standard floor {standard_floor_index} has duplicate plan nodes")

        columns_by_xy: dict[tuple[float, float], int] = {}
        for column in floor.GetColumns():
            segment = column.GetSeg()
            node_id = int(segment[0])
            if node_id not in node_xy_by_id:
                raise RuntimeError(
                    f"PKPM column {column.GetID()} references unknown plan node {node_id}"
                )
            columns_by_xy[node_xy_by_id[node_id]] = int(column.GetID())

        beams_by_endpoints: dict[tuple[tuple[float, float], tuple[float, float]], int] = {}
        for beam in floor.GetBeams():
            segment = beam.GetSeg()
            net = floor.GetNet(int(segment[0]))
            start_id, end_id = (int(value) for value in net.GetLine())
            if start_id not in node_xy_by_id or end_id not in node_xy_by_id:
                raise RuntimeError(f"PKPM beam {beam.GetID()} references unknown plan nodes")
            endpoints = tuple(sorted((node_xy_by_id[start_id], node_xy_by_id[end_id])))
            beams_by_endpoints[endpoints] = int(beam.GetID())

        snapshots[standard_floor_index] = {
            "nodes": node_by_xy,
            "columns": columns_by_xy,
            "beams": beams_by_endpoints,
        }

    story_tops = [float(story.get("elevation", 0)) + float(story["height"]) for story in stories]
    v2_node_z = mappings.get("v2_node_z", {})
    v2_to_xy = mappings.get("v2_to_xy", {})

    def natural_floor_for_node(node_id: str) -> int:
        z = float(v2_node_z[node_id])
        if abs(z) <= 1e-6:
            return 0
        matches = [index + 1 for index, top in enumerate(story_tops) if abs(z - top) <= 1e-6]
        if len(matches) != 1:
            raise RuntimeError(f"V2 node '{node_id}' does not map uniquely to a PKPM natural floor")
        return matches[0]

    refreshed_nodes = dict(mappings.get("v2_to_pm", {}))
    for node_id, xy_value in v2_to_xy.items():
        natural_floor = natural_floor_for_node(node_id)
        if natural_floor == 0:
            continue
        standard_floor = standard_floor_by_natural_floor[natural_floor]
        xy = _coordinate_key(*xy_value)
        pmid = snapshots[standard_floor]["nodes"].get(xy)
        if pmid is None:
            raise RuntimeError(f"PKPM standard floor {standard_floor} is missing V2 node '{node_id}'")
        refreshed_nodes[node_id] = pmid

    refreshed_elements = {
        element_id: dict(info)
        for element_id, info in mappings.get("elem_map", {}).items()
    }
    for element_id, info in refreshed_elements.items():
        node_ids = [str(node_id) for node_id in info.get("floor_nodes", [])]
        if len(node_ids) != 2:
            raise RuntimeError(f"PKPM element '{element_id}' does not have two mapped endpoints")
        natural_floor = max(natural_floor_for_node(node_id) for node_id in node_ids)
        standard_floor = standard_floor_by_natural_floor[natural_floor]
        snapshot = snapshots[standard_floor]
        endpoint_xy = [_coordinate_key(*v2_to_xy[node_id]) for node_id in node_ids]
        if info.get("type") == "col":
            pmid = snapshot["columns"].get(endpoint_xy[-1])
        else:
            pmid = snapshot["beams"].get(tuple(sorted(endpoint_xy)))
        if pmid is None:
            raise RuntimeError(
                f"PKPM standard floor {standard_floor} is missing V2 element '{element_id}'"
            )
        info["pmid"] = pmid

    return {
        **mappings,
        "v2_to_pm": refreshed_nodes,
        "elem_map": refreshed_elements,
    }


# ---------------------------------------------------------------------------
# Main converter
# ---------------------------------------------------------------------------

def convert_v2_to_jws(
    data: dict,
    work_dir: Path,
    project_name: str,
    material_family: str = "steel",
) -> tuple[Path, dict[str, Any]]:
    """
    Convert V2 StructureModelV2 JSON dict to a PKPM JWS file.

    Args:
        data:         Parsed V2 JSON (dict).
        work_dir:     Directory where PKPM will write JWS and support files.
        project_name: Base name for the JWS project (no extension).

    Returns:
        (jws_path, mappings) where mappings contains:
          - v2_to_pm: {v2_node_id: pkpm_plan_node_id}
          - v2_node_z: {v2_node_id: z_coordinate_m}
          - elem_map: {v2_elem_id: {pmid, type, floor_nodes}}

    Raises:
        ImportError:  If APIPyInterface is not available.
        ValueError:   If required model data is missing.
        RuntimeError: If PKPM API reports an error.
    """
    validate_coordinate_contract(data)
    if resolve_model_dimension(data) != "3d":
        raise AnalysisCapabilityError(
            engine="pkpm",
            capability="canonical-3d-building-model",
            reason="PKPM floor-model conversion requires a genuine canonical 3-D model",
        )
    validate_pkpm_material_properties(data)
    validate_pkpm_sections(data)
    work_dir = work_dir.resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    jws_path = work_dir / f"{project_name}.JWS"
    data, normalization = _normalize_generic_frame_for_pkpm(data)
    validate_execution_settings(data)
    _validate_story_derived_loads(data)

    # ---- Setup ----
    model = APIPyInterface.Model()
    model.CreatNewModel(str(work_dir), project_name)
    model.OpenPMModel(str(jws_path))

    # ---- Material → grade lookup ----
    mat_id_to_grade: dict[str, str] = {}
    for mat in data.get("materials", []):
        grade = mat.get("grade") or mat.get("name")
        if isinstance(grade, str) and grade.strip():
            mat_id_to_grade[mat["id"]] = grade

    # ---- Design parameters from V2 model ----
    site_seismic = _as_dict(data.get("site_seismic"))
    structure_system = _as_dict(data.get("structure_system"))
    analysis_control = _as_dict(data.get("analysis_control"))
    wind = _as_dict(data.get("wind"))
    try:
        damping_ratio = float(site_seismic.get("damping_ratio", 0.0))
    except (TypeError, ValueError):
        damping_ratio = 0.0

    # ---- Sections ----
    sec_registry = _build_section_registry(model, data.get("sections", []), data, material_family)

    # Compile each natural floor independently.  The native floor stores the
    # joints at its top and columns down to the preceding elevation.
    nodes = data.get("nodes", [])
    node_by_id = {str(node["id"]): node for node in nodes}
    stories = data["stories"]
    v2_to_pm: dict[str, int] = {}
    v2_to_xy = {
        str(node["id"]): (float(node["x"]) * 1000, float(node["y"]) * 1000)
        for node in nodes
    }
    elem_map: dict[str, dict[str, Any]] = {}
    floor_load_mapping: list[dict[str, Any]] = []
    for story_index, story in enumerate(stories, 1):
        if story_index == 1:
            standard_floor_index = 1
        else:
            standard_floor_index = model.AddStandFloor()
            if not isinstance(standard_floor_index, int) or standard_floor_index <= 1:
                raise RuntimeError("PKPM AddStandFloor did not create an independent standard floor")
        model.SetCurrentStandFloor(standard_floor_index)
        floor = model.GetCurrentStandFloor()
        top = float(story["elevation"]) + float(story["height"])
        floor_nodes = [node for node in nodes if abs(float(node["z"]) - top) <= 1e-6]
        floor_node_ids, _ = _build_plan_nodes(floor, floor_nodes)
        v2_to_pm.update(floor_node_ids)
        floor_elements = [
            element for element in data["elements"]
            if abs(max(float(node_by_id[str(nid)]["z"]) for nid in element["nodes"]) - top) <= 1e-6
        ]
        for element in floor_elements:
            element_id = str(element["id"])
            node_ids = [str(nid) for nid in element["nodes"]]
            section_id = element["section"]
            if section_id not in sec_registry:
                raise ValueError(f"PKPM element '{element_id}' references an unregistered section '{section_id}'")
            role, pm_section = sec_registry[section_id]
            if element["type"] == "column":
                if role != "col":
                    raise ValueError(f"PKPM column '{element_id}' requires a column section")
                member = floor.AddColumn(pm_section, floor_node_ids[node_ids[1]])
                if story_index == 1:
                    v2_to_pm[node_ids[0]] = floor_node_ids[node_ids[1]]
                    restraints = tuple(node_by_id[node_ids[0]].get("restraints") or [])
                    if restraints == (True, True, True, False, False, False):
                        member.SetSpecial(APIPyInterface.SpecialColumn.IDSp_Constrain_Support, 1.0)
            else:
                if role != "beam":
                    raise ValueError(f"PKPM beam '{element_id}' requires a beam section")
                # Preserve endpoint order, including reversed/non-orthogonal beams.
                net = floor.AddLineNet(floor_node_ids[node_ids[0]], floor_node_ids[node_ids[1]])
                member = floor.AddBeamEx(pm_section, net.GetID(), 0, 0, 0, 0.0)
            if material_family == "steel":
                member.SetSteelGrade(_elem_grade(element, mat_id_to_grade))
            else:
                member.SetConcreteGrade(_elem_concrete_grade(element, mat_id_to_grade))
            elem_map[element_id] = {
                "pmid": _require_member_id(member, element_id=element_id, member_type=element["type"]),
                "type": role,
                "floor_nodes": node_ids,
                "natural_floor": story_index,
                "standard_floor": standard_floor_index,
                "native_endpoint_order": node_ids,
            }
        dead_load, live_load = _story_dead_live_pair(story)
        floor.SetDeadLive(dead_load, live_load)
        floor_load_mapping.append({
            "story": story["id"], "stand_floor_index": standard_floor_index,
            "dead_load": dead_load, "live_load": live_load,
        })
        real_floor = APIPyInterface.RealFloor()
        real_floor.SetFloorHeight(float(story["height"]) * 1000.0)
        real_floor.SetBottomElevation(float(story["elevation"]))
        real_floor.SetStandFloorIndex(standard_floor_index)
        model.AddNaturalFloor(real_floor)

    # ---- Configure SATWE design parameters ----
    _configure_satwe_params(model, material_family, site_seismic, wind, analysis_control)
    if os.environ.get("PKPM_DEBUG_PARAMS"):
        _log_design_params(model)

    model.SavePMModel()

    # Reapply loads after initial materialization: installed API versions can
    # reset standard-floor load fields on the first save.
    standard_floor_loads: dict[int, tuple[float, float]] = {}
    for item in floor_load_mapping:
        standard_floor_index = int(item["stand_floor_index"])
        load_pair = (float(item["dead_load"]), float(item["live_load"]))
        previous = standard_floor_loads.get(standard_floor_index)
        if previous is not None and previous != load_pair:
            raise RuntimeError(
                f"PKPM standard floor {standard_floor_index} has conflicting story loads"
            )
        standard_floor_loads[standard_floor_index] = load_pair
    for standard_floor_index, (dead_load, live_load) in sorted(standard_floor_loads.items()):
        model.SetCurrentStandFloor(standard_floor_index)
        model.GetCurrentStandFloor().SetDeadLive(dead_load, live_load)
    model.SetCurrentStandFloor(1)
    _configure_satwe_params(model, material_family, site_seismic, wind, analysis_control)
    model.SavePMModel()
    return jws_path, {
        "v2_to_pm": v2_to_pm,
        "v2_to_xy": v2_to_xy,
        "v2_node_z": {n["id"]: float(n.get("z", 0)) for n in nodes},
        "elem_map": elem_map,
        "stories": stories,
        "normalization": normalization,
        "material_family": material_family,
        "floor_load_mapping": floor_load_mapping,
        "design_conditions": {
            "site_seismic": site_seismic,
            "wind": wind,
            "analysis_control": analysis_control,
        },
    }
