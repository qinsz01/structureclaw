"""Independent first-order 3-D Timoshenko frame reference for native acceptance.

Test-only direct stiffness assembly. No production converter, postprocessor or
solver imports. Rectangular elastic members, nodal/point loads and uniform
global line loads; partial loading uses independent connected segments.
"""
from __future__ import annotations
import copy
import math
import numpy as np


def solve(model: dict, case_id: str) -> dict:
    """Resolve load breakpoints using independent, connected elastic segments."""
    case = next(row for row in model['load_cases'] if row['id'] == case_id)
    if not any(load['type'] == 'point' or (load['type'] == 'distributed' and
               ('start' in load or 'end' in load)) for load in case['loads']):
        return _solve_full_span(model, case_id)
    mesh = copy.deepcopy(model)
    coordinates = {node['id']: np.array([node[k] for k in ('x', 'y', 'z')]) for node in model['nodes']}
    mesh['elements'] = []
    loads, member_segments = [], {}
    for member in model['elements']:
        a, b = (coordinates[key] for key in member['nodes'])
        length = float(np.linalg.norm(b-a))
        member_loads = [load for load in case['loads'] if load.get('element') == member['id']]
        breaks = {0., length}
        for load in member_loads:
            if load['type'] == 'point':
                positions = [float(load['position'])]
            elif load['type'] == 'distributed' and load.get('distribution', 'uniform') == 'uniform':
                positions = [float(load.get('start', 0)), float(load.get('end', length))]
            else:
                raise ValueError('Independent segmented reference requires point or uniform line loads')
            if any(not 0 <= position <= length for position in positions):
                raise ValueError('Independent reference load outside physical member')
            breaks.update(positions)
        breaks = sorted(breaks)
        node_ids = [member['nodes'][0]]
        for i, distance in enumerate(breaks[1:-1], 1):
            key = f'__reference_{member["id"]}_node_{i}'
            if key in coordinates:
                raise ValueError('Independent reference node ID collision')
            xyz = a+(b-a)*distance/length
            mesh['nodes'].append({'id': key, **dict(zip(('x', 'y', 'z'), xyz.tolist()))})
            node_ids.append(key)
        node_ids.append(member['nodes'][1])
        segments = []
        for i, (start, end) in enumerate(zip(breaks, breaks[1:])):
            key = f'__reference_{member["id"]}_segment_{i}'
            segment = {**copy.deepcopy(member), 'id': key, 'nodes': node_ids[i:i+2]}
            mesh['elements'].append(segment)
            reference = model.get('metadata', {}).get('elementReferenceVectors', {}).get(member['id'])
            if reference is not None:
                mesh.setdefault('metadata', {}).setdefault('elementReferenceVectors', {})[key] = reference
            segments.append(key)
            for load in member_loads:
                if load['type'] == 'distributed' and float(load.get('start', 0)) <= start and end <= float(load.get('end', length)):
                    loads.append({k: v for k, v in {**load, 'element': key}.items() if k not in {'start', 'end'}})
        for load in member_loads:
            if load['type'] == 'point':
                loads.append({**{k: v for k, v in load.items() if k not in {'element', 'position'}},
                              'type': 'nodal', 'node': node_ids[breaks.index(float(load['position']))]})
        member_segments[member['id']] = segments
    loads.extend(load for load in case['loads'] if load['type'] == 'nodal')
    mesh['load_cases'] = [{**case, 'loads': loads}]
    result = _solve_full_span(mesh, case_id)
    for field in ('displacements', 'reactions'):
        result[field] = {node['id']: result[field][node['id']] for node in model['nodes']}
    result['localEndActions'] = {key: result['localEndActions'][segments[0]][:6] +
                                result['localEndActions'][segments[-1]][6:] for key, segments in member_segments.items()}
    result['method'] += '-independent-load-breakpoint-segmentation'
    return result


def _solve_full_span(model: dict, case_id: str) -> dict:
    nodes = model['nodes']
    index = {row['id']: i for i, row in enumerate(nodes)}
    positions = {row['id']: np.array([row[key] for key in ('x', 'y', 'z')], dtype=float) for row in nodes}
    materials = {row['id']: row for row in model['materials']}
    sections = {row['id']: row for row in model['sections']}
    K = np.zeros((6*len(nodes), 6*len(nodes)))
    F = np.zeros(6*len(nodes))
    members = {}
    for member in model['elements']:
        a, b = member['nodes']
        delta = positions[b]-positions[a]
        L = np.linalg.norm(delta)
        x = delta/L
        reference = model.get('metadata', {}).get('elementReferenceVectors', {}).get(member['id'])
        reference = np.array(reference if reference is not None else ([1., 0, 0] if abs(x[2]) > .9 else [0, 0, 1.]))
        y = np.cross(reference, x); y /= np.linalg.norm(y)
        z = np.cross(x, y)
        angle = math.radians(member.get('rotation_angle', 0))
        y, z = math.cos(angle)*y+math.sin(angle)*z, -math.sin(angle)*y+math.cos(angle)*z
        axes = np.array([x, y, z])
        transform = np.kron(np.eye(4), axes)
        material, section = materials[member['material']], sections[member['section']]
        shape = section['shape']
        if shape['kind'] != 'rectangular' or member.get('releases') or member.get('offsets'):
            raise ValueError('Independent reference only covers unoffset unreleased rectangular frames')
        width, height = shape['B']/1000, shape['H']/1000
        A, Iy, Iz = width*height, width*height**3/12, height*width**3/12
        wide, narrow = max(width, height), min(width, height)
        J = wide*narrow**3*(1/3-.21*narrow/wide*(1-narrow**4/(12*wide**4)))
        prop = {'A': A, 'Iy': Iy, 'Iz': Iz, 'J': J, 'Asy': 5*A/6, 'Asz': 5*A/6, **section.get('properties', {})}
        E = material['E']*1000
        G = material.get('G', material['E']/(2*(1+material['nu'])))*1000
        stiffness = np.zeros((12, 12))
        for ids, rigidity in (([0, 6], E*prop['A']), ([3, 9], G*prop['J'])):
            stiffness[np.ix_(ids, ids)] = rigidity/L*np.array([[1, -1], [-1, 1]])
        for ids, inertia, shear_area, sign in (([1, 5, 7, 11], prop['Iz'], prop['Asy'], 1),
                                               ([2, 4, 8, 10], prop['Iy'], prop['Asz'], -1)):
            phi = 12*E*inertia/(G*shear_area*L**2)
            block = E*inertia/(L**3*(1+phi))*np.array([
                [12, sign*6*L, -12, sign*6*L],
                [sign*6*L, (4+phi)*L**2, -sign*6*L, (2-phi)*L**2],
                [-12, -sign*6*L, 12, -sign*6*L],
                [sign*6*L, (2-phi)*L**2, -sign*6*L, (4+phi)*L**2]])
            stiffness[np.ix_(ids, ids)] = block
        dofs = np.array([6*index[node]+component for node in (a, b) for component in range(6)])
        K[np.ix_(dofs, dofs)] += transform.T@stiffness@transform
        members[member['id']] = dict(dofs=dofs, transform=transform, stiffness=stiffness,
                                     length=L, equivalent=np.zeros(12), axes=axes)
    case = next(row for row in model['load_cases'] if row['id'] == case_id)
    for load in case['loads']:
        if load.get('reference_frame', 'global') != 'global':
            raise ValueError('Reference requires explicit global loads')
        if load['type'] == 'nodal':
            start = 6*index[load['node']]
            F[start:start+6] += np.array([load.get(key, 0) for key in ('fx', 'fy', 'fz', 'mx', 'my', 'mz')])
        elif load['type'] == 'distributed':
            member = members[load['element']]; L = member['length']
            if load.get('start', 0) != 0 or load.get('end', L) != L or load.get('distribution', 'uniform') != 'uniform':
                raise ValueError('Reference requires full-span uniform load')
            qx, qy, qz = member['axes']@np.array([load.get(key, 0) for key in ('wx', 'wy', 'wz')])
            # Exact fixed-end consistent vector for a uniform transverse load.
            local = np.array([qx*L/2, qy*L/2, qz*L/2, 0, -qz*L**2/12, qy*L**2/12,
                              qx*L/2, qy*L/2, qz*L/2, 0, qz*L**2/12, -qy*L**2/12])
            member['equivalent'] += local
            F[member['dofs']] += member['transform'].T@local
        else:
            raise ValueError('Unsupported independent reference load')
    fixed = np.array([6*i+j for i, node in enumerate(nodes) for j, fixed in enumerate(node.get('restraints', [False]*6)) if fixed], dtype=int)
    free = np.setdiff1d(np.arange(6*len(nodes)), fixed)
    u = np.zeros(len(F)); u[free] = np.linalg.solve(K[np.ix_(free, free)], F[free])
    reactions = K@u-F
    local_forces = {key: (row['stiffness']@row['transform']@u[row['dofs']]-row['equivalent']).tolist() for key, row in members.items()}
    return {'method': 'independent-direct-stiffness-Timoshenko-3d',
            'displacements': {row['id']: dict(zip(('ux', 'uy', 'uz', 'rx', 'ry', 'rz'), u[6*i:6*i+6].tolist())) for i, row in enumerate(nodes)},
            'reactions': {row['id']: dict(zip(('fx', 'fy', 'fz', 'mx', 'my', 'mz'), reactions[6*i:6*i+6].tolist())) for i, row in enumerate(nodes)},
            'localEndActions': local_forces}
