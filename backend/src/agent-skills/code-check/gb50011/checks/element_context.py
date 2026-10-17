"""Element context helpers: seismic grade, story/site data, axial demand and limits."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _element_context,
    _element_metadata,
    _is_transfer_frame_member,
    _is_true,
    _normalize_seismic_grade,
    _number,
    _record,
)
from .constants import (
    FRAME_COLUMN_AXIAL_RATIO_LIMITS,
)
from .reinforcement import (
    _dimension_mm,
)


def _column_position_text(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> str:
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    values = [
        element.get('columnPosition'),
        element.get('columnCategory'),
        metadata.get('columnPosition'),
        metadata.get('columnCategory'),
        element_context.get('columnPosition'),
        element_context.get('columnCategory'),
    ]
    return ' '.join(str(value).strip().lower() for value in values if value is not None)


def _is_corner_or_frame_supported_column(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> bool:
    metadata = _element_metadata(context, elem_id, element)
    position = _column_position_text(context, elem_id, element)
    return (
        _is_transfer_frame_member(context, elem_id, element)
        or _is_true(element.get('isCornerColumn'))
        or _is_true(metadata.get('isCornerColumn'))
        or 'corner' in position
        or 'angle' in position
        or '角' in position
        or 'frame-supported' in position
        or '框支' in position
    )


def _site_category_text(context: Dict[str, Any]) -> str:
    design_basis = _record(_record(context.get('analysisSummary')).get('designBasis'))
    site = _record(design_basis.get('siteSeismic'))
    value = site.get('siteCategory') or design_basis.get('siteCategory')
    return str(value or '').strip().upper().replace('类', '')


def _structured_high_rise(context: Dict[str, Any]) -> bool:
    design_basis = _record(_record(context.get('analysisSummary')).get('designBasis'))
    for key in ('isHighRise', 'highRise'):
        if _is_true(design_basis.get(key)):
            return True
    return False


def _story_count(context: Dict[str, Any]) -> Optional[int]:
    analysis_summary = _record(context.get('analysisSummary'))
    design_basis = _record(analysis_summary.get('designBasis'))
    model_summary = _record(analysis_summary.get('modelSummary'))
    summary = _record(analysis_summary.get('summary'))
    for value in (
        design_basis.get('storyCount'),
        model_summary.get('storyCount'),
        summary.get('storyCount'),
    ):
        number = _number(value)
        if number is not None and number > 0.0:
            return int(number)
    return None


def _frame_column_min_side_mm(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> Optional[float]:
    metadata = _element_metadata(context, elem_id, element)
    for value in (
        element.get('minColumnSideMm'),
        metadata.get('minColumnSideMm'),
        _record(_record(context.get('analysisSummary')).get('designBasis')).get('minFrameColumnSideMm'),
    ):
        limit = _number(value)
        if limit is not None and limit > 0.0:
            return limit

    grade = _seismic_grade(context, elem_id, element)
    stories = _story_count(context)
    if stories is not None and stories <= 2:
        return 300.0
    if grade == 4:
        return 300.0
    if grade in {1, 2, 3} and (stories is None or stories > 2):
        return 400.0
    return None


def _beam_span_mm(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    for source, label in (
        (element, 'element'),
        (metadata, 'metadata'),
        (element_context, 'elementContext'),
    ):
        for key in ('clearSpanMm', 'netSpanMm', 'spanMm', 'lengthMm'):
            value = _dimension_mm(source.get(key))
            if value is not None:
                return {'spanMm': value, 'source': f'{label}.{key}'}
        for key in ('clearSpanM', 'netSpanM', 'spanM', 'lengthM'):
            value = _number(source.get(key))
            if value is not None and value > 0.0:
                return {'spanMm': value * 1000.0, 'source': f'{label}.{key}'}
    length = _dimension_mm(element.get('length'))
    if length is not None:
        return {'spanMm': length, 'source': 'element.length'}
    length = _dimension_mm(element_context.get('length'))
    if length is not None:
        return {'spanMm': length, 'source': 'elementContext.length'}
    return None


def _seismic_grade(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> Optional[int]:
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    design_basis = _record(_record(context.get('analysisSummary')).get('designBasis'))
    for value in (
        element.get('seismicGrade'),
        element.get('antiSeismicGrade'),
        metadata.get('seismicGrade'),
        metadata.get('antiSeismicGrade'),
        element_context.get('seismicGrade'),
        design_basis.get('seismicGrade'),
        design_basis.get('antiSeismicGrade'),
    ):
        grade = _normalize_seismic_grade(value)
        if grade is not None:
            return grade
    return None


def _column_shear_span_ratio_info(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    for source, label in (
        (element, 'element'),
        (metadata, 'metadata'),
        (element_context, 'elementContext'),
    ):
        for key in (
            'shearSpanRatio',
            'columnShearSpanRatio',
            'columnLambda',
            'lambda',
        ):
            ratio = _number(source.get(key))
            if ratio is not None and ratio > 0.0:
                return {
                    'ratio': ratio,
                    'source': f'{label}.{key}',
                }
    return None


def _frame_column_axial_limit_info(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
    grade: int,
) -> Dict[str, Any]:
    metadata = _element_metadata(context, elem_id, element)
    design_basis = _record(_record(context.get('analysisSummary')).get('designBasis'))
    for value, source in (
        (element.get('axialCompressionRatioLimit'), 'element.axialCompressionRatioLimit'),
        (metadata.get('axialCompressionRatioLimit'), 'metadata.axialCompressionRatioLimit'),
        (design_basis.get('frameColumnAxialCompressionRatioLimit'), 'designBasis.frameColumnAxialCompressionRatioLimit'),
    ):
        limit = _number(value)
        if limit is not None and limit > 0.0:
            return {
                'limit': limit,
                'baseLimit': FRAME_COLUMN_AXIAL_RATIO_LIMITS[grade],
                'manualAdjustment': 0.0,
                'shearSpanRatio': None,
                'shearSpanRatioSource': None,
                'shearSpanLimitAdjustment': 0.0,
                'limitSource': source,
            }

    adjustment = 0.0
    adjustment_source = None
    for value, source in (
        (element.get('axialCompressionRatioLimitAdjustment'), 'element.axialCompressionRatioLimitAdjustment'),
        (metadata.get('axialCompressionRatioLimitAdjustment'), 'metadata.axialCompressionRatioLimitAdjustment'),
        (design_basis.get('frameColumnAxialCompressionRatioLimitAdjustment'), 'designBasis.frameColumnAxialCompressionRatioLimitAdjustment'),
    ):
        number = _number(value)
        if number is not None:
            adjustment = number
            adjustment_source = source
            break

    shear_info = _column_shear_span_ratio_info(context, elem_id, element)
    shear_ratio = _number(shear_info.get('ratio')) if shear_info else None
    shear_adjustment = -0.05 if shear_ratio is not None and shear_ratio <= 2.0 else 0.0
    base_limit = FRAME_COLUMN_AXIAL_RATIO_LIMITS[grade]
    return {
        'limit': max(0.10, base_limit + adjustment + shear_adjustment),
        'baseLimit': base_limit,
        'manualAdjustment': adjustment,
        'manualAdjustmentSource': adjustment_source,
        'shearSpanRatio': shear_ratio,
        'shearSpanRatioSource': shear_info.get('source') if shear_info else None,
        'shearSpanLimitAdjustment': shear_adjustment,
        'limitSource': 'GB/T 50011 table by seismic grade',
    }


def _axial_compression_ratio_limit(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
    grade: int,
) -> float:
    return float(_frame_column_axial_limit_info(context, elem_id, element, grade)['limit'])


def _member_combination_axial_demand_kn(analysis_summary: Dict[str, Any], elem_id: str) -> Optional[float]:
    combinations = _record(analysis_summary.get('memberDesignActionCombinations'))
    cases = combinations.get('cases')
    if not isinstance(cases, list):
        return None
    max_axial = 0.0
    found = False
    for raw_case in cases:
        case = _record(raw_case)
        actions = case.get('memberActions')
        if not isinstance(actions, list):
            continue
        for raw_action in actions:
            action = _record(raw_action)
            if str(action.get('elementId') or '') != elem_id:
                continue
            axial = _number(action.get('maxAbsAxialKN'))
            if axial is None:
                continue
            max_axial = max(max_axial, abs(axial))
            found = True
    return max_axial if found else None


def _member_combination_action_entries(analysis_summary: Dict[str, Any], elem_id: str) -> List[Dict[str, Any]]:
    combinations = _record(analysis_summary.get('memberDesignActionCombinations'))
    cases = combinations.get('cases')
    if not isinstance(cases, list):
        return []
    entries: List[Dict[str, Any]] = []
    for raw_case in cases:
        case = _record(raw_case)
        case_name = str(case.get('name') or '')
        actions = case.get('memberActions')
        if not isinstance(actions, list):
            continue
        for raw_action in actions:
            action = _record(raw_action)
            if str(action.get('elementId') or '') != elem_id:
                continue
            entries.append({
                **action,
                'case': case_name,
            })
    return entries


def _element_axial_demand_kn(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> Optional[float]:
    from_combinations = _member_combination_axial_demand_kn(_record(context.get('analysisSummary')), elem_id)
    if from_combinations is not None:
        return from_combinations

    forces = _record(element.get('forces'))
    direct_kn = _number(forces.get('maxAbsAxialKN')) or _number(element.get('maxAbsAxialKN'))
    if direct_kn is not None:
        return abs(direct_kn)
    axial_n = _number(forces.get('N')) or _number(forces.get('axial')) or _number(element.get('N'))
    if axial_n is not None:
        return abs(axial_n) / 1000.0
    return None
