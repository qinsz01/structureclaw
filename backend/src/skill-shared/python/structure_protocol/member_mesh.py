"""Deterministic physical-member refinement shared by commercial adapters.

Only load breakpoints become connected analysis nodes. Source IDs, geometry,
loads and physical end releases are preserved by the returned mapping; native
execution and result/section conventions remain the adapter's responsibility.
"""
from __future__ import annotations
import copy
import hashlib
import json
import math


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def compile_load_breakpoints(model: dict, *, engine: str, beam_hinges, node_fields=None) -> tuple[dict, dict | None]:
    nodes = {row['id']: row for row in model['nodes']}
    elements = {row['id']: row for row in model['elements']}
    loads = [load for case in model.get('load_cases', []) for load in case['loads']]
    mesh = copy.deepcopy(model)
    mesh['elements'] = []
    mappings, chains = {}, {}
    for member in model['elements']:
        first, last = [nodes[key] for key in member['nodes']]
        length = math.dist([first[k] for k in ('x', 'y', 'z')], [last[k] for k in ('x', 'y', 'z')])
        cuts = {0., length}
        for load in loads:
            if load.get('element') != member['id']:
                continue
            if load['type'] == 'point':
                cuts.add(float(load['position']))
            elif load['type'] in ('distributed', 'uniform'):
                start, end = float(load.get('start', 0)), float(load.get('end', length))
                if end <= start or load.get('distribution', 'uniform') != 'uniform' or load.get('points'):
                    raise ValueError('Load refinement requires a positive uniform interval / 荷载分段需要有效均布区间')
                cuts.update((start, end))
        if any(not math.isfinite(x) or not 0 <= x <= length for x in cuts):
            raise ValueError('Member load position outside physical member / 构件荷载位置越界')
        cuts = sorted(cuts)
        if len(cuts) == 2:
            mesh['elements'].append(copy.deepcopy(member))
            mappings[member['id']] = [{'id': member['id'], 'start': 0., 'end': length}]
            chains[member['id']] = {0.: first['id'], length: last['id']}
            continue
        if member['type'] != 'beam' or member.get('offsets'):
            raise ValueError('Load refinement requires a beam without offsets / 荷载分段需要无偏移的梁')
        releases = beam_hinges(member)
        chain = [first['id']]
        for i, position in enumerate(cuts[1:-1], 1):
            key = f'__{engine}__{member["id"]}__n{i}'
            if key in nodes:
                raise ValueError('Reserved mesh node ID collision / 分段节点 ID 冲突')
            node = {'id': key, **{k: first[k]+position/length*(last[k]-first[k]) for k in ('x', 'y', 'z')}}
            if node_fields is not None:
                node.update(node_fields(member))
            mesh['nodes'].append(node)
            chain.append(key)
        chain.append(last['id'])
        mappings[member['id']] = []
        chains[member['id']] = dict(zip(cuts, chain))
        for i, (start, end) in enumerate(zip(cuts, cuts[1:]), 1):
            key = f'__{engine}__{member["id"]}__s{i}'
            if key in elements:
                raise ValueError('Reserved mesh member ID collision / 分段构件 ID 冲突')
            segment = {**copy.deepcopy(member), 'id': key, 'nodes': chain[i-1:i+1]}
            segment.pop('releases', None)
            outer = {}
            if i == 1 and releases[0]:
                outer['i'] = {'ry': True, 'rz': True}
            if i == len(cuts)-1 and releases[1]:
                outer['j'] = {'ry': True, 'rz': True}
            if outer:
                segment['releases'] = outer
            mesh['elements'].append(segment)
            mappings[member['id']].append({'id': key, 'start': start, 'end': end})
            references = mesh.setdefault('metadata', {}).get('elementReferenceVectors', {})
            if member['id'] in references:
                references[key] = references[member['id']]
    if not any(len(rows) > 1 for rows in mappings.values()) and not any(load['type'] == 'point' for load in loads):
        return model, None
    for case in mesh['load_cases']:
        compiled = []
        for load in case['loads']:
            if load['type'] == 'point':
                compiled.append({**{k: v for k, v in load.items() if k not in {'element', 'position'}},
                                 'type': 'nodal', 'node': chains[load['element']][float(load['position'])]})
            elif load['type'] in ('distributed', 'uniform'):
                rows = mappings[load['element']]
                for segment in rows:
                    if float(load.get('start', 0)) <= segment['start'] and segment['end'] <= float(load.get('end', rows[-1]['end'])):
                        entry = {k: v for k, v in load.items() if k not in {'start', 'end'}}
                        entry['element'] = segment['id']
                        if 'id' in entry:
                            entry['id'] += ':'+segment['id']
                        compiled.append(entry)
            else:
                compiled.append(load)
        case['loads'] = compiled
    metadata = mesh.get('metadata', {})
    if 'elementReferenceVectors' in metadata:
        ids = {element['id'] for element in mesh['elements']}
        metadata['elementReferenceVectors'] = {key: value for key, value in metadata['elementReferenceVectors'].items() if key in ids}
    receipt = {'schema': f'sclaw-{engine}-physical-mesh/v1', 'physicalModelHash': _hash(model),
               'compiledModelHash': _hash(mesh), 'members': mappings,
               'physicalNodeIds': list(nodes), 'positionUnit': 'm',
               'reason': 'native-connected-load-breakpoint-segments'}
    return mesh, receipt

