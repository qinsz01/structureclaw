"""Seismic design basis checks: completeness, seismic grade, GB 18306, fortification category."""

from __future__ import annotations

from typing import Any, Dict, Optional

from .common import (
    _is_true,
    _normalize_seismic_grade,
    _number,
    _record,
)


def _design_basis_completeness_item(design_basis: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    missing = design_basis.get('missingInputs')
    missing_inputs = [str(item) for item in missing if str(item).strip()] if isinstance(missing, list) else []
    has_preliminary_flag = 'isPreliminary' in design_basis
    is_preliminary = _is_true(design_basis.get('isPreliminary')) or bool(missing_inputs)
    if not has_preliminary_flag and not missing_inputs:
        return None
    return {
        'item': '抗震设计依据完整性',
        'status': 'fail' if is_preliminary else 'pass',
        'utilization': 0.0,
        **({} if not is_preliminary else {
            'displayUtilization': 'N/A',
            'category': 'input_required',
            'failureType': 'design_basis_incomplete',
            'governingEligible': False,
            'message': 'Required seismic design-basis inputs are missing or still preliminary; confirm them before final compliance.',
        }),
        'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
        'formula': 'required seismic design-basis inputs are confirmed before final compliance',
        'inputs': {
            'missingInputs': missing_inputs,
            'isPreliminary': is_preliminary,
        },
    }


def _seismic_grade_design_basis_item(design_basis: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if 'seismicGrade' not in design_basis and 'seismicGradeSource' not in design_basis:
        return None
    raw_grade = design_basis.get('seismicGrade')
    grade = _normalize_seismic_grade(raw_grade)
    source = str(design_basis.get('seismicGradeSource') or '').strip()
    failed = grade is None
    return {
        'item': '抗震等级结构化依据',
        'status': 'fail' if failed else 'pass',
        'utilization': 9999.0 if failed else 0.0,
        'clause': 'GB/T 50011-2010(2024) 6.1 + 6.3/6.4',
        'formula': 'structured seismicGrade in {1, 2, 3, 4} is used by member seismic detailing and capacity checks',
        'inputs': {
            'seismicGrade': grade,
            'rawSeismicGrade': raw_grade,
            'seismicGradeSource': source or ('designBasis.seismicGrade' if grade is not None else None),
            'validGrades': [1, 2, 3, 4],
            'structuralFamily': design_basis.get('structuralFamily'),
            'heightM': design_basis.get('heightM'),
            'storyCount': design_basis.get('storyCount'),
            'intensity': design_basis.get('intensity'),
            'fortificationCategory': design_basis.get('fortificationCategory'),
            'seismicMeasureIntensity': design_basis.get('seismicMeasureIntensity'),
        },
        **({} if not failed else {
            'message': 'Structured seismic grade is missing or outside Grade 1 to Grade 4 while a seismicGrade field was supplied.',
        }),
    }


def _gb18306_standard_status_item(design_basis: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    code_basis = design_basis.get('codeBasis')
    if not isinstance(code_basis, list):
        return None
    records = [_record(item) for item in code_basis if isinstance(item, dict)]
    gb18306 = next((item for item in records if str(item.get('code') or '').strip() == 'GB 18306-2015'), {})
    if not gb18306:
        failed = True
        revision_plan = {}
        effective_amendment = {}
        status = ''
        review_conclusion = ''
        used_as_current_basis = False
    else:
        revision_plan = _record(gb18306.get('revisionPlan'))
        amendments = [item for item in gb18306.get('amendments', []) if isinstance(item, dict)]
        effective_amendment = next((item for item in amendments if str(item.get('status') or '').strip() == 'effective'), {})
        status = str(gb18306.get('standardStatus') or '').strip()
        review_conclusion = str(gb18306.get('lastReviewConclusion') or '').strip()
        used_as_current_basis = _is_true(revision_plan.get('usedAsCurrentBasis'))
        failed = (
            status != 'current'
            or review_conclusion != 'continue_valid'
            or used_as_current_basis
            or effective_amendment.get('no') != 'No.1'
            or effective_amendment.get('effectiveDate') != '2026-02-27'
        )
    return {
        'item': 'GB 18306标准状态',
        'status': 'fail' if failed else 'pass',
        'utilization': 9999.0 if failed else 0.0,
        'clause': 'GB 18306-2015',
        'formula': 'current GB 18306-2015 with No.1 effective amendment remains the formal zonation basis; drafting revision plans are trace-only until effective',
        'inputs': {
            'code': gb18306.get('code') if gb18306 else None,
            'standardStatus': status or None,
            'lastReviewConclusion': review_conclusion or None,
            'lastReviewDate': gb18306.get('lastReviewDate') if gb18306 else None,
            'effectiveAmendment': effective_amendment or None,
            'revisionPlan': revision_plan or None,
            'revisionPlanUsedAsCurrentBasis': used_as_current_basis,
        },
        **({} if not failed else {
            'message': 'GB 18306 standard-status trace is missing, not current, not marked continue-valid, missing the effective No.1 amendment, or a drafting revision plan was used as the current formal design basis.',
        }),
    }


def _fortification_category_key(category: str, code_class: str) -> str:
    key = category.strip().lower().replace('-', '_').replace(' ', '_')
    aliases = {
        'special': 'special',
        'special_fortification': 'special',
        'category_a': 'special',
        'a': 'special',
        'key': 'key',
        'important': 'key',
        'category_b': 'key',
        'b': 'key',
        'standard': 'standard',
        'normal': 'standard',
        'ordinary': 'standard',
        'category_c': 'standard',
        'c': 'standard',
        'moderate': 'moderate',
        'appropriate': 'moderate',
        'category_d': 'moderate',
        'd': 'moderate',
    }
    if key in aliases:
        return aliases[key]
    class_key = code_class.strip().upper()
    return {
        'A': 'special',
        'B': 'key',
        'C': 'standard',
        'D': 'moderate',
    }.get(class_key, '')


def _expected_fortification_trace(category_key: str, intensity: Optional[float]) -> Dict[str, Any]:
    trace = {
        'special': {
            'codeClass': 'A',
            'actionStandard': 'approved_seismic_safety_evaluation_higher_than_local_intensity',
            'measureStandard': 'increase_one_intensity_or_higher_than_9',
        },
        'key': {
            'codeClass': 'B',
            'actionStandard': 'local_fortification_intensity',
            'measureStandard': 'increase_one_intensity_or_higher_than_9',
        },
        'standard': {
            'codeClass': 'C',
            'actionStandard': 'local_fortification_intensity',
            'measureStandard': 'local_fortification_intensity',
        },
        'moderate': {
            'codeClass': 'D',
            'actionStandard': 'local_fortification_intensity',
            'measureStandard': 'may_reduce_with_conditions',
        },
    }.get(category_key, {})
    if intensity is None:
        return trace
    local_intensity = int(intensity)
    if category_key in {'special', 'key'}:
        trace['measureIntensity'] = min(local_intensity + 1, 10) if local_intensity < 9 else 10
    elif category_key == 'standard':
        trace['measureIntensity'] = local_intensity
    elif category_key == 'moderate':
        trace['measureIntensityRange'] = {
            'min': 6,
            'max': local_intensity,
        }
    return trace


def _fortification_category_item(design_basis: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    category = str(design_basis.get('fortificationCategory') or '').strip()
    if not category:
        return None
    code_class = str(design_basis.get('fortificationCategoryCodeClass') or '').strip()
    action_standard = str(design_basis.get('seismicActionStandard') or '').strip()
    measure_standard = str(design_basis.get('seismicMeasureStandard') or '').strip()
    measure_intensity = _number(design_basis.get('seismicMeasureIntensity'))
    intensity = _number(design_basis.get('intensity'))
    safety_required = _is_true(design_basis.get('seismicSafetyEvaluationRequired'))
    safety_provided = _is_true(design_basis.get('seismicSafetyEvaluationProvided'))
    category_key = _fortification_category_key(category, code_class)
    expected = _expected_fortification_trace(category_key, intensity)
    trace_missing = not code_class or not action_standard or not measure_standard or measure_intensity is None
    standard_mismatches = []
    expected_code_class = expected.get('codeClass')
    if expected_code_class and code_class.upper() != expected_code_class:
        standard_mismatches.append('fortificationCategoryCodeClass')
    expected_action = expected.get('actionStandard')
    if expected_action and action_standard != expected_action:
        standard_mismatches.append('seismicActionStandard')
    expected_measure = expected.get('measureStandard')
    if expected_measure and measure_standard != expected_measure:
        standard_mismatches.append('seismicMeasureStandard')
    expected_measure_intensity = expected.get('measureIntensity')
    if expected_measure_intensity is not None and measure_intensity is not None and int(measure_intensity) != int(expected_measure_intensity):
        standard_mismatches.append('seismicMeasureIntensity')
    expected_measure_range = expected.get('measureIntensityRange')
    if isinstance(expected_measure_range, dict) and measure_intensity is not None:
        minimum = _number(expected_measure_range.get('min'))
        maximum = _number(expected_measure_range.get('max'))
        if minimum is not None and maximum is not None and not (minimum <= measure_intensity <= maximum):
            standard_mismatches.append('seismicMeasureIntensity')
    failed = trace_missing or bool(standard_mismatches) or (safety_required and not safety_provided)
    return {
        'item': '抗震设防类别标准',
        'status': 'fail' if failed else 'pass',
        'utilization': 9999.0 if failed else 0.0,
        'clause': 'GB 55002-2021 2.3.2 + GB 50223-2008',
        'formula': 'fortification category determines seismic action standard, seismic measure standard, and safety-evaluation requirement',
        'inputs': {
            'fortificationCategory': category,
            'fortificationCategoryCodeClass': code_class or None,
            'expectedFortificationCategoryCodeClass': expected.get('codeClass'),
            'seismicActionStandard': action_standard or None,
            'expectedSeismicActionStandard': expected.get('actionStandard'),
            'seismicMeasureStandard': measure_standard or None,
            'expectedSeismicMeasureStandard': expected.get('measureStandard'),
            'seismicMeasureIntensity': int(measure_intensity) if measure_intensity is not None else None,
            'expectedSeismicMeasureIntensity': expected.get('measureIntensity'),
            'expectedSeismicMeasureIntensityRange': expected.get('measureIntensityRange'),
            'seismicSafetyEvaluationRequired': safety_required,
            'seismicSafetyEvaluationProvided': safety_provided,
            'traceMissing': trace_missing,
            'standardMismatches': standard_mismatches,
        },
        **({} if not failed else {
            'message': (
                'Structured fortification category trace is incomplete, inconsistent with GB 50223-derived '
                'standards, or a special fortification category lacks an approved seismic safety evaluation.'
            ),
        }),
    }
