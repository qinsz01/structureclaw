"""Shared eigen extraction and full nodal modal energy for dynamic/seismic consumers."""
from __future__ import annotations
import math
import sys
from opensees_shared.errors import OpenSeesInputError


def eigen_values(builder, ops, requested_modes):
    if isinstance(requested_modes, bool) or int(requested_modes) != requested_modes or requested_modes <= 0:
        raise OpenSeesInputError('numModes must be a positive integer')
    axes = {'x': 0, 'z': 2} if builder.dimension == '2d' else {'x': 0, 'y': 1, 'z': 2}
    mass_axes = set(builder.mass_assembly['directions'])
    count = sum(sum(not (n.restraints or [False]*6)[index] for axis, index in axes.items() if axis in mass_axes)
        for n in builder.model.nodes if builder.node_masses.get(str(n.id), 0) > 0)
    if count < 1:
        raise OpenSeesInputError('Dynamic analysis requires at least one free translational mass DOF')
    count = min(int(requested_modes), count)
    error = None
    for args in [(count,), ('-fullGenLapack', count)]:
        try:
            raw = ops.eigen(*args)
            values = [float(raw)] if isinstance(raw, (int, float)) else list(map(float, raw))
            if not values or any(not math.isfinite(v) or v <= 0 for v in values):
                raise OpenSeesInputError('Non-positive or non-finite eigenvalues; check model stability')
            # LAPACK uses DBL_MAX for massless constrained DOFs, not physical modes.
            values = [v for v in values if v < sys.float_info.max/2]
            if not values or any(not math.isfinite(v) or v <= 0 for v in values):
                raise OpenSeesInputError('Non-positive or non-finite eigenvalues; check model stability')
            return values
        except Exception as exc:
            error = exc
    if isinstance(error, OpenSeesInputError):
        raise error
    raise RuntimeError(f'OpenSees eigen extraction failed: {error}')


def extract_modal(builder, ops, requested_modes, direction='x'):
    allowed = {'x', 'z'} if builder.dimension == '2d' else {'x', 'y', 'z'}
    if direction not in allowed or direction not in builder.mass_assembly['directions']:
        raise OpenSeesInputError(f'Direction {direction} has no active mass in this model')
    ops.system('FullGeneral')
    ops.numberer('RCM')
    ops.constraints('Transformation')
    values = eigen_values(builder, ops, requested_modes)
    index = {'x': 0, 'y': 1, 'z': 2}[direction]
    mass_indices = [{'x': 0, 'y': 1, 'z': 2}[d] for d in builder.mass_assembly['directions'] if d in allowed]
    total = sum(builder.node_masses.values())
    modes, cumulative = [], 0.0
    for mode_number, value in enumerate(values, 1):
        shape = {}
        numerator = denominator = 0.0
        for node in builder.model.nodes:
            raw = list(map(float, ops.nodeEigenvector(builder._ops_node_tag(node.id), mode_number)))
            vector = [raw[0], 0.0, raw[1]] if builder.dimension == '2d' else raw[:3]
            if len(vector) != 3 or any(not math.isfinite(v) for v in vector):
                raise OpenSeesInputError('Incomplete or non-finite modal shape')
            shape[str(node.id)] = vector
            mass = builder.node_masses.get(str(node.id), 0.0)
            numerator += mass*vector[index]
            denominator += mass*sum(vector[j]**2 for j in mass_indices)
        participation = numerator/denominator if denominator > 0 else 0.0
        effective_mass = numerator*participation
        ratio = effective_mass/total if total > 0 else 0.0
        cumulative += ratio
        omega = math.sqrt(value)
        stories = []
        for floor in builder.mass_assembly['floorMasses']:
            weighted = sum(m*shape[n][index] for n, m in floor['nodeMasses'].items())
            stories.append({'story': floor['story'], 'elevation': floor['elevation'],
                'phi': weighted/floor['mass'] if floor['mass'] else 0.0})
        modes.append({'modeNumber': mode_number, 'period': 2*math.pi/omega,
            'frequency': omega/(2*math.pi), 'omega': omega, 'modeShape': shape,
            'modeShapeFrame': 'global', 'storyShape': stories, 'participationFactor': participation,
            'generalizedMass': denominator, 'effectiveMass': effective_mass,
            'massParticipationRatio': ratio, 'cumulativeMassParticipationRatio': cumulative})
    return {'modes': modes, 'totalMass': total, 'direction': direction,
        'floorMasses': builder.mass_assembly['floorMasses'], 'massAssembly': builder.mass_assembly}
