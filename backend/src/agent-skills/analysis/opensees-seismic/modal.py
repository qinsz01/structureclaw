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


def compute_floor_masses(payload: Dict[str, Any], model: Any, dimension: str) -> Tuple[List[Dict[str, float]], List[str]]:
    """Require an explicit seismic mass or an explicit area and representative floor load.

    No guessed 8 kN/m2, 1 m strip, bounding rectangle or copied last-story mass.
    Story elevations describe their bottom; mass is attached to their ceiling nodes.
    """
    nodes = _records(payload, model, "nodes")
    levels = _floor_levels(nodes)
    stories = _records(payload, model, "stories")
    metadata = payload.get('metadata', {})
    masses = []
    if any(_field(n, 'mass') is not None for n in nodes):
        if _field(_field(model, 'analysis_control'), 'mass_source') == 'member-density':
            raise OpenSeesInputError('Explicit node.mass conflicts with member-density mass source')
        for index, level in enumerate(levels):
            at_level = [n for n in nodes if abs(float(_field(n, 'z', 0))-level) <= 1e-6]
            node_masses = {str(_field(n, 'id')): float(_field(n, 'mass') or 0) for n in at_level}
            mass = sum(node_masses.values())
            masses.append({'story': next((str(_field(n, 'story')) for n in at_level if _field(n, 'story')), f'F{index+1}'),
                'elevation': float(level), 'weightKN': mass*G_ACCEL, 'mass': mass,
                'source': 'explicit-node-mass', 'nodeMasses': node_masses})
        if sum(f['mass'] for f in masses) <= 0:
            raise OpenSeesMissingInputError('Seismic analysis requires positive explicit elevated node mass')
        return masses, []
    for level in levels:
        level_nodes = [n for n in nodes if abs(float(_field(n, 'z', 0))-level) <= 1e-6]
        story_ids = {str(_field(n, 'story')) for n in level_nodes if _field(n, 'story') is not None}
        candidates = [s for s in stories if str(_field(s, 'id')) in story_ids]
        if not candidates:
            candidates = [s for s in stories if _field(s, 'elevation') is not None and
                          abs(float(_field(s, 'elevation'))+float(_field(s, 'height'))-level) <= 1e-6]
        if len(candidates) != 1:
            raise OpenSeesMissingInputError(f'Seismic mass at elevation {level} requires exactly one explicit story association')
        story = candidates[0]
        extra = _field(story, 'extra', {}) or {}
        mass = optional_number(extra.get('seismic_mass'))
        weight = optional_number(extra.get('seismic_weight'))
        if mass is not None and weight is not None and not math.isclose(mass*G_ACCEL, weight, rel_tol=1e-8):
            raise OpenSeesInputError('Conflicting seismic_mass and seismic_weight')
        source = 'explicit-story-seismic-mass' if mass is not None else 'explicit-story-seismic-weight'
        if mass is None and weight is None:
            area = optional_number(extra.get('tributary_area', metadata.get('seismicMassArea')))
            if area is None or area <= 0:
                raise OpenSeesMissingInputError(f"Story '{_field(story, 'id')}' seismic mass requires explicit tributary_area (m2), seismic_mass (tonne) or seismic_weight (kN)")
            intensity = 0.0
            floor_loads = _field(story, 'floor_loads', []) or []
            if not floor_loads:
                floor_loads = [{'type': kind, 'value': _field(story, key)} for kind, key in
                               (('dead', 'dead_load'), ('live', 'live_load')) if _field(story, key) is not None]
            if not floor_loads:
                raise OpenSeesMissingInputError(f"Story '{_field(story, 'id')}' requires explicit gravity representative loads")
            live_factor = optional_number(extra.get('live_load_mass_factor'))
            if live_factor is None:
                live_factor = 0.5  # Existing GB representative live-load coefficient, recorded below.
            if not 0 <= live_factor <= 1:
                raise OpenSeesInputError('live_load_mass_factor must be between 0 and 1')
            for load in floor_loads:
                kind = str(_field(load, 'type', ''))
                value = optional_number(_field(load, 'value'))
                if value is None or value < 0 or kind not in {'dead', 'live'}:
                    raise OpenSeesInputError('Seismic mass from floor loads requires nonnegative explicit dead/live loads')
                intensity += value * (live_factor if kind == 'live' else 1.0)
            weight = intensity*area
            source = 'explicit-area-and-gravity-loads'
        mass = mass if mass is not None else weight/G_ACCEL
        if not math.isfinite(mass) or mass <= 0:
            raise OpenSeesInputError('Seismic floor mass must be finite and positive')
        masses.append({'story': str(_field(story, 'id')), 'elevation': float(level),
                       'weightKN': mass*G_ACCEL, 'mass': mass, 'source': source})
    if not masses:
        raise OpenSeesMissingInputError('Seismic analysis requires at least one elevated floor with explicit mass')
    return masses, []


def _restraints_for_node(node: Any, dimension: str) -> List[int]:
    restraints = _field(node, "restraints", None)
    if isinstance(restraints, list) and restraints:
        values = [int(bool(item)) for item in restraints]
    else:
        values = [0, 0, 0, 0, 0, 0]
    if dimension == "2d":
        return [values[0], values[2], values[4]]
    return (values + [0, 0, 0, 0, 0, 0])[:6]


def _build_opensees_model(ops: Any, payload: Dict[str, Any], model: Any, basis: SeismicDesignBasis, direction: str) -> Tuple[str, Dict[str, int], List[Dict[str, float]]]:
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
    builder.build(ops)
    floor_masses, _ = compute_floor_masses(payload, model, builder.dimension)
    masses = {node.id: 0.0 for node in adapted.nodes}
    for floor in floor_masses:
        nodes = [n for n in adapted.nodes if abs(n.z-floor['elevation']) <= 1e-6]
        for node in nodes:
            masses[node.id] += floor.get('nodeMasses', {}).get(node.id, float(floor['mass'])/len(nodes))
    builder.assign_masses(ops, masses, directions={'x', 'y'})
    return builder.dimension, builder._ops_node_tags, floor_masses


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
        dimension, node_tags, floor_masses = _build_opensees_model(ops, payload, model, basis, direction)
        ops.system("FullGeneral")
        ops.numberer("RCM")
        ops.constraints("Transformation")
        dof_per_node = 3 if dimension == "2d" else 6
        free_dof = sum(
            dof_per_node - sum(_restraints_for_node(node, dimension))
            for node in nodes
        )
        lateral_dof = max(1, len(floor_masses) * (2 if dimension == "3d" else 1))
        requested_modes = min(max(1, int(modal_count)), lateral_dof, max(1, free_dof - 1))
        try:
            eigen_values = ops.eigen(requested_modes)
        except Exception:
            eigen_values = ops.eigen("-fullGenLapack", requested_modes)
        if isinstance(eigen_values, (int, float)):
            eigen_values = [eigen_values]
        if not eigen_values:
            raise RuntimeError("OpenSees returned no eigenvalues.")

        total_mass = sum(floor["mass"] for floor in floor_masses)
        modes: List[Dict[str, Any]] = []
        cumulative = 0.0
        direction_index = 0 if direction.lower() == "x" else 1
        if dimension == "2d":
            direction_index = 0

        for mode_index, eigen_value in enumerate(eigen_values, start=1):
            if not math.isfinite(float(eigen_value)) or eigen_value <= 0:
                continue
            omega = math.sqrt(float(eigen_value))
            if not math.isfinite(omega) or omega <= 0.0:
                continue
            period = 2.0 * math.pi / omega
            numerator = 0.0
            denominator = 0.0
            story_shape: List[Dict[str, Any]] = []
            for floor in floor_masses:
                elevation = floor["elevation"]
                level_nodes = [
                    node for node in nodes
                    if abs(float(_field(node, "z", 0.0) or 0.0) - elevation) <= 1e-6
                ]
                phis: List[float] = []
                for node in level_nodes:
                    vector = ops.nodeEigenvector(node_tags[_node_key(node)], mode_index)
                    if len(vector) <= direction_index:
                        raise RuntimeError("OpenSees returned an incomplete modal vector")
                    phi = float(vector[direction_index])
                    if not math.isfinite(phi):
                        raise RuntimeError("OpenSees returned a non-finite modal vector")
                    phis.append(phi)
                mass = float(floor["mass"])
                node_masses = [floor.get('nodeMasses', {}).get(_node_key(n), mass/len(level_nodes)) for n in level_nodes]
                weighted_phi = sum(m*phi for m, phi in zip(node_masses, phis))
                phi_avg = weighted_phi/mass if mass else (sum(phis)/len(phis) if phis else 0.0)
                numerator += weighted_phi
                # Modal mass uses every nodal squared amplitude. Squaring the floor
                # average falsely cancels torsional/non-rigid-floor mode energy.
                denominator += sum(m*phi*phi for m, phi in zip(node_masses, phis))
                story_shape.append({
                    "story": floor["story"],
                    "elevation": elevation,
                    "phi": round(phi_avg, 8),
                })
            participation = numerator / denominator if denominator > 0.0 else 0.0
            effective_mass = participation * participation * denominator
            ratio = effective_mass / total_mass if total_mass > 0.0 else 0.0
            if not all(math.isfinite(value) for value in (participation, effective_mass, ratio)):
                continue
            cumulative += ratio
            modes.append({
                "modeNumber": mode_index,
                "period": round(period, 6),
                "frequency": round(1.0 / period, 6),
                "omega": round(omega, 6),
                "participationFactor": round(participation, 6),
                "effectiveMass": round(effective_mass, 6),
                "massParticipationRatio": round(ratio, 6),
                "cumulativeMassParticipationRatio": round(cumulative, 6),
                "storyShape": story_shape,
            })
        ops.wipe()
        if not modes:
            raise RuntimeError("No valid positive OpenSees eigen modes were extracted.")
        return ModalAnalysis(
            modes=modes,
            total_mass=round(total_mass, 6),
            floor_masses=floor_masses,
            model_dimension=dimension,
            direction=direction,
            engine_mode="opensees_eigen",
            warnings=compute_floor_masses(payload, model, dimension)[1],
            coordinate_contract=coordinate_contract_metadata(model),
            execution={"solver": "OpenSees", "solverVersion": ops.version(), "executed": True,
                       "massSource": "explicit-node-mass" if any(_field(n, 'mass') is not None for n in nodes) else "story-gravity-representative-weight", "massUnit": "tonne",
                       "massAssumptions": compute_floor_masses(payload, model, dimension)[1],
                       "wallModel": "equivalent-line-wall" if any(_is_wall_line_element_type(_element_type(e))
                                      for e in _records(payload, model, 'elements')) else None},
        )
    except OpenSeesInputError:
        ops.wipe()
        raise
    except Exception as error:
        ops.wipe()
        raise RuntimeError(f"OpenSees seismic modal execution failed; no approximate modes substituted: {error}") from error
