"""Native elastic bending releases and removal of undetermined joint rotations."""
from __future__ import annotations

import numpy as np

from opensees_shared.errors import OpenSeesCapabilityError, OpenSeesInputError


def bending_releases(element, dimension):
    value = element.releases or {}
    if not isinstance(value, dict) or set(value)-{'i', 'j', 'releaseI', 'releaseJ', 'reference_frame'}:
        raise OpenSeesCapabilityError(f"Unsupported end release fields on '{element.id}'")
    if value.get('reference_frame', 'element-local') != 'element-local':
        raise OpenSeesCapabilityError('End releases must use element-local axes')
    result = {}
    for end, alias in (('i', 'releaseI'), ('j', 'releaseJ')):
        if end in value and alias in value and value[end] != value[alias]:
            raise OpenSeesInputError(f"Conflicting end release aliases on '{element.id}'")
        flags = value.get(end, value.get(alias, {}))
        if not isinstance(flags, dict) or set(flags)-{'ux', 'uy', 'uz', 'rx', 'ry', 'rz'} or any(type(v) is not bool for v in flags.values()):
            raise OpenSeesInputError(f"End release on '{element.id}' requires explicit boolean local DOFs")
        active = {key for key, enabled in flags.items() if enabled}
        # Axial elements already have no rotational stiffness. Preserve the authored model,
        # but realize redundant rotational hinges through the native axial formulation.
        if element.type in {'truss', 'brace'} and not getattr(element, 'offsets', None) and not active-{'rx', 'ry', 'rz'}:
            active = set()
        if active and (element.type not in {'beam', 'column'} or active-{'ry', 'rz'}):
            raise OpenSeesCapabilityError(f"Only elastic beam/column bending releases are supported on '{element.id}'")
        if dimension == '2d':
            in_plane = 'rz' if round(float(element.rotation_angle or 0)/90) % 2 else 'ry'
            if active-{in_plane}:
                raise OpenSeesCapabilityError(f"Only in-plane local {in_plane} release is active on 2-D member '{element.id}'")
        result[end] = {key: True for key in sorted(active)}
    return result


def native_release_arguments(element, dimension):
    plan = bending_releases(element, dimension)
    code = lambda key: int(plan['i'].get(key, False))+2*int(plan['j'].get(key, False))
    if dimension == '2d':
        key = 'rz' if round(float(element.rotation_angle or 0)/90) % 2 else 'ry'
        return ['-release', code(key)] if code(key) else []
    return [item for key, option in (('ry', '-releasey'), ('rz', '-releasez'))
            if code(key) for item in (option, code(key))]


def joint_rotation_gauges(builder):
    """Fix only stiffness-null rotations; these gauge coordinates are not responses.

    A null joint rotation can be eliminated without adding member stiffness. For
    skew axes a coordinate gauge removes the null vector, but every component
    having a null-space projection remains physically undetermined.
    """
    stiffness = {str(n.id): np.zeros((3, 3)) for n in builder.model.nodes}
    for element in builder.model.elements:
        plan = bending_releases(element, builder.dimension)
        if element.type not in {'beam', 'column'}:
            continue
        axes = builder._element_axes(element)
        for node_id, end in zip(element.nodes, ('i', 'j')):
            if builder.dimension == '2d':
                key = 'rz' if round(float(element.rotation_angle or 0)/90) % 2 else 'ry'
                vectors = [] if plan[end].get(key) else [np.array([0., 1., 0.])]
            else:
                vectors = [axes[0]]+[axes[k] for k, key in ((1, 'ry'), (2, 'rz')) if not plan[end].get(key)]
            for vector in vectors:
                stiffness[str(node_id)] += np.outer(vector, vector)
    gauges, availability, nullspaces = {}, {}, {}
    for node in builder.model.nodes:
        key = str(node.id)
        fixed = list(node.restraints or [False]*6)[3:]
        # Out-of-plane DOFs are absent from the planar solver, not release gauges.
        if builder.dimension == '2d':
            fixed[0] = fixed[2] = True
        matrix = stiffness[key]+np.diag([int(v) for v in fixed])
        eigenvalues, eigenvectors = np.linalg.eigh(matrix)
        null = eigenvectors[:, eigenvalues < 1e-10]
        nullspaces[key] = null
        availability[key] = {name: bool(np.linalg.norm(null[i]) < 1e-9) for i, name in enumerate(('rx', 'ry', 'rz'))}
        selected = []
        for i in range(3):
            if not fixed[i] and np.linalg.matrix_rank(null[selected+[i]], tol=1e-9) > len(selected):
                selected.append(i)
        gauges[key] = selected
    return gauges, availability, nullspaces
