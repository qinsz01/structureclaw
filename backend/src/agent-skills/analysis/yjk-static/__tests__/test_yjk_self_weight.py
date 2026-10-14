from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

ADAPTER = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ADAPTER), str(ADAPTER.parent/'runtime'), str(ADAPTER.parents[2]/'skill-shared/python')]
from yjk_self_weight import compile_self_weight, restore_physical_compilation
from yjk_native_loads import compile_load_definitions
from yjk_native_design import compile_design_request


def model():
    result = json.loads((ADAPTER/'__tests__/fixtures/native-design-concrete-model.json').read_text('utf8'))
    result['analysis_control']['self_weight'] = True
    return result


def test_weight_uses_source_area_density_and_one_resolved_case_without_mutation():
    source = model(); original = deepcopy(source)
    plan = compile_self_weight(source)
    assert plan['loadCaseId'] == 'D' and plan['caseSource'] == 'unique-dead-case'
    assert len(plan['members']) == len(source['elements'])
    for member in plan['members']:
        assert member['intensityKnM'] == pytest.approx(-2500*.18*9.80665/1000)
        assert member['totalForceKn'] == pytest.approx(member['intensityKnM']*member['lengthM'])
        assert member['intensityVectorKnM'] == [0., 0., member['intensityKnM']]
        assert member['totalForceVectorKn'] == [0., 0., member['totalForceKn']]
    cases = compile_load_definitions(source)
    assert all('derivedSelfWeight' not in row for row in cases[1]['loads'])
    assert sum('derivedSelfWeight' in row for row in cases[0]['loads']) == len(source['elements'])
    assert source == original
    assert len(plan['physicalCompilation']) == len(plan['members'])
    assert all(row['sourceSegmentId'] == row['physicalElementId'] and row['startM'] == 0
               for row in plan['physicalCompilation'])


def test_custom_area_and_density_never_use_reference_carrier_geometry():
    source = model()
    for section in source['sections']:
        section.pop('shape'); section['type'] = 'custom'; section['properties']['A'] = .0137
    source['materials'][0]['rho'] = 7123
    for member in compile_self_weight(source)['members']:
        assert member['areaM2'] == .0137
        assert member['intensityKnM'] == pytest.approx(-7123*.0137*9.80665/1000)


def test_explicit_upward_weight_case_and_gravity_are_preserved():
    source = model()
    source['analysis_control'].update(self_weight_case_id='L', gravity_direction='z', gravity_m_s2=9.8)
    plan = compile_self_weight(source)
    assert plan['loadCaseId'] == 'L' and all(row['intensityKnM'] > 0 for row in plan['members'])
    cases = compile_load_definitions(source)
    assert all('derivedSelfWeight' not in row for row in cases[0]['loads'])
    assert any('derivedSelfWeight' in row for row in cases[1]['loads'])


def test_inclined_column_and_horizontal_gravity_cannot_silently_drop_loads():
    source = model(); source['nodes'][4]['x'] += .3
    with pytest.raises(ValueError, match='inclined-column'):
        compile_self_weight(source)
    source = model(); source['analysis_control']['gravity_direction'] = '-x'
    with pytest.raises(ValueError, match='horizontal gravity'):
        compile_self_weight(source)


def test_design_adopts_same_weight_compilation_and_keeps_native_weight_disabled():
    source = model()
    plan = compile_design_request({'requested': True, 'code': 'GB/T50010-2010(2024)',
                                  'adoptedNativeDefaults': True}, source)
    assert plan['selfWeight'] == compile_self_weight(source)
    assert plan['parameters']['float'] == {'801': 0., '803': 0.}


def test_mesh_weight_mapping_preserves_original_members_and_exact_load_intervals():
    from member_mesh import compile_member_mesh
    source = model()
    source['load_cases'][0]['loads'].append({'type': 'point', 'element': 'BX0', 'position': 1.7, 'fz': -5})
    mesh, receipt = compile_member_mesh(source)
    compiled = compile_self_weight(mesh); original = deepcopy(compiled)
    result = restore_physical_compilation(compiled, receipt)
    assert compiled == original and result['members'] == compiled['members']
    rows = [row for row in result['physicalCompilation'] if row['physicalElementId'] == 'BX0']
    assert [(row['startM'], row['endM']) for row in rows] == [(0., 1.7), (1.7, 6.)]
    assert all(row['sourceSegmentId'].startswith('__yjk__BX0__s') for row in rows)
    assert sum(row['endM']-row['startM'] for row in rows) == 6
    assert all(row['intensityVectorKnM'] == [0, 0, -4.4129925] for row in rows)


@pytest.mark.parametrize('bad', ['gap', 'overlap', 'duplicate', 'missing'])
def test_mesh_weight_mapping_rejects_gaps_duplicates_and_missing_native_segments(bad):
    from member_mesh import compile_member_mesh
    source = model()
    source['load_cases'][0]['loads'].append({'type': 'point', 'element': 'BX0', 'position': 1.7, 'fz': -5})
    mesh, receipt = compile_member_mesh(source); compiled = compile_self_weight(mesh)
    if bad in ('gap', 'overlap'):
        receipt['members']['BX0'][1]['start'] += .01 if bad == 'gap' else -.01
    elif bad == 'duplicate':
        receipt['members']['BX0'][1]['id'] = receipt['members']['BX0'][0]['id']
    else:
        receipt['members']['BX0'].pop()
    with pytest.raises(ValueError):
        restore_physical_compilation(compiled, receipt)
