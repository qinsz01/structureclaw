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
    from structure_protocol.member_mesh import compile_load_breakpoints
    from yjk_native_boundaries import beam_release_plan
    story_geometry = None
    def node_fields(member):
        nonlocal story_geometry
        if story_geometry is None:
            from native_story_geometry import compile_story_geometry
            story_geometry = compile_story_geometry(model)
        # Sloped roofs retain the validated physical member's natural floor.
        return {'story': story_geometry['members'][member['id']]['floor']}
    return compile_load_breakpoints(model, engine='yjk',
        beam_hinges=lambda member: beam_release_plan(member)['hinges'], node_fields=node_fields)


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
        if context.get('effectiveRigidOffsets'):
            from yjk_native_offsets import restore_physical_offsets
            context['effectiveRigidOffsets'] = restore_physical_offsets(context['effectiveRigidOffsets'], receipt)
        effective_loads = context.get('effectiveLoads') or {}
        if effective_loads.get('selfWeight') is not None:
            from yjk_self_weight import restore_physical_compilation
            effective_loads['selfWeight'] = restore_physical_compilation(effective_loads['selfWeight'], receipt)
    result['analysisMesh'] = receipt
    detail = result.setdefault('detailed', {})
    detail['nativeMeshEnvelopeTables'] = result.pop('envelopeTables', {})
    result['envelopeTables'] = {}
    result['summary'].update(nodeCount=len(physical_nodes), elementCount=len(receipt['members']))
    return result
