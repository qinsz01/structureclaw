"""Commercial input contracts; native adapters verify effective physics per run."""
from __future__ import annotations

import math
from typing import Any

from contracts import AnalysisCapabilityError


def validate_story_load_totals(data: dict[str, Any], engine: str) -> None:
    """Check explicitly declared area loads; a bounding box is never a floor.

    This validates duplicate-load bookkeeping only. Native transfer to members
    is a separate capability and must still pass the solver acceptance gate.
    """
    loads = [load for case in data.get("load_cases", []) for load in case.get("loads", [])
             if load.get("source") == "story_floor_loads"]
    if not loads:
        return
    nodes = {str(node["id"]): node for node in data.get("nodes", [])}
    stories = {str(story["id"]): story for story in data.get("stories", [])}

    def number(value: Any, field: str) -> float:
        if isinstance(value, bool):
            raise ValueError(f"{field} must be a finite number / 必须提供有限数值")
        try:
            result = float(value)
        except (TypeError, ValueError) as error:
            raise ValueError(f"{field} must be a finite number / 必须提供有限数值") from error
        if not math.isfinite(result):
            raise ValueError(f"{field} must be finite / 必须提供有限数值")
        return result

    totals: dict[tuple[str, str], float] = {}
    for load in loads:
        story_id, node_id = str(load.get("story", "")), str(load.get("node", ""))
        kind = str(load.get("load_kind", ""))
        if (load.get("source") != "story_floor_loads" or load.get("type") != "nodal"
                or load.get("reference_frame", "global") != "global" or kind not in {"dead", "live"}
                or story_id not in stories or node_id not in nodes):
            raise ValueError(f"{engine} story-derived loads require an existing story/node and dead/live kind / 楼面等效荷载须声明已有楼层、节点与恒活类别")
        if any(abs(number(load.get(key, 0), key)) > 1e-9 for key in ("fx", "fy", "mx", "my", "mz", "wx", "wy", "wz")):
            raise ValueError(f"{engine} story-derived loads must act only in negative global Z / 楼面等效荷载仅允许负 Z 方向")
        force = number(load.get("fz"), f"load on {node_id}.fz")
        if force > 1e-9:
            raise ValueError(f"{engine} story-derived gravity loads must act in negative global Z / 重力荷载方向错误")
        story = stories[story_id]
        top = number(story.get("elevation"), f"stories.{story_id}.elevation") + number(story.get("height"), f"stories.{story_id}.height")
        if abs(number(nodes[node_id].get("z"), f"nodes.{node_id}.z") - top) > 1e-6:
            raise ValueError(f"Story-derived load on node '{node_id}' targets the wrong global Z level / 荷载所属层错误")
        key = (story_id, kind)
        totals[key] = totals.get(key, 0.0) - force

    for story_id, story in stories.items():
        declared: dict[str, float] = {}
        for load in story.get("floor_loads", []):
            kind = load.get("type")
            if kind not in {"dead", "live"}:
                if number(load.get("value", 0), "floor load") != 0:
                    raise ValueError(f"Unsupported floor load type '{kind}' / 不支持的楼面荷载类型")
                continue
            if kind in declared:
                raise ValueError(f"Duplicate {kind} floor load on '{story_id}' / 楼面荷载重复")
            declared[kind] = number(load.get("value"), f"stories.{story_id}.floor_loads.{kind}")
        for kind in ("dead", "live"):
            if story.get(f"{kind}_load") is not None:
                value = number(story[f"{kind}_load"], f"stories.{story_id}.{kind}_load")
                if kind in declared and not math.isclose(value, declared[kind], rel_tol=1e-12, abs_tol=1e-12):
                    raise ValueError(f"Conflicting {kind} floor load on '{story_id}' / 楼面荷载来源冲突")
                declared[kind] = value
        if not any(declared.values()) and not any(totals.get((story_id, kind), 0) for kind in ("dead", "live")):
            continue
        if story.get("load_area_m2") is None:
            raise ValueError(f"stories.{story_id}.load_area_m2 is required; floor area cannot be inferred from a bounding box / 必须声明本层实际受荷面积，不能使用包围矩形猜测")
        area = number(story["load_area_m2"], f"stories.{story_id}.load_area_m2")
        if area <= 0:
            raise ValueError(f"stories.{story_id}.load_area_m2 must be positive / 本层受荷面积必须大于零")
        for kind in ("dead", "live"):
            expected, actual = declared.get(kind, 0) * area, totals.get((story_id, kind), 0)
            if not math.isclose(actual, expected, rel_tol=1e-9, abs_tol=1e-6):
                raise ValueError(f"Story '{story_id}' {kind} nodal-load total conflicts with {kind}_load and declared area / 等效荷载总量与本层荷载及受荷面积不一致")


def reject_native_input(engine: str, code: str, capability: str, fields: list[str], reason: str) -> None:
    error = AnalysisCapabilityError(engine=engine, capability=capability, reason=reason)
    error.error_code = code
    error.meta = {**getattr(error, "meta", {}), "failureKind": "capability-boundary", "engine": engine,
                  "capability": capability, "inputFields": fields}
    error.detail = {**getattr(error, "detail", {}), "engine": engine, "capability": capability,
                    "inputFields": fields, "reason": reason}
    raise error


def validate_pkpm_material_properties(data: dict[str, Any]) -> None:
    used = {str(item.get("material")) for item in data.get("elements", [])}
    identity = {"id", "name", "type", "grade", "category", "family", "code", "description", "extra", "E", "G", "nu", "rho"}
    fields = []
    for material in data.get("materials", []):
        if str(material.get("id")) not in used:
            continue
        prefix = f"materials.{material.get('id')}"
        if material.get("E") is not None:
            E, nu, rho = material.get("E"), material.get("nu"), material.get("rho")
            if any(type(value) not in (int, float) or not math.isfinite(value) for value in (E, nu, rho)) or E <= 0 or not (-1 < nu < .5) or rho <= 0:
                fields.append(prefix + ".isotropicConstants")
            elif material.get("G") is not None and not math.isclose(float(material["G"]), E / (2 * (1 + nu)), rel_tol=1e-10, abs_tol=0):
                fields.append(prefix + ".G")
        elif any(material.get(key) is not None for key in ("G", "nu", "rho")):
            fields.append(prefix + ".E")
        fields.extend(f"{prefix}.{key}" for key, value in material.items()
                      if key not in identity and value is not None)
        # Extra fields have no native setter. Do not interpret them as harmless
        # overrides or infer native equivalence from a nominal grade table.
        fields.extend(f"{prefix}.extra.{key}" for key, value in (material.get("extra") or {}).items()
                      if value is not None)
    fields.extend(f"elements.{item.get('id')}.rebar_grade" for item in data.get("elements", [])
                  if item.get("rebar_grade") is not None)
    if fields:
        reject_native_input(
            "pkpm", "PKPM_NATIVE_MATERIAL_PROPERTIES_UNVERIFIED", "native-material-properties", fields,
            "PKPM custom materials preserve isotropic E/nu/rho. These inconsistent or design fields "
            "have no accepted native mapping: " + ", ".join(fields) +
            " / 原生自定义材料保持各向同性 E/nu/rho；所列矛盾或设计字段尚无已验收映射。",
        )


def pkpm_numeric_section_properties(section: dict[str, Any]) -> dict[str, float] | None:
    """Pure mechanical source section; never infer a physical carrier shape."""
    if str(section.get("type", "")).lower() != "custom" or section.get("shape"):
        return None
    prefix = f"sections.{section.get('id')}"
    props = section.get("properties") or {}
    allowed = {"A", "Iy", "Iz", "J", "Asy", "Asz"}
    if (section.get("standard_steel_name") or section.get("extra")
            or any(section.get(key) is not None for key in ("width", "height", "thickness", "diameter"))
            or any(section.get(key) is not None for key in ("I", "Iyy", "Izz"))
            or set(props) - allowed):
        reject_native_input("pkpm", "PKPM_NUMERIC_SECTION_CONFLICT", "numeric-section",
                            [prefix], "Numeric sections cannot declare geometric overrides / 数值截面不能混入几何覆盖")
    values = {}
    for key in ("A", "Iy", "Iz", "J"):
        value = props.get(key)
        if (type(value) not in (int, float) or not math.isfinite(value) or value <= 0
                or (section.get(key) is not None and section[key] != value)):
            reject_native_input("pkpm", "PKPM_NUMERIC_SECTION_INVALID", "numeric-section",
                                [f"{prefix}.{key}"], "A/Iy/Iz/J must be explicit, positive and consistent / A/Iy/Iz/J须明确、为正且无冲突")
        values[key] = float(value)
    for key in ("Asy", "Asz"):
        expected = 5 * values["A"] / 6
        value = props.get(key, expected)
        if (type(value) not in (int, float) or not math.isclose(value, expected, rel_tol=1e-12, abs_tol=0)
                or (section.get(key) is not None and section[key] != value)):
            reject_native_input("pkpm", "PKPM_NUMERIC_SHEAR_AREA_UNSUPPORTED", "numeric-section-shear-area",
                                [f"{prefix}.{key}"], "Calibrated numeric sections require Asy=Asz=5A/6 / 已校准数值截面要求Asy=Asz=5A/6")
        values[key] = float(value)
    return values


def pkpm_section_shape(section: dict[str, Any], schema_version: str = "2.0.0") -> dict[str, Any] | None:
    """Validate the geometry actually written; shape/top-level dimensions are mm.

    The only retained legacy geometry contract is V2.0 rectangular properties
    width/height in metres. No magnitude-based unit guessing is permitted.
    """
    if pkpm_numeric_section_properties(section) is not None:
        return None
    prefix = f"sections.{section.get('id')}"

    def reject(fields: list[str], reason: str, code: str = "PKPM_NATIVE_SECTION_INPUT_UNSUPPORTED") -> None:
        reject_native_input("pkpm", code, "native-section-properties", fields,
                            reason + " / 截面输入没有已验收的原生等价映射，不能静默忽略或改写。")

    props = section.get("properties") or {}
    legacy_geometry = {"width", "height", "b", "h", "B", "H"}
    native_checked = {"A", "Iy", "Iz", "J"} if section.get("shape") else set()
    unsupported = [f"{prefix}.properties.{key}" for key, value in props.items()
                   if value is not None and key not in legacy_geometry | native_checked]
    unsupported += [f"{prefix}.{key}" for key in ("A", "I", "Iy", "Iz", "Iyy", "Izz", "J", "Asy", "Asz")
                    if section.get(key) is not None and key not in native_checked]
    unsupported += [f"{prefix}.extra.{key}" for key, value in (section.get("extra") or {}).items()
                    if value is not None]
    if unsupported:
        reject(unsupported, "Explicit section properties have no accepted native calibration",
               "PKPM_NATIVE_SECTION_PROPERTIES_UNVERIFIED")

    shape = dict(section.get("shape") or {})
    standard = section.get("standard_steel_name")
    if standard:
        fields = ([f"{prefix}.shape"] if shape else []) + ([f"{prefix}.properties"] if props else [])
        fields += [f"{prefix}.{key}" for key in ("width", "height", "thickness", "diameter")
                   if section.get(key) is not None]
        if fields:
            reject(fields, "A native standard section cannot also specify unverified geometry overrides")
        return None

    geometry_props = {key: value for key, value in props.items() if key in legacy_geometry}
    if geometry_props:
        if shape or not str(schema_version).startswith("2.0."):
            reject([f"{prefix}.properties"], "Legacy property dimensions are allowed only for V2.0 without shape; use shape in mm")
        if str(section.get("type", "")).lower() not in {"rectangular", "rectangle", "rect"}:
            reject([f"{prefix}.type"], "Only legacy rectangular property dimensions are supported")
        dimensions = {}
        for canonical, keys in (("B", ("width", "b", "B")), ("H", ("height", "h", "H"))):
            values = [geometry_props[key] for key in keys if geometry_props.get(key) is not None]
            if len(values) != 1:
                reject([f"{prefix}.properties.{key}" for key in keys], "Specify one unambiguous legacy dimension")
            dimensions[canonical] = float(values[0]) * 1000.0
        shape = {"kind": "Rectangle", **dimensions}
    elif not shape and str(section.get("type", "")).lower() in {"rectangular", "rectangle", "rect"}:
        shape = {"kind": "Rectangle", "B": section.get("width"), "H": section.get("height")}
    if not shape:
        reject([prefix], "A supported explicit shape or native standard section is required")

    aliases = {"rectangle": "Rectangle", "rectangular": "Rectangle", "h": "H", "i": "H",
               "box": "Box", "tube": "Tube", "pipe": "Tube", "hollow-circular": "Tube",
               "circle": "Circle", "circular": "Circle"}
    kind = aliases.get(str(shape.get("kind", "")).lower())
    dimensions_by_kind = {"Rectangle": ("B", "H"), "H": ("B", "H", "tw", "tf"),
                          "Box": ("B", "H", "T"), "Tube": ("D", "T"), "Circle": ("D",)}
    if kind not in dimensions_by_kind:
        reject([f"{prefix}.shape.kind"], "Unsupported native section kind")
    canonical = {"kind": kind}
    expected = dimensions_by_kind[kind]
    allowed = {"kind"}
    for key in expected:
        keys = (key, key.lower()) if key.lower() != key else (key,)
        allowed.update(keys)
        values = [shape[name] for name in keys if shape.get(name) is not None]
        if not values or any(value != values[0] for value in values):
            reject([f"{prefix}.shape.{key}"], "Missing or conflicting section dimensions")
        value = float(values[0])
        if not math.isfinite(value) or value <= 0 or abs(value - round(value)) > 1e-8:
            reject([f"{prefix}.shape.{key}"], "Native section dimensions must be positive integer mm; rounding is not allowed")
        canonical[key] = value
    unknown = [f"{prefix}.shape.{key}" for key, value in shape.items() if key not in allowed and value is not None]
    if unknown:
        reject(unknown, "Shape fields would not be written by the native converter")
    if kind in {"Box", "Tube"} and 2 * canonical["T"] >= min(canonical[key] for key in expected if key != "T"):
        reject([f"{prefix}.shape.T"], "Wall thickness must leave a positive void")
    if kind == "H" and (2 * canonical["tf"] >= canonical["H"] or canonical["tw"] >= canonical["B"]):
        reject([f"{prefix}.shape"], "Flanges and web must leave a positive clear section")
    for name, key in (("width", "B"), ("height", "H"), ("thickness", "T"), ("diameter", "D")):
        if section.get(name) is not None and section[name] != canonical.get(key):
            reject([f"{prefix}.{name}"], "Top-level mm dimensions conflict with the written shape")
    return canonical


def validate_pkpm_sections(data: dict[str, Any]) -> None:
    for section in data.get("sections", []):
        pkpm_section_shape(section, str(data.get("schema_version", "2.0.0")))
    fields = []
    for item in data.get("elements", []):
        if item.get("seismic_grade") is not None:
            fields.append(f"elements.{item.get('id')}.seismic_grade")
        fields.extend(f"elements.{item.get('id')}.extra.{key}" for key, value in (item.get("extra") or {}).items()
                      if value is not None)
    for item in data.get("nodes", []):
        if item.get("mass") is not None:
            fields.append(f"nodes.{item.get('id')}.mass")
        fields.extend(f"nodes.{item.get('id')}.extra.{key}" for key, value in (item.get("extra") or {}).items()
                      if value is not None)
    if fields:
        reject_native_input(
            "pkpm", "PKPM_NATIVE_MEMBER_NODE_PROPERTIES_UNSUPPORTED", "native-member-node-properties", fields,
            "Native mapping is not implemented for these member/node properties: " + ", ".join(fields) +
            " / 这些构件或节点属性尚未实现原生映射，不能忽略。",
        )
