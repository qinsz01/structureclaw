import base64
import copy
import json
from pathlib import Path
import struct
import sys

import pytest

SKILL = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SKILL), str(SKILL.parent / 'runtime'), str(SKILL.parents[2] / 'skill-shared/python')]
from native_displacements import read_native_displacements, NativeDisplacementUnavailable
from native_geometry import bind_native_geometry, NativeGeometryUnavailable
from native_settings import resolved_rigid_floor, control_parameters, verify_effective_settings


@pytest.fixture
def native(tmp_path):
    data = json.loads((Path(__file__).parent / 'fixtures/native-one-floor-diaphragm.json').read_text(encoding='utf8'))
    files = {name: base64.b64decode(value) for name, value in data['files'].items()}
    for name, value in files.items():
        (tmp_path / name).write_bytes(value)
    cases = {key: {tuple(row['node']): {k: row[k] for k in ('ux', 'uy', 'uz')} for row in rows}
             for key, rows in data['apiCases'].items()}
    return data, files, cases, tmp_path


def test_actual_mpc_source_floor_and_six_dof_readback(native):
    data, files, cases, directory = native
    geometry = bind_native_geometry(data['model'], data['snapshot'], files)
    groups = geometry['diaphragms']['groups']
    assert len(groups) == 1 and groups[0]['sourceStoryId'] == 's1'
    assert set(groups[0]['sourceNodeIds']) == {f't{i}' for i in range(6)}
    assert groups[0]['masterTag'] == 13
    assert len(geometry['supports']) == 6
    assert not geometry['diaphragms']['physicalSlabs']
    result = read_native_displacements(directory, data['nativeNodes'], cases)
    assert result['source']['kind'] == 'solver-native-file-and-api'
    for case in ('DL', 'LL', 'CRa'):
        for key, row in result['caseDisplacements'][case].items():
            assert set(row) == {'ux', 'uy', 'uz', 'rx', 'ry', 'rz'}
            assert row['ux'] == cases[case][key]['ux']
            assert row['uy'] == cases[case][key]['uy']
        assert len({row['rz'] for row in result['caseDisplacements'][case].values()}) == 1
    assert len({row['uz'] for row in result['caseDisplacements']['DL'].values()}) > 1
    assert len({row['rx'] for row in result['caseDisplacements']['CRa'].values()}) > 1


@pytest.mark.parametrize('mutation', ['sdk-motion', 'master-target', 'master-type', 'slave-type', 'source-setting'])
def test_mpc_cannot_be_inferred_from_incomplete_or_conflicting_evidence(native, mutation):
    data, files, cases, directory = native
    if mutation == 'source-setting':
        model = copy.deepcopy(data['model'])
        model['analysis_control']['rigid_floor'] = False
        model['stories'][0]['rigid_diaphragm'] = False
        with pytest.raises(NativeGeometryUnavailable, match='differ from source'):
            bind_native_geometry(model, data['snapshot'], files)
        return
    if mutation == 'sdk-motion':
        next(iter(cases['CRa'].values()))['ux'] += 1e-3
    elif mutation == 'master-target':
        blob = bytearray(files['NODEINDEX.SAT']); struct.pack_into('<f', blob, 8, 12.)
        (directory / 'NODEINDEX.SAT').write_bytes(blob)
    else:
        blob = bytearray(files['MESH.SAT']); tag = 13 if mutation == 'master-type' else 7
        struct.pack_into('<i', blob, 20 + (tag-1)*20 + 12, 0)
        (directory / 'MESH.SAT').write_bytes(blob)
    with pytest.raises(NativeDisplacementUnavailable):
        read_native_displacements(directory, data['nativeNodes'], cases)


def test_rigid_floor_is_explicit_and_does_not_create_a_slab(tmp_path):
    assert resolved_rigid_floor({'stories': [{'rigid_diaphragm': True}]}) is True
    integers, _ = control_parameters({'rigid_floor': True})
    assert integers == {606: 1, 607: 0}
    for model in ({'stories': [{'rigid_diaphragm': True}, {'rigid_diaphragm': False}]},
                  {'stories': [{'rigid_diaphragm': True}, {}]},
                  {'analysis_control': {'rigid_floor': True}, 'stories': [{'rigid_diaphragm': False}]}):
        with pytest.raises(Exception, match='mixed diaphragm'):
            resolved_rigid_floor(model)
    (tmp_path / 'WMASS.OUT').write_text('是否对全楼强制采用刚性楼板假定: 是', encoding='gb18030')
    (tmp_path / 'GOUJIAN.OUT').write_text('板总数=0', encoding='gb18030')
    assert verify_effective_settings(tmp_path, {'rigid_floor': True})['verified']
    (tmp_path / 'GOUJIAN.OUT').write_text('板总数=1', encoding='gb18030')
    with pytest.raises(RuntimeError, match='introduced slabs'):
        verify_effective_settings(tmp_path, {'rigid_floor': True})


def test_two_native_floors_keep_separate_masters_and_free_base_rotations(tmp_path):
    data = json.loads((Path(__file__).parent / 'fixtures/native-two-floor-diaphragm.json').read_text(encoding='utf8'))
    files = {name: base64.b64decode(value) for name, value in data['files'].items()}
    for name, value in files.items():
        (tmp_path / name).write_bytes(value)
    cases = {key: {tuple(row['node']): {k: row[k] for k in ('ux', 'uy', 'uz')} for row in rows}
             for key, rows in data['apiCases'].items()}
    geometry = bind_native_geometry(data['model'], data['snapshot'], files)
    groups = geometry['diaphragms']['groups']
    assert [(row['sourceStoryId'], row['masterTag']) for row in groups] == [('s1', 13), ('s2', 20)]
    assert geometry['supports']['b1']['nativeRestraints'] == [True]*3 + [False]*3
    result = read_native_displacements(tmp_path, data['nativeNodes'], cases)
    assert set(result['caseDisplacements']) == {'DL', 'LL', 'CRa', 'CRb'}
    for case, rows in result['caseDisplacements'].items():
        assert len(rows) == 12 and {floor for _, floor in rows} == {1, 2}
        assert len(result['constraintDisplacements'][case]) == 1
    for floor in (1, 2):
        rotations = {row['rz'] for (_, number), row in result['caseDisplacements']['CRa'].items() if floor == number}
        assert len(rotations) == 1
    assert len({row['rz'] for row in result['caseDisplacements']['CRa'].values()}) == 2
    # Binding another floor's master must fail even if its mesh marker is valid.
    blob = bytearray(files['NODEINDEX.SAT'])
    struct.pack_into('<f', blob, 12, 20.)
    (tmp_path / 'NODEINDEX.SAT').write_bytes(blob)
    with pytest.raises(NativeDisplacementUnavailable):
        read_native_displacements(tmp_path, data['nativeNodes'], cases)
