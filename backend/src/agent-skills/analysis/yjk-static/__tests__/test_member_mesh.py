import copy
import json
from pathlib import Path
import sys

import pytest

ADAPTER = Path(__file__).resolve().parents[1]
ROOT = ADAPTER.parents[4]
sys.path[:0] = [str(ADAPTER), str(ADAPTER.parent/'runtime'), str(ROOT/'backend/tests')]
from member_mesh import compile_member_mesh, restore_physical_results
from native_frame_reference import solve
from native_story_geometry import compile_story_geometry


def model():
    payload = json.loads((ROOT/'tests/llm-benchmark/acceptance/representative-18/STD-088/model-state-1.json').read_text(encoding='utf8'))
    beam = next(row for row in payload['elements'] if row['type'] == 'beam')
    payload['load_cases'] = [{'id': 'PATCH', 'type': 'dead', 'loads': [
        {'id': 'udl', 'type': 'distributed', 'element': beam['id'], 'start': 1, 'end': 3.5, 'wz': -7},
        {'id': 'point', 'type': 'point', 'element': beam['id'], 'position': 1.7, 'fz': -5}]}]
    payload['load_combinations'] = []
    return payload, beam['id']


def test_breakpoints_preserve_physics_and_do_not_mutate_source():
    source, beam = model()
    before = copy.deepcopy(source)
    compiled, receipt = compile_member_mesh(source)
    assert source == before
    assert [(row['start'], row['end']) for row in receipt['members'][beam]] == [(0, 1), (1, 1.7), (1.7, 3.5), (3.5, 6)]
    assert all(load['type'] in {'nodal', 'distributed'} and 'position' not in load for load in compiled['load_cases'][0]['loads'])
    expected, actual = solve(source, 'PATCH'), solve(compiled, 'PATCH')
    for field in ('displacements', 'reactions'):
        for node, components in expected[field].items():
            assert actual[field][node] == pytest.approx(components, rel=1e-11, abs=1e-11)


def test_restore_keeps_left_and_right_and_requires_matching_compiled_model():
    source, beam = model()
    compiled, receipt = compile_member_mesh(source)
    stations = {}
    for segments in receipt['members'].values():
        for segment in segments:
            stations[segment['id']] = [{'positionM': p, 'side': side, 'referenceFrame': 'element-local',
                'components': dict(N=0, Vy=0, Vz=1 if side == 'left' else 2, T=0, My=0, Mz=0)}
                for p, side in ((0, 'right'), (segment['end']-segment['start'], 'left'))]
    output = {'caseResults': {'PATCH': {'displacements': {row['id']: {} for row in compiled['nodes']},
        'reactions': {}, 'memberStations': stations, 'nativeContext': {'physicalModelHash': receipt['compiledModelHash']}}}, 'summary': {}}
    restored = restore_physical_results(output, receipt)
    rows = [row for row in restored['caseResults']['PATCH']['memberStations'][beam] if row['positionM'] == 1.7]
    assert [row['side'] for row in rows] == ['left', 'right']
    assert set(restored['caseResults']['PATCH']['displacements']) == set(receipt['physicalNodeIds'])
    output['caseResults']['PATCH']['nativeContext']['physicalModelHash'] = 'different'
    with pytest.raises(ValueError, match='mesh'):
        restore_physical_results(output, receipt)


def test_roof_breakpoints_keep_validated_natural_floor_with_mixed_explicit_assignments():
    source = {'stories': [{'id': 'S1', 'elevation': 0, 'height': 3}, {'id': 'S2', 'elevation': 3, 'height': 3}],
              'nodes': [{'id': 'a', 'x': 0, 'y': 0, 'z': 5}, {'id': 'b', 'x': 6, 'y': 0, 'z': 7, 'story': 'S2'}],
              'elements': [{'id': 'roof', 'type': 'beam', 'nodes': ['a', 'b'], 'story': 'S2'}],
              'load_cases': [{'id': 'D', 'loads': [{'type': 'point', 'element': 'roof', 'position': 40**.5*.75, 'fz': -5}]}]}
    before = copy.deepcopy(source)
    expected = compile_story_geometry(source)
    compiled, receipt = compile_member_mesh(source)
    geometry = compile_story_geometry(compiled)
    assert source == before
    for segment in receipt['members']['roof']:
        assert geometry['members'][segment['id']]['floor'] == expected['members']['roof']['floor'] == 'S2'
    generated = [node for node in compiled['nodes'] if node['id'] not in {'a', 'b'}]
    assert generated[0]['z'] == 6.5
    assert generated[0]['story'] == 'S2'
    from yjk_native_loads import compile_load_definitions
    compile_load_definitions(source, native_precision=False)
    # The irrational physical distance is gone from the native load vector;
    # the actual (millimetre-exact) mesh node holds the unchanged point force.
    definitions = compile_load_definitions(compiled)
    assert definitions[0]['loads'][0]['targetKind'] == 'node'
    assert definitions[0]['loads'][0]['components'][0] == 5
