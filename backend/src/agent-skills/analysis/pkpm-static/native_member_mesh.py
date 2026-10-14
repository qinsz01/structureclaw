"""PKPM physical ownership around the shared deterministic load refinement."""
from __future__ import annotations

import copy
import math


def compile_member_mesh(model):
    from structure_protocol.member_mesh import compile_load_breakpoints
    from native_member_releases import beam_release_plan
    from native_result_adapter import _hash
    compiled, receipt = compile_load_breakpoints(model, engine='pkpm',
        beam_hinges=lambda member: beam_release_plan(member)['hinges'])
    if receipt is not None:
        if (model.get('analysis_control') or {}).get('rigid_offsets') is True:
            raise ValueError('PKPM refined physical members with automatic rigid ends need native position calibration / PKPM分段物理构件与自动刚域并用尚需位置校准')
        receipt.update(physicalModelHash=_hash(model), compiledModelHash=_hash(compiled))
    return compiled, receipt


def restore_physical_results(output, receipt):
    if receipt is None:
        return output
    from native_result_adapter import _hash, station_envelope
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
                    stations.append(row)
            physical[member] = sorted(stations, key=lambda row: (row['positionM'], row['side']))
        case['memberStations'] = physical
        case['forces'] = {key: station_envelope(rows) for key, rows in physical.items()}
        context = copy.deepcopy(case['nativeContext'])
        if context['physicalModelHash'] != receipt['compiledModelHash']:
            raise ValueError('PKPM result does not match compiled mesh / PKPM结果与计算网格版本不一致')
        context.update(compiledModelHash=context['physicalModelHash'], physicalModelHash=receipt['physicalModelHash'],
                       meshMappingHash=_hash(receipt))
        weight = (context.get('effectiveLoads') or {}).get('selfWeight')
        if weight and weight.get('enabled'):
            segments = {row['id']: (physical_id, row) for physical_id, rows in receipt['members'].items() for row in rows}
            for entry in weight['physicalCompilation']:
                physical_id, segment = segments[entry['sourceSegmentId']]
                entry.update(physicalElementId=physical_id, startM=segment['start']+entry['startM'],
                             endM=segment['start']+entry['endM'])
        case['nativeContext'] = context
    result['analysisMesh'] = receipt
    result.setdefault('pkpm_detailed', {})['nativeMeshEnvelopeTables'] = result.pop('envelopeTables', {})
    result['envelopeTables'] = {}
    result['summary'].update(nodeCount=len(physical_nodes), elementCount=len(receipt['members']))
    return result
