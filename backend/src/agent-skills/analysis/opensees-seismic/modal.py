from __future__ import annotations

from opensees_shared.errors import OpenSeesInputError, OpenSeesMissingInputError, OpenSeesCapabilityError

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from coordinate_semantics import (
    build_element_local_axes,
    coordinate_contract_metadata,
    get_model_metadata,
    get_reference_vector,
    resolve_model_dimension,
    validate_coordinate_contract,
)
from design_basis import SeismicDesignBasis, model_payload
from seismic_contracts import optional_number

G_ACCEL = 9.80665
FRAME_LINE_ELEMENT_TYPES = {"beam", "column"}
WALL_LINE_ELEMENT_TYPES = {
    "wall",
    "shear-wall",
    "shear_wall",
    "seismic-wall",
    "seismic_wall",
    "structural-wall",
    "structural_wall",
    "rc-wall",
    "concrete-wall",
}
OPENSEES_LINE_ELEMENT_TYPES = FRAME_LINE_ELEMENT_TYPES | WALL_LINE_ELEMENT_TYPES


@dataclass
class ModalAnalysis:
    modes: List[Dict[str, Any]]
    total_mass: float
    floor_masses: List[Dict[str, float]]
    model_dimension: str
    direction: str
    engine_mode: str
    warnings: List[str] = field(default_factory=list)
    coordinate_contract: Dict[str, Any] = field(default_factory=dict)
    execution: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "modes": self.modes,
            "totalMass": self.total_mass,
            "floorMasses": self.floor_masses,
            "modelDimension": self.model_dimension,
            "direction": self.direction,
            "engineMode": self.engine_mode,
            "warnings": self.warnings,
            "coordinateContract": self.coordinate_contract,
            "execution": self.execution,
        }


def _field(record: Any, key: str, default: Any = None) -> Any:
    if isinstance(record, dict):
        return record.get(key, default)
    return getattr(record, key, default)


def _element_type(element: Any) -> str:
    return str(_field(element, "type", "") or "").strip().lower()


def _is_opensees_line_element_type(element_type: str) -> bool:
    return element_type in OPENSEES_LINE_ELEMENT_TYPES


def _is_wall_line_element_type(element_type: str) -> bool:
    return element_type in WALL_LINE_ELEMENT_TYPES


def _records(payload: Dict[str, Any], model: Any, key: str) -> List[Any]:
    value = payload.get(key)
    if isinstance(value, list):
        return value
    return list(getattr(model, key, []) or [])


def _node_key(node: Any) -> str:
    return str(_field(node, "id"))


def _element_nodes(element: Any) -> List[str]:
    nodes = _field(element, "nodes", [])
    return [str(item) for item in nodes] if isinstance(nodes, list) else []


def _section_map(sections: List[Any]) -> Dict[str, Any]:
    return {str(_field(section, "id")): section for section in sections}


def _material_map(materials: List[Any]) -> Dict[str, Any]:
    return {str(_field(material, "id")): material for material in materials}


def _section_property(section: Any, name: str, default: float = 0.0) -> float:
    properties = _field(section, "properties", {}) or {}
    if isinstance(properties, dict):
        value = optional_number(properties.get(name))
        if value is not None:
            return float(value)
    value = optional_number(_field(section, name))
    return float(value) if value is not None else default


def _section_property_optional(section: Any, *names: str) -> Optional[float]:
    properties = _field(section, "properties", {}) or {}
    extra = _field(section, "extra", {}) or {}
    shape = _field(section, "shape", {}) or {}
    for source in (properties, section, extra, shape):
        for name in names:
            value = optional_number(_field(source, name))
            if value is not None:
                return float(value)
    return None


def _wall_dimensions_m(section: Any) -> Tuple[Optional[float], Optional[float]]:
    # V2 shape and legacy convenience fields are explicitly mm; suffixed M is m.
    shape = _field(section, 'shape', {}) or {}
    thickness_mm = optional_number(_field(shape, 'T')) or optional_number(_field(section, 'thickness'))
    thickness = thickness_mm/1000 if thickness_mm is not None else _section_property_optional(section, 'thickness_m', 'wallThicknessM')
    wall_length = _section_property_optional(section, 'wallLengthM', 'wall_length_m')
    if wall_length is None:
        length_mm = _section_property_optional(section, 'wallLengthMm')
        wall_length = length_mm/1000 if length_mm is not None else None
    area = _section_property_optional(section, "A", "area")
    if wall_length is None and thickness is not None and area is not None and area > 0.0:
        wall_length = area / thickness
    return thickness, wall_length


def _effective_section_properties(element_type: str, section: Any) -> Tuple[float, float, float, float]:
    area = _section_property(section, "A")
    iy = _section_property(section, "Iy")
    iz = _section_property(section, "Iz")
    j = _section_property(section, "J")
    if not _is_wall_line_element_type(element_type):
        return area, iy, iz, j

    thickness, wall_length = _wall_dimensions_m(section)
    if thickness is None or wall_length is None:
        return area, iy, iz, j

    derived_area = thickness * wall_length
    derived_iy = thickness * (wall_length ** 3) / 12.0
    derived_iz = wall_length * (thickness ** 3) / 12.0
    derived_j = max(derived_area * min(thickness, wall_length) ** 2 / 12.0, 1e-8)
    return (
        _section_property_optional(section, "A", "area") or derived_area,
        _section_property_optional(section, "Iy") or derived_iy,
        _section_property_optional(section, "Iz") or derived_iz,
        _section_property_optional(section, "J") or derived_j,
    )


def _material_e(material: Any, section: Any) -> float:
    value = optional_number(_field(material, "E"))
    if value is None or not math.isfinite(float(value)) or float(value) <= 0.0:
        raise OpenSeesInputError("Seismic OpenSees analysis requires a finite material E > 0")
    # StructureClaw material records store MPa for concrete/steel. Convert MPa to kN/m2.
    return float(value) * 1000.0


def _material_g(material: Any, section: Any) -> float:
    elastic_modulus = _material_e(material, section)
    poisson_ratio = optional_number(_field(material, "nu"))
    if (
        poisson_ratio is None
        or not math.isfinite(float(poisson_ratio))
        or float(poisson_ratio) < 0.0
        or float(poisson_ratio) > 0.5
    ):
        raise OpenSeesInputError("Seismic OpenSees analysis requires finite material 0 <= nu <= 0.5")
    return elastic_modulus / (2.0 * (1.0 + float(poisson_ratio)))


def _floor_levels(nodes: List[Any]) -> List[float]:
    levels = sorted({round(float(_field(node, "z", 0.0) or 0.0), 6) for node in nodes})
    if not levels:
        return []
    base = min(levels)
    return [level for level in levels if level > base + 1e-9]


def compute_floor_masses(payload, model, dimension):
    from opensees_shared.mass import assemble_mass
    assembly = assemble_mass(model)
    return assembly['floorMasses'], []


def _restraints_for_node(node, dimension):
    values = [int(bool(v)) for v in (_field(node, 'restraints') or [False]*6)]
    return [values[0], values[2], values[4]] if dimension == '2d' else values[:6]


def _assemble_opensees_model(ops: Any, payload: Dict[str, Any], model: Any, basis: SeismicDesignBasis, direction: str):
    from opensees_shared.model import OpenSeesModelBuilder
    from structure_protocol.structure_model_v2 import StructureModelV2

    original = model if isinstance(model, StructureModelV2) else StructureModelV2.model_validate(payload)
    elements = []
    sections = list(original.sections)
    section_map = {s.id: s for s in sections}
    for element in original.elements:
        if _is_wall_line_element_type(element.type):
            # Preserve the established equivalent LINE wall method, never imply a shell model.
            if len(element.nodes) != 2:
                raise OpenSeesCapabilityError('Seismic equivalent line-wall analysis requires two-node wall members')
            source = section_map[element.section]
            values = _effective_section_properties(element.type, source)
            section_id = f'__seismic_wall__{element.id}'
            if section_id in section_map:
                raise OpenSeesInputError('Reserved equivalent wall section ID collision')
            section = source.model_copy(update={'id': section_id, 'properties': {
                **source.properties, **dict(zip(('A', 'Iy', 'Iz', 'J'), values))}})
            sections.append(section)
            elements.append(element.model_copy(update={'type': 'column', 'section': section_id}))
        else:
            elements.append(element)
    adapted = original.model_copy(update={'elements': elements, 'sections': sections})
    builder = OpenSeesModelBuilder(adapted)
    builder.effective_settings = builder.build(ops, mass=True)
    return builder


def _build_opensees_model(ops, payload, model, basis, direction):
    """Compatibility view for bounded pushover/time-history consumers of the shared builder."""
    builder = _assemble_opensees_model(ops, payload, model, basis, direction)
    return builder.dimension, builder._ops_node_tags, builder.mass_assembly['floorMasses']


def run_modal_analysis(model: Any, basis: SeismicDesignBasis, modal_count: int, direction: str = "x") -> ModalAnalysis:
    payload = model_payload(model)
    nodes = _records(payload, model, "nodes")
    if not nodes:
        raise RuntimeError("Cannot run seismic analysis without model nodes.")
    validate_coordinate_contract(model)
    dimension_contract = resolve_model_dimension(model)
    normalized_direction = str(direction or "x").strip().lower()
    allowed_directions = {"x"} if dimension_contract == "2d" else {"x", "y"}
    if normalized_direction not in allowed_directions:
        raise RuntimeError(
            f"Direction '{direction}' is inactive for a {dimension_contract} seismic model; "
            f"expected {', '.join(sorted(allowed_directions))}"
        )
    direction = normalized_direction

    try:
        import openseespy.opensees as ops
    except Exception as error:
        from contracts import EngineNotAvailableError
        raise EngineNotAvailableError("builtin-opensees", f"OpenSeesPy is not available: {error}") from error

    dimension = "unknown"
    try:
        builder = _assemble_opensees_model(ops, payload, model, basis, direction)
        from opensees_shared.modal import extract_modal
        result = extract_modal(builder, ops, modal_count, direction)
        execution = {"solver": "OpenSees", "solverVersion": ops.version(), "executed": True,
            "massSource": builder.mass_source, "massUnit": "tonne", "massAssembly": builder.mass_assembly,
            "effectiveSettings": builder.effective_settings,
            "wallModel": "equivalent-line-wall" if any(_is_wall_line_element_type(_element_type(e))
                for e in _records(payload, model, 'elements')) else None}
        ops.wipe()
        return ModalAnalysis(modes=result['modes'], total_mass=result['totalMass'],
            floor_masses=result['floorMasses'], model_dimension=builder.dimension,
            direction=direction, engine_mode='opensees_eigen', warnings=[],
            coordinate_contract=coordinate_contract_metadata(model), execution=execution)
    except OpenSeesInputError:
        ops.wipe()
        raise
    except Exception as error:
        ops.wipe()
        raise RuntimeError(f"OpenSees seismic modal execution failed; no approximate modes substituted: {error}") from error
