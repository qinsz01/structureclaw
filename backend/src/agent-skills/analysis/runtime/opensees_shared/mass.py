"""Canonical mass assembly in tonnes; no source is silently added to another."""
from __future__ import annotations

import math
from opensees_shared.errors import OpenSeesInputError, OpenSeesMissingInputError

G_ACCEL = 9.80665


def field(record, key, default=None):
    return record.get(key, default) if isinstance(record, dict) else getattr(record, key, default)


def positive(value, description):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise OpenSeesMissingInputError(f'{description} requires a finite positive value')
    return float(value)


def density_masses(model):
    nodes = {str(field(n, 'id')): n for n in field(model, 'nodes', [])}
    materials = {str(field(m, 'id')): m for m in field(model, 'materials', [])}
    sections = {str(field(s, 'id')): s for s in field(model, 'sections', [])}
    masses = dict.fromkeys(nodes, 0.0)
    for element in field(model, 'elements', []):
        ids = field(element, 'nodes', [])
        if len(ids) != 2:
            raise OpenSeesInputError('Density mass requires two-node line elements')
        a, b = [nodes[str(n)] for n in ids]
        length = math.sqrt(sum((float(field(b, axis))-float(field(a, axis)))**2 for axis in ['x', 'y', 'z']))
        area = positive(field(sections[str(field(element, 'section'))], 'properties', {}).get('A'), 'Section A')
        rho = positive(field(materials[str(field(element, 'material'))], 'rho'), 'Material rho')
        for node_id in ids:
            masses[str(node_id)] += rho*area*length/2000.0
    return masses


def floor_mass_records(model, masses):
    """Group actual nodal masses for reporting; retain nodal distribution for modal energy."""
    nodes = list(field(model, 'nodes', []))
    levels = sorted({float(field(n, 'z')) for n in nodes})
    result = []
    for level in levels:
        selected = [n for n in nodes if abs(float(field(n, 'z'))-level) <= 1e-8]
        node_masses = {str(field(n, 'id')): masses.get(str(field(n, 'id')), 0.0) for n in selected}
        total = sum(node_masses.values())
        if total <= 0:
            continue
        story_ids = {str(field(n, 'story')) for n in selected if field(n, 'story')}
        result.append({'story': next(iter(story_ids)) if len(story_ids) == 1 else f'z={level:g}',
            'elevation': level, 'mass': total, 'weightKN': total*G_ACCEL, 'nodeMasses': node_masses})
    return result


def seismic_floor_masses(model):
    nodes, stories = list(field(model, 'nodes', [])), list(field(model, 'stories', []))
    masses = {str(field(n, 'id')): 0.0 for n in nodes}
    floors = []
    base = min((float(field(n, 'z')) for n in nodes), default=0.0)
    levels = sorted({float(field(n, 'z')) for n in nodes if float(field(n, 'z')) > base+1e-8})
    for level in levels:
        selected = [n for n in nodes if abs(float(field(n, 'z'))-level) <= 1e-8]
        story_ids = {str(field(n, 'story')) for n in selected if field(n, 'story')}
        candidates = [s for s in stories if str(field(s, 'id')) in story_ids]
        if not candidates:
            candidates = [s for s in stories if field(s, 'elevation') is not None
                and abs(float(field(s, 'elevation'))+float(field(s, 'height'))-level) <= 1e-8]
        if len(candidates) != 1:
            raise OpenSeesMissingInputError(f'Seismic mass at elevation {level} requires exactly one explicit story association')
        story = candidates[0]
        extra = field(story, 'extra', {}) or {}
        mass, weight = extra.get('seismic_mass'), extra.get('seismic_weight')
        if mass is not None and weight is not None and not math.isclose(positive(mass, 'seismic_mass')*G_ACCEL,
                positive(weight, 'seismic_weight'), rel_tol=1e-8):
            raise OpenSeesInputError('Conflicting seismic_mass and seismic_weight')
        source = 'explicit-story-seismic-mass' if mass is not None else 'explicit-story-seismic-weight'
        assumptions = {}
        if mass is None and weight is None:
            # Legacy values are normalized here only for pre-V2.2 direct adapters.
            metadata = field(model, 'metadata', {}) or {}
            area = field(story, 'load_area_m2')
            if area is None:
                area = extra.get('tributary_area', metadata.get('seismicMassArea'))
            area = positive(area, f"Story {field(story, 'id')} explicit load_area_m2 (legacy explicit tributary_area)")
            loads = list(field(story, 'floor_loads', []) or [])
            if not loads:
                loads = [{'type': kind, 'value': field(story, key)} for kind, key in
                    [('dead', 'dead_load'), ('live', 'live_load')] if field(story, key) is not None]
            if not loads:
                raise OpenSeesMissingInputError('Explicit gravity representative loads are required')
            live_factor = extra.get('live_load_mass_factor', 0.5)
            if not isinstance(live_factor, (int, float)) or not math.isfinite(live_factor) or not 0 <= live_factor <= 1:
                raise OpenSeesInputError('live_load_mass_factor must be between 0 and 1')
            intensity = 0.0
            for load in loads:
                kind, value = field(load, 'type'), field(load, 'value')
                if kind not in {'dead', 'live'} or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                    raise OpenSeesInputError('Seismic mass requires nonnegative explicit dead/live loads')
                intensity += value*(live_factor if kind == 'live' else 1.0)
            weight = intensity*area
            assumptions = {'areaM2': area, 'liveLoadMassFactor': live_factor,
                'liveLoadMassFactorSource': 'explicit' if 'live_load_mass_factor' in extra else 'legacy-GB-representative-default'}
            source = 'explicit-area-and-gravity-loads'
        mass = positive(mass, 'seismic_mass') if mass is not None else positive(weight, 'seismic_weight')/G_ACCEL
        node_masses = {str(field(n, 'id')): mass/len(selected) for n in selected}
        masses.update(node_masses)
        floors.append({'story': str(field(story, 'id')), 'elevation': level, 'mass': mass,
            'weightKN': mass*G_ACCEL, 'source': source, 'nodeMasses': node_masses, 'assumptions': assumptions})
    if not floors:
        raise OpenSeesMissingInputError('Seismic analysis requires an elevated floor with explicit mass')
    return masses, floors


def assemble_mass(model, member_masses=None, source=None, directions=None):
    control = field(model, 'analysis_control')
    declared = field(control, 'mass_source')
    if source is not None and declared is not None and source != declared:
        raise OpenSeesInputError('Requested massSource conflicts with model analysis_control.mass_source')
    nodes = list(field(model, 'nodes', []))
    has_nodal = any(field(n, 'mass') is not None for n in nodes)
    source = source or declared or ('nodal' if has_nodal else 'member-density')
    if has_nodal and source != 'nodal':
        raise OpenSeesInputError('node.mass conflicts with selected mass source; sources cannot be added implicitly')
    if source == 'nodal':
        if not has_nodal:
            raise OpenSeesMissingInputError('mass_source=nodal requires explicit node.mass values in tonnes')
        masses = {str(field(n, 'id')): float(field(n, 'mass') or 0) for n in nodes}
        floors = floor_mass_records(model, masses)
    elif source == 'member-density':
        masses = dict(member_masses) if member_masses is not None else density_masses(model)
        floors = floor_mass_records(model, masses)
    elif source == 'floor-seismic':
        masses, floors = seismic_floor_masses(model)
    else:
        raise OpenSeesInputError(f'Unknown mass source: {source}')
    directions = directions or field(control, 'mass_directions') or (['x', 'y'] if source == 'floor-seismic' else ['x', 'y', 'z'])
    if not directions or any(d not in {'x', 'y', 'z'} for d in directions) or len(set(directions)) != len(directions):
        raise OpenSeesInputError('mass_directions requires unique global axes')
    for value in masses.values():
        if not math.isfinite(value) or value < 0:
            raise OpenSeesInputError('Nodal mass must be finite and non-negative')
    return {'source': source, 'unit': 'tonne', 'nodeMasses': masses, 'floorMasses': floors,
        'directions': list(directions), 'totalMass': sum(masses.values())}
