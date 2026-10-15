"""Result-truth regressions exercise the production checker, with no solver mocks."""
import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location('truth_code_checker', Path(__file__).parents[1] / 'code_check.py')
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
CodeChecker = _module.CodeChecker


def test_steel_missing_inputs_name_design_strength_without_requesting_available_forces():
    element = {'type': 'beam', 'section': {'A': 5000, 'Wnx': 200000},
               'material': {'fy': 235}, 'forces': {'N': 0, 'Mx': 2500000, 'V': 500}}
    result = CodeChecker('GB50017').check('m', ['beam'], {'elementData': {'beam': element}})
    item = result['details'][0]['checks'][0]['items'][0]
    assert item['status'] == 'input_required'
    assert [row['field'] for row in item['missingInputs']] == ['material.design.f']
    assert item['missingInputs'][0]['unit'] == 'MPa'


def test_steel_deflection_missing_inputs_distinguish_service_selection_and_computed_response():
    element = {'type': 'beam', 'section': {}, 'material': {}, 'forces': {},
               'length': 10000, 'serviceabilityResult': False}
    result = CodeChecker('GB50017').check('m', ['beam'], {'elementData': {'beam': element}})
    item = next(item for group in result['details'][0]['checks'] for item in group['items'] if item['item'] == '挠度')
    fields = {row['field']: row for row in item['missingInputs']}
    assert fields['response.deflection']['source'] == 'result'
    assert fields['member.design.serviceability_result_keys']['source'] == 'design'
    assert 'member.design.deflectionLimitN' in fields
    assert 'member.length' not in fields


@pytest.mark.parametrize('code', ['GB50017', 'GB50010'])
def test_explicit_non_service_case_is_not_a_missing_deflection_or_a_pass(code):
    element = {'type':'beam','section':{},'material':{},'forces':{},'serviceabilityResult':False,'serviceabilityExcluded':True}
    result = CodeChecker(code).check('m',['beam'],{'elementData':{'beam':element}})
    item = next(item for group in result['details'][0]['checks'] for item in group['items'] if item['item']=='挠度')
    assert item['status']=='not_applicable' and item['utilization'] is None
    assert item['governingEligible'] is False and not item.get('missingInputs')
    assert result['complianceStatus']=='incomplete'  # Other design inputs are still missing.


@pytest.mark.parametrize('code', ['GB50017', 'GB50010', 'GB50011'])
def test_absent_inputs_never_pass_or_have_controlling_utilization(code):
    result = CodeChecker(code).check('m', ['E1', 'renamed-element'], {})
    assert result['completionStatus'] == 'incomplete'
    assert result['complianceStatus'] == 'incomplete'
    assert result['summary']['passed'] == 0
    assert result['summary']['inputRequired'] > 0
    assert result['summary']['maxUtilization'] is None
    assert result['summary']['controllingElement'] is None


@pytest.mark.parametrize('value', [float('nan'), float('inf'), -1, True])
def test_invalid_override_is_not_an_engineering_result(value):
    result = CodeChecker('GB50017').check('m', ['E1'], {'utilizationByElement': {'E1': {'正应力': value}}})
    assert result['details'][0]['checks'][0]['items'][0]['status'] == 'input_required'


def test_real_failure_and_missing_information_are_counted_separately():
    result = CodeChecker('GB50017').check('m', ['E1'], {'utilizationByElement': {'E1': {'正应力': 1.2}}})
    assert result['summary']['failed'] == 1
    assert result['summary']['inputRequired'] > 0
    assert result['complianceStatus'] == 'fail'
    assert result['completionStatus'] == 'incomplete'
    assert result['summary']['maxUtilization'] == 1.2


def test_each_station_is_checked_without_splicing_component_maxima():
    element = {
        'type': 'beam', 'section': {'A': 10, 'Wnx': 10}, 'material': {'f': 10},
        'forceCoverage': 'endpoints_only',
        'forceStates': [
            {'station': 'n1', 'forces': {'N': 80, 'Mx': 0}},
            {'station': 'n2', 'forces': {'N': 0, 'Mx': 90}},
        ],
    }
    result = CodeChecker('GB50017').check('m', ['B1'], {'elementData': {'B1': element}})
    normal = result['details'][0]['checks'][0]['items'][0]
    assert normal['utilization'] == pytest.approx(0.9)  # mixed maxima would incorrectly give 1.7
    assert normal['forceState']['station'] == 'n2'
    assert normal['checkedForceStateCount'] == 2
    assert result['details'][0]['forceCoverage'] == 'endpoints_only'


def test_biaxial_capability_gap_is_not_reported_as_failure_or_pass():
    context = {'elementData': {'B1': {'type': 'beam', 'forceStates': [
        {'station': 'n1', 'forces': {'N': 0, 'Mx': 10}, 'unsupportedReason': 'biaxial'},
    ]}}}
    result = CodeChecker('GB50017').check('m', ['B1'], context)
    assert result['summary']['unsupported'] > 0
    assert result['summary']['failed'] == 0
    assert result['complianceStatus'] == 'incomplete'


def test_unknown_concrete_material_rebar_and_service_moment_are_not_invented():
    context = {'elementData': {'B1': {'type': 'beam', 'section': {'width': 300, 'height': 500},
                                   'forces': {'N': 0, 'V': 1000, 'Mx': 10000}, 'length': 6000}}}
    result = CodeChecker('GB50010').check('m', ['B1'], context)
    assert result['summary']['passed'] == 0
    assert result['summary']['maxUtilization'] is None


def test_empty_requested_scope_is_not_vacuously_passed():
    result = CodeChecker('GB50017').check('m', [], {})
    assert result['completionStatus'] == 'incomplete'
    assert result['complianceStatus'] == 'incomplete'
