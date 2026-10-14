from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

ADAPTER = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ADAPTER), str(ADAPTER.parent/'runtime'), str(ADAPTER.parents[2]/'skill-shared/python')]
from yjk_self_weight import compile_self_weight
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
