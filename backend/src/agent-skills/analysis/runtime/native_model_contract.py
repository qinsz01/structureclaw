"""Commercial input gates. Compilation is not evidence of native physics parity.

No numeric material/section-property calibration has been accepted yet. Keep
the grade + geometry compiler usable, but never silently discard an explicit
stiffness, density, strength or section-property request.
"""
from __future__ import annotations

import math
from typing import Any

from contracts import AnalysisCapabilityError


def reject_native_input(engine: str, code: str, capability: str, fields: list[str], reason: str) -> None:
    error = AnalysisCapabilityError(engine=engine, capability=capability, reason=reason)
    error.error_code = code
    error.meta = {**getattr(error, "meta", {}), "failureKind": "capability-boundary", "engine": engine,
                  "capability": capability, "inputFields": fields}
    error.detail = {**getattr(error, "detail", {}), "engine": engine, "capability": capability,
                    "inputFields": fields, "reason": reason}
    raise error


def require_yjk_material_acceptance(data: dict[str, Any]) -> None:
    fields = [f"materials.{item.get('id')}.grade" for item in data.get("materials", [])]
    reject_native_input(
        "yjk", "YJK_NATIVE_MATERIAL_GRADE_UNVERIFIED", "native-material-grade", fields,
        "YJK compilation writes the material category only; per-member grade and numeric material "
        "properties have not passed native write/readback acceptance. Formal analysis is disabled. / "
        "YJK 编译目前仅写入材料类别，逐构件牌号与材料常数未完成原生写入回读验收，正式分析暂不可用。",
    )


def validate_pkpm_material_properties(data: dict[str, Any]) -> None:
    used = {str(item.get("material")) for item in data.get("elements", [])}
    identity = {"id", "name", "grade", "category", "family", "code", "description", "extra"}
    fields = []
    for material in data.get("materials", []):
        if str(material.get("id")) not in used:
            continue
        prefix = f"materials.{material.get('id')}"
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
            "PKPM currently writes native member grades only. Explicit material constants, strengths "
            "and reinforcement grades have no accepted native mapping/calibration: " + ", ".join(fields) +
            ". Formal V2 inputs require E/nu/rho, so formal V2 analysis is blocked pending acceptance. / "
            "PKPM 当前只写入原生构件材料牌号，显式材料常数、强度及钢筋牌号尚无已验收映射或校准；"
            "正式 V2 输入要求 E/nu/rho，因此正式分析需待原生验收后开放。",
        )


def pkpm_section_shape(section: dict[str, Any], schema_version: str = "2.0.0") -> dict[str, Any] | None:
    """Validate the geometry actually written; shape/top-level dimensions are mm.

    The only retained legacy geometry contract is V2.0 rectangular properties
    width/height in metres. No magnitude-based unit guessing is permitted.
    """
    prefix = f"sections.{section.get('id')}"

    def reject(fields: list[str], reason: str, code: str = "PKPM_NATIVE_SECTION_INPUT_UNSUPPORTED") -> None:
        reject_native_input("pkpm", code, "native-section-properties", fields,
                            reason + " / 截面输入没有已验收的原生等价映射，不能静默忽略或改写。")

    props = section.get("properties") or {}
    legacy_geometry = {"width", "height", "b", "h", "B", "H"}
    unsupported = [f"{prefix}.properties.{key}" for key, value in props.items()
                   if value is not None and key not in legacy_geometry]
    unsupported += [f"{prefix}.{key}" for key in ("A", "I", "Iy", "Iz", "Iyy", "Izz", "J", "Asy", "Asz")
                    if section.get(key) is not None]
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

    if props:
        if shape or not str(schema_version).startswith("2.0."):
            reject([f"{prefix}.properties"], "Legacy property dimensions are allowed only for V2.0 without shape; use shape in mm")
        if str(section.get("type", "")).lower() not in {"rectangular", "rectangle", "rect"}:
            reject([f"{prefix}.type"], "Only legacy rectangular property dimensions are supported")
        dimensions = {}
        for canonical, keys in (("B", ("width", "b", "B")), ("H", ("height", "h", "H"))):
            values = [props[key] for key in keys if props.get(key) is not None]
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
