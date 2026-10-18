"""Code-determined design values: GB 50017-2017 Table 4.4.1, clause factors, GB 50010 tables, sources."""
import importlib.util
import math
import sys
from pathlib import Path

import pytest

_CHECK_DIR = Path(__file__).parents[1]
sys.path.insert(0, str(_CHECK_DIR.parents[1] / 'skill-shared' / 'python'))
from structure_protocol.design_code_tables import (  # noqa: E402
    CONCRETE_GRADES, REBAR_GRADES, concrete_value, epsilon_k, rebar_value, steel_strength,
)

_spec = importlib.util.spec_from_file_location('values_code_checker', _CHECK_DIR / 'code_check.py')
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
CodeChecker = _module.CodeChecker

# (grade, thickness inside the group, f, fv, fy) for every row of the reviewed table.
TABLE_4_4_1_ROWS = [
    ('Q235', 10, 215, 125, 235), ('Q235', 20, 205, 120, 225), ('Q235', 60, 200, 115, 215),
    ('Q355', 10, 305, 175, 355), ('Q355', 20, 295, 170, 345), ('Q355', 50, 290, 165, 335),
    ('Q355', 70, 280, 160, 325), ('Q355', 90, 270, 155, 315),
    ('Q390', 10, 345, 200, 390), ('Q390', 20, 330, 190, 380), ('Q390', 50, 310, 180, 360), ('Q390', 80, 295, 170, 340),
    ('Q420', 10, 375, 215, 420), ('Q420', 20, 355, 205, 410), ('Q420', 50, 320, 185, 390), ('Q420', 80, 305, 175, 370),
    ('Q460', 10, 410, 235, 460), ('Q460', 20, 390, 225, 450), ('Q460', 50, 355, 205, 430), ('Q460', 80, 340, 195, 410),
]


@pytest.mark.parametrize('grade,thickness,f,fv,fy', TABLE_4_4_1_ROWS)
def test_table_4_4_1_rows(grade, thickness, f, fv, fy):
    value = steel_strength(grade, thickness)
    assert (value['f'], value['fv'], value['fy']) == (f, fv, fy)
    assert value['source'].startswith(f'GB 50017-2017 表4.4.1, {grade}, t={thickness}mm')


@pytest.mark.parametrize('grade,upper,below,above', [
    ('Q235', 16, (215, 125, 235), (205, 120, 225)), ('Q235', 40, (205, 120, 225), (200, 115, 215)),
    ('Q355', 16, (305, 175, 355), (295, 170, 345)), ('Q355', 40, (295, 170, 345), (290, 165, 335)),
    ('Q355', 63, (290, 165, 335), (280, 160, 325)), ('Q355', 80, (280, 160, 325), (270, 155, 315)),
    ('Q390', 16, (345, 200, 390), (330, 190, 380)), ('Q390', 63, (310, 180, 360), (295, 170, 340)),
    ('Q420', 40, (355, 205, 410), (320, 185, 390)), ('Q460', 63, (355, 205, 430), (340, 195, 410)),
])
def test_thickness_group_boundaries_belong_to_the_lower_group(grade, upper, below, above):
    at = steel_strength(grade, upper)
    over = steel_strength(grade, upper + 0.1)
    assert (at['f'], at['fv'], at['fy']) == below
    assert (over['f'], over['fv'], over['fy']) == above


def test_source_records_grade_thickness_and_group():
    assert steel_strength('Q355', 9)['source'] == 'GB 50017-2017 表4.4.1, Q355, t=9mm≤16'
    assert steel_strength('Q355B', 16.1)['source'] == 'GB 50017-2017 表4.4.1, Q355, t=16.1mm, 16<t≤40'
    assert steel_strength('q235c', 16)['group'] == 't≤16'


@pytest.mark.parametrize('grade,thickness', [('Q355', 100.1), ('Q235', 0), ('Q999', 10), ('C30', 10), (None, 10), ('Q355', float('nan'))])
def test_outside_the_table_returns_none(grade, thickness):
    assert steel_strength(grade, thickness) is None


def test_epsilon_k_uses_the_grade_yield():
    assert epsilon_k('Q235') == pytest.approx(1.0)
    assert epsilon_k('Q355D') == pytest.approx(math.sqrt(235 / 355))


def test_gb50010_tables_and_sources():
    assert (CONCRETE_GRADES['C30']['fc'], CONCRETE_GRADES['C30']['ft']) == (14.3, 1.43)
    assert (CONCRETE_GRADES['C40']['fc'], CONCRETE_GRADES['C40']['ft']) == (19.1, 1.71)
    assert REBAR_GRADES['HRB400']['fy'] == 360 and REBAR_GRADES['HRB500']['fy'] == 435
    assert REBAR_GRADES['HRB500']['fy_compression'] == 410 and REBAR_GRADES['HRB500']['fyv'] == 360
    assert REBAR_GRADES['HPB300']['fy'] == 270
    assert concrete_value('c30', 'fc') == {'value': 14.3, 'source': 'GB 50010-2010 表4.1.4-1, C30'}
    assert rebar_value('HRB400', 'fy') == {'value': 360.0, 'source': 'GB 50010-2010 表4.2.3-1, HRB400'}
    assert rebar_value(None, 'fy') is None


# GB 50010-2010 6.2.6: α1 = 1.0 and β1 = 0.8 up to C50, then linear to 0.94 / 0.74 at C80.
@pytest.mark.parametrize('grade,alpha1,beta1', [
    ('C15', 1.0, 0.80), ('C20', 1.0, 0.80), ('C25', 1.0, 0.80), ('C30', 1.0, 0.80), ('C35', 1.0, 0.80),
    ('C40', 1.0, 0.80), ('C45', 1.0, 0.80), ('C50', 1.0, 0.80), ('C55', 0.99, 0.79), ('C60', 0.98, 0.78),
    ('C65', 0.97, 0.77), ('C70', 0.96, 0.76), ('C75', 0.95, 0.75), ('C80', 0.94, 0.74),
])
def test_gb50010_6_2_6_rectangular_stress_block_factors(grade, alpha1, beta1):
    assert (CONCRETE_GRADES[grade]['alpha1'], CONCRETE_GRADES[grade]['beta1']) == (alpha1, beta1)


def test_gb50010_table_covers_exactly_c15_to_c80():
    assert list(CONCRETE_GRADES) == [f'C{n}' for n in range(15, 85, 5)]


def _hn300(material, **overrides):
    H, B, tw, tf = 300, 150, 6.5, 9
    hw = H - 2 * tf
    inertia = tw * hw ** 3 / 12 + 2 * B * tf ** 3 / 12 + 2 * B * tf * ((hw + tf) / 2) ** 2
    return {'type': 'beam', 'section': {'A': tw * hw + 2 * B * tf, 'I': inertia, 'Wnx': inertia / 150, 'Wx': inertia / 150,
            'S': B * tf * (hw + tf) / 2 + tw * hw ** 2 / 8, 'tw': tw, 'shape': {'kind': 'H', 'H': H, 'B': B, 'tw': tw, 'tf': tf}},
            'material': material, 'forces': {'N': 0, 'V': 5000, 'Mx': 15e6}, 'length': 6000, **overrides}


def _items(detail):
    return {item['item']: item for group in detail['checks'] for item in group['items']}


def test_explicit_steel_beam_check_uses_table_values_and_lists_judgment_inputs():
    result = CodeChecker('GB50017').check('m', ['1'], {'elementData': {'1': _hn300({'grade': 'Q355', 'E': 206000, 'fy': 355})}})
    detail = result['details'][0]
    items = _items(detail)
    assert items['正应力']['status'] == 'pass'
    assert items['正应力']['inputs']['capacity'] == 305
    assert items['正应力']['utilization'] == pytest.approx(15e6 / (69325191.0 / 150) / 305, abs=1e-4)
    assert items['剪应力']['inputs']['capacity'] == 175
    assert items['折算应力']['status'] == 'pass' and items['局部稳定']['status'] == 'pass'
    assert items['长细比']['status'] == 'not_applicable'
    assert [row['field'] for row in items['整体稳定']['missingInputs']] == ['member.design.phi_b']
    assert 'member.design.deflectionLimitN' in [row['field'] for row in items['挠度']['missingInputs']]
    values = {row['field']: row for row in detail['designValues']}
    assert values['material.design.f'] == {'field': 'material.design.f', 'value': 305.0, 'unit': 'MPa', 'origin': 'code-table',
                                           'source': 'GB 50017-2017 表4.4.1, Q355, t=9mm≤16'}
    assert values['material.design.fv']['value'] == 175.0
    assert values['material.fy']['value'] == 355.0
    assert values['member.design.beta1']['value'] == 1.1 and '6.1.5' in values['member.design.beta1']['source']
    assert values['epsilonK']['value'] == pytest.approx(math.sqrt(235 / 355), abs=1e-6)
    assert values['member.design.btLimit']['value'] == pytest.approx(15 * math.sqrt(235 / 355), abs=1e-5)
    assert values['member.design.webLimit']['value'] == pytest.approx(124 * math.sqrt(235 / 355), abs=1e-5)
    assert values['section.b']['value'] == pytest.approx(71.75) and values['section.h0']['value'] == 282
    assert all(row['source'] for row in detail['designValues'])
    assert 'member.design.lambdaLimit' not in values


def test_model_values_override_table_values():
    material = {'grade': 'Q355', 'f': 290.0, 'fv': 160.0}
    result = CodeChecker('GB50017').check('m', ['1'], {'elementData': {'1': _hn300(material, beta1=1.2)}})
    detail = result['details'][0]
    assert _items(detail)['正应力']['inputs']['capacity'] == 290
    values = {row['field']: row for row in detail['designValues']}
    assert values['material.design.f']['origin'] == 'model-input' and values['material.design.f']['value'] == 290
    assert values['material.design.fv']['value'] == 160
    assert 'member.design.beta1' not in values


def test_thicker_flange_selects_the_next_group():
    element = _hn300({'grade': 'Q355'})
    element['section']['shape'] = {**element['section']['shape'], 'tf': 18}
    detail = CodeChecker('GB50017').check('m', ['1'], {'elementData': {'1': element}})['details'][0]
    values = {row['field']: row for row in detail['designValues']}
    assert values['material.design.f']['value'] == 295
    assert values['material.design.f']['source'] == 'GB 50017-2017 表4.4.1, Q355, t=18mm, 16<t≤40'


def test_unknown_grade_keeps_strength_missing():
    result = CodeChecker('GB50017').check('m', ['1'], {'elementData': {'1': _hn300({'grade': 'S355'})}})
    item = _items(result['details'][0])['正应力']
    assert item['status'] == 'input_required'
    assert [row['field'] for row in item['missingInputs']] == ['material.design.f']


def test_column_gets_the_code_slenderness_limit_but_not_an_effective_length():
    column = {'type': 'column', 'section': {'A': 8000.0, 'imin': 40.0, 'b': 100.0, 't': 12.0},
              'material': {'grade': 'Q235'}, 'forces': {'N': 100000.0}, 'length': 4000.0}
    detail = CodeChecker('GB50017').check('m', ['C1'], {'elementData': {'C1': column}})['details'][0]
    values = {row['field']: row for row in detail['designValues']}
    assert values['member.design.lambdaLimit']['value'] == 150
    assert values['material.design.f']['value'] == 215
    item = _items(detail)['长细比']
    assert [row['field'] for row in item['missingInputs']] == ['member.design.l0']


def test_concrete_check_records_table_sources_and_lists_missing_rebar_strength():
    beam = {'type': 'beam', 'section': {'A': 300 * 600, 'width': 300, 'height': 600, 'I': 300 * 600 ** 3 / 12},
            'material': {'grade': 'C30'}, 'forces': {'N': 0, 'V': 50000, 'Mx': 80e6}, 'length': 6000, 'h0': 560}
    detail = CodeChecker('GB50010').check('m', ['B1'], {'elementData': {'B1': beam}})['details'][0]
    values = {row['field']: row for row in detail['designValues']}
    assert values['material.design.fc'] == {'field': 'material.design.fc', 'value': 14.3, 'unit': 'MPa', 'origin': 'code-table',
                                            'source': 'GB 50010-2010 表4.1.4-1, C30'}
    assert values['material.design.ft']['value'] == 1.43
    assert 'material.design.fy' not in values
    bending = _items(detail)['正截面受弯']
    fields = [row['field'] for row in bending['missingInputs']]
    assert 'material.design.fy' in fields and 'member.design.reinforcement.values.As' in fields
    assert 'material.design.fc' not in fields


def test_concrete_rebar_grade_is_looked_up_when_given():
    beam = {'type': 'beam', 'section': {'A': 300 * 600, 'width': 300, 'height': 600}, 'material': {'grade': 'C30'},
            'forces': {'Mx': 80e6}, 'length': 6000}
    context = {'elementData': {'B1': beam}, 'elementContextById': {'B1': {'type': 'beam', 'rebarGrade': 'HRB400'}}}
    detail = CodeChecker('GB50010').check('m', ['B1'], context)['details'][0]
    values = {row['field']: row for row in detail['designValues']}
    assert values['material.design.fy'] == {'field': 'material.design.fy', 'value': 360.0, 'unit': 'MPa', 'origin': 'code-table',
                                            'source': 'GB 50010-2010 表4.2.3-1, HRB400'}


def test_q345_is_not_in_table_4_4_1_and_is_listed_as_missing_with_the_successor_hint():
    assert steel_strength('Q345', 9) is None and epsilon_k('Q345B') is None
    detail = CodeChecker('GB50017').check('m', ['1'], {'elementData': {'1': _hn300({'grade': 'Q345B'})}})['details'][0]
    assert 'material.design.f' not in {row['field'] for row in detail['designValues']}
    rows = {row['field']: row for row in _items(detail)['正应力']['missingInputs']}
    assert 'Q355' in rows['material.design.f']['hint'] and 'Q345' in rows['material.design.f']['hint']
    shear = {row['field']: row for row in _items(detail)['剪应力']['missingInputs']}
    assert 'Q355' in shear['material.design.fv']['hint']


def test_unknown_grade_gets_no_successor_hint():
    detail = CodeChecker('GB50017').check('m', ['1'], {'elementData': {'1': _hn300({'grade': 'S355'})}})['details'][0]
    assert all('hint' not in row for row in _items(detail)['正应力']['missingInputs'])
