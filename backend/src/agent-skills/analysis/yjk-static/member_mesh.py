"""Compile load breakpoints into native beams, retaining physical ownership.

YJK's point/partial load fixed-end vectors omit shear flexibility. Connected
segments with full-span loads and real nodal point forces preserve that physics.
This is a mesh compiler and result index mapper, never another solver.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math


def _hash(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def compile_member_mesh(model: dict) -> tuple[dict, dict | None]:
    nodes = {row['id']: row for row in model['nodes']}
    elements = {row['id']: row for row in model['elements']}
    loads = [load for case in model['load_cases'] for load in case['loads']]
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
            elif load['type'] == 'distributed':
                cuts.update((float(load.get('start', 0)), float(load.get('end', length))))
        if any(not math.isfinite(x) or not 0 <= x <= length for x in cuts):
            raise ValueError('YJK member load position outside physical member / 构件荷载位置越界')
        cuts = sorted(cuts)
        if len(cuts) == 2:
            mesh['elements'].append(copy.deepcopy(member))
            mappings[member['id']] = [{'id': member['id'], 'start': 0., 'end': length}]
            chains[member['id']] = {0.: first['id'], length: last['id']}
            continue
        if member['type'] != 'beam' or member.get('offsets') or member.get('releases'):
            raise ValueError('YJK load refinement requires an unreleased beam / 荷载分段需要无端释放的梁')
        chain = [first['id']]
        for i, position in enumerate(cuts[1:-1], 1):
            key = f'__yjk__{member["id"]}__n{i}'
            if key in nodes:
                raise ValueError('Reserved mesh node ID collision / 分段节点 ID 冲突')
            node = {'id': key, **{k: first[k]+position/length*(last[k]-first[k]) for k in ('x', 'y', 'z')}}
            if first.get('story') == last.get('story') and first.get('story') is not None:
                node['story'] = first['story']
            mesh['nodes'].append(node)
            chain.append(key)
        chain.append(last['id'])
        mappings[member['id']] = []
        chains[member['id']] = dict(zip(cuts, chain))
        for i, (start, end) in enumerate(zip(cuts, cuts[1:]), 1):
            key = f'__yjk__{member["id"]}__s{i}'
            if key in elements:
                raise ValueError('Reserved mesh member ID collision / 分段构件 ID 冲突')
            mesh['elements'].append({**copy.deepcopy(member), 'id': key, 'nodes': chain[i-1:i+1]})
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
            elif load['type'] == 'distributed':
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
    receipt = {'schema': 'sclaw-yjk-physical-mesh/v1', 'physicalModelHash': _hash(model),
               'compiledModelHash': _hash(mesh), 'members': mappings,
               'physicalNodeIds': list(nodes), 'positionUnit': 'm',
               'reason': 'native-connected-load-breakpoint-segments'}
    return mesh, receipt


def restore_physical_results(output: dict, receipt: dict | None) -> dict:
    if receipt is None:
        return output
    from yjk_native_stations import station_envelope
    result = copy.deepcopy(output)
    physical_nodes = set(receipt['physicalNodeIds'])
    for case in result['caseResults'].values():
        for field in ('displacements', 'reactions'):
            case[field] = {key: value for key, value in case[field].items() if key in physical_nodes}
        physical = {}
        for member, segments in receipt['members'].items():
            stations = []
            for segment in segments:
                for station in case['memberStations'][segment['id']]:
                    row = copy.deepcopy(station)
                    position, length = row['positionM'], segment['end']-segment['start']
                    roundoff = 8*math.ulp(max(1., length, segment['end']))
                    row['positionM'] = (segment['start'] if abs(position) <= roundoff else
                                        segment['end'] if abs(position-length) <= roundoff else
                                        position+segment['start'])
                    row['nativeSegmentId'] = segment['id']
                    # Keep both one-sided native endpoint vectors at each join.
                    # Their equality is not assumed, especially at point forces.
                    stations.append(row)
            physical[member] = sorted(stations, key=lambda row: (row['positionM'], row['side']))
        case['memberStations'] = physical
        case['forces'] = {key: {**station_envelope(rows), 'referenceFrame': 'element-local'} for key, rows in physical.items()}
        context = case['nativeContext']
        if context['physicalModelHash'] != receipt['compiledModelHash']:
            raise ValueError('YJK result model does not match compiled mesh / 结果与计算网格版本不一致')
        context['compiledModelHash'] = context['physicalModelHash']
        context['physicalModelHash'] = receipt['physicalModelHash']
        context['meshMappingHash'] = _hash(receipt)
    result['analysisMesh'] = receipt
    detail = result.setdefault('detailed', {})
    detail['nativeMeshEnvelopeTables'] = result.pop('envelopeTables', {})
    result['envelopeTables'] = {}
    result['summary'].update(nodeCount=len(physical_nodes), elementCount=len(receipt['members']))
    return result
