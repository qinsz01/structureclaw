"""Physical ownership, immutable inputs and one-sided native cut mapping."""
import copy
import importlib.util
import json
from pathlib import Path
import sys

import pytest

ADAPTER = Path(__file__).resolve().parents[1]
ROOT = ADAPTER.parents[4]
sys.path[:0] = [str(ADAPTER), str(ADAPTER.parent/'runtime'), str(ROOT/'backend/src/skill-shared/python'), str(ROOT/'backend/tests')]
from native_member_mesh import compile_member_mesh, restore_physical_results
from native_loads import plan_native_loads
from native_frame_reference import solve


def model():
    source = json.loads((Path(__file__).parent/'fixtures/native-rigid-offsets.json').read_text(encoding='utf8'))['deepReversed']['sourceModel']
    source['analysis_control']['rigid_offsets'] = False
    source['load_cases'] = [{'id': 'D', 'type': 'dead', 'loads': [
        {'id': 'q', 'type': 'distributed', 'element': 'beam', 'wz': -7., 'start': .8, 'end': 4.4},
        {'id': 'P', 'type': 'point', 'element': 'beam', 'fz': -20., 'position': 1.7}]}]
    source['load_combinations'] = []
    return source


def test_compilation_preserves_source_and_physics():
    source = model(); before = copy.deepcopy(source)
    mesh, receipt = compile_member_mesh(source)
    assert source == before
    assert [(r['start'], r['end']) for r in receipt['members']['beam']] == [(0, .8), (.8, 1.7), (1.7, 4.4), (4.4, 6)]
    expected, actual = solve(source, 'D'), solve(mesh, 'D')
    for field in ('displacements', 'reactions'):
        for node, components in expected[field].items():
            assert actual[field][node] == pytest.approx(components, rel=1e-11, abs=1e-11)
    records = plan_native_loads(mesh)
    assert len([row for row in records if row['targetType'] == 'beam']) == 2
    point, = [row for row in records if row['targetType'] == 'node']
    node = next(row for row in mesh['nodes'] if row['id'] == point['targetId'])
    assert (node['x'], node['z']) == (4.3, 3.)  # source beam is reversed
    assert point['nativeValues'] == [20., 0., 0., 0., 0., 0.]
    assert 'restraints' not in node


def test_releases_only_survive_at_original_outer_ends():
    source = model()
    member = next(row for row in source['elements'] if row['id'] == 'beam')
    member['releases'] = {'i': {'ry': True, 'rz': True}, 'j': {'ry': True, 'rz': True}}
    mesh, receipt = compile_member_mesh(source)
    by_id = {row['id']: row for row in mesh['elements']}
    segments = [by_id[row['id']] for row in receipt['members']['beam']]
    assert segments[0]['releases'] == {'i': {'ry': True, 'rz': True}}
    assert segments[-1]['releases'] == {'j': {'ry': True, 'rz': True}}
    assert all('releases' not in row for row in segments[1:-1])


def test_restore_retains_distinct_faces_and_unshares_context():
    mesh, receipt = compile_member_mesh(model())
    stations = {}
    for rows in receipt['members'].values():
        for segment in rows:
            stations[segment['id']] = [{'positionM': p, 'side': side, 'components':
                {'N': 0., 'Vy': 0., 'Vz': value, 'T': 0., 'My': 0., 'Mz': 0.}}
                for p, side, value in ((0., 'right', 2.), (segment['end']-segment['start'], 'left', 1.))]
    case = {'displacements': {n['id']: {} for n in mesh['nodes']}, 'reactions': {},
            'memberStations': stations, 'nativeContext': {'physicalModelHash': receipt['compiledModelHash']}}
    output = {'caseResults': {'D': case, 'L': copy.copy(case)}, 'summary': {}}
    result = restore_physical_results(output, receipt)
    for value in result['caseResults'].values():
        cut = [row for row in value['memberStations']['beam'] if row['positionM'] == 1.7]
        assert [(r['side'], r['components']['Vz']) for r in cut] == [('left', 1.), ('right', 2.)]
        assert len({r['nativeSegmentId'] for r in cut}) == 2
        assert set(value['displacements']) == set(receipt['physicalNodeIds'])
        assert value['nativeContext']['physicalModelHash'] == receipt['physicalModelHash']
    assert case['nativeContext']['physicalModelHash'] == receipt['compiledModelHash']
    case['nativeContext']['physicalModelHash'] = 'stale'
    with pytest.raises(ValueError, match='mesh'):
        restore_physical_results(output, receipt)


@pytest.mark.parametrize('patch', [{'start': 4., 'end': 2.}, {'start': 2., 'end': 2.}, {'end': 7.}, {'start': float('nan')}, {'distribution': 'piecewise_linear'}])
def test_invalid_extent_does_not_disappear(patch):
    source = model(); source['load_cases'][0]['loads'][0].update(patch)
    with pytest.raises(ValueError):
        compile_member_mesh(source)


def test_reference_equilibrium_uses_actual_interval_and_point_moment():
    path = ROOT/'backend/tests/analysis-pkpm-representative-native.py'
    spec = importlib.util.spec_from_file_location('pkpm_native_reference_cli', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    source = model()
    load = source['load_cases'][0]['loads'][1]
    load.update(my=3.)
    actual = module.external_resultant(source, source['load_cases'][0])
    assert actual == pytest.approx([0., 0., -45.2, 0., 3.4*25.2+4.3*20+3, 0.])
