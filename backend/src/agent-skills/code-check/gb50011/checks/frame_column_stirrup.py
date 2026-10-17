"""Frame column stirrup checks: detailing, confined zone range, volume ratio."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _aggregate_check_status,
    _element_context,
    _element_metadata,
    _is_concrete_frame_column,
    _is_false,
    _is_transfer_frame_member,
    _is_true,
    _material_strength_mpa,
    _number,
    _ratio_percent_from_sources,
    _record,
)
from .constants import (
    C35_DESIGN_STRENGTH_MPA,
    FRAME_COLUMN_STIRRUP_CHARACTERISTIC_VALUES,
    FRAME_COLUMN_STIRRUP_CHARACTERISTIC_VALUE_BINS,
)
from .element_context import (
    _column_shear_span_ratio_info,
    _element_axial_demand_kn,
    _is_corner_or_frame_supported_column,
    _seismic_grade,
)
from .reinforcement import (
    _column_longitudinal_reinforcement_group,
    _column_stirrup_group,
    _dimension_from_keys_mm,
    _dimension_mm,
    _reinforcement_data,
    _reinforcement_diameter_mm,
    _section_dimension_mm,
    _structured_rebar_strength_mpa,
)


def _column_stirrup_volume_ratio_percent(reinforcement: Dict[str, Any], stirrup: Dict[str, Any]) -> Optional[float]:
    return _ratio_percent_from_sources(
        (stirrup, reinforcement),
        (
            'volumeRatioPercent',
            'volumetricRatioPercent',
            'rhoVPercent',
            'stirrupVolumeRatioPercent',
            'confinedVolumeRatioPercent',
        ),
        (
            'volumeRatio',
            'volumetricRatio',
            'rhoV',
            'stirrupVolumeRatio',
            'confinedVolumeRatio',
        ),
    )


def _column_non_confined_stirrup_volume_ratio_percent(
    reinforcement: Dict[str, Any],
    stirrup: Dict[str, Any],
) -> Optional[float]:
    return _ratio_percent_from_sources(
        (stirrup, reinforcement),
        (
            'nonConfinedVolumeRatioPercent',
            'unconfinedVolumeRatioPercent',
            'nonConfinedRhoVPercent',
        ),
        (
            'nonConfinedVolumeRatio',
            'unconfinedVolumeRatio',
            'nonConfinedRhoV',
        ),
    )


def _column_stirrup_type_key(stirrup: Dict[str, Any]) -> str:
    raw = str(
        stirrup.get('stirrupType')
        or stirrup.get('hoopType')
        or stirrup.get('configuration')
        or ''
    ).strip().lower().replace('-', '_').replace(' ', '_')
    if raw in {
        'spiral',
        'spiral_hoop',
        'compound_spiral',
        'composite_spiral',
        'compound_rectangular_spiral',
        'continuous_compound_rectangular_spiral',
        '螺旋箍',
        '复合螺旋箍',
        '连续复合矩形螺旋箍',
    }:
        return 'spiral'
    return 'ordinary'


def _column_stirrup_yield_strength_mpa(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
    reinforcement: Dict[str, Any],
    stirrup: Dict[str, Any],
) -> Optional[float]:
    material = _record(element.get('material'))
    for source in (stirrup, reinforcement, material):
        for key in ('fyvMPa', 'stirrupFyvMPa', 'stirrupYieldStrengthMPa', 'yieldStrengthMPa', 'fyMPa'):
            strength = _number(source.get(key))
            if strength is not None and strength > 0.0:
                return strength
    return _structured_rebar_strength_mpa(context, elem_id, element, stirrup)


def _column_axial_compression_ratio_value(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
    reinforcement: Dict[str, Any],
    stirrup: Dict[str, Any],
) -> Optional[float]:
    for source in (stirrup, reinforcement, element, _element_metadata(context, elem_id, element), _element_context(context, elem_id)):
        for key in ('axialCompressionRatio', 'axialRatio', 'nOverFcA'):
            ratio = _number(source.get(key))
            if ratio is not None and ratio > 0.0:
                return ratio

    section = _record(element.get('section'))
    material = _record(element.get('material'))
    area = _number(section.get('A'))
    strength = _material_strength_mpa(material)
    axial_demand_kn = _element_axial_demand_kn(context, elem_id, element)
    if area is None or area <= 0.0 or strength is None or strength <= 0.0 or axial_demand_kn is None:
        return None
    return axial_demand_kn / max(strength * area / 1000.0, 1e-12)


def _column_stirrup_characteristic_value(
    grade: int,
    stirrup_type: str,
    axial_ratio: float,
    is_transfer: bool,
) -> Optional[Dict[str, Any]]:
    values = FRAME_COLUMN_STIRRUP_CHARACTERISTIC_VALUES.get((grade, stirrup_type))
    if not values:
        return None
    selected_bin = None
    selected_value = None
    for index, axial_limit in enumerate(FRAME_COLUMN_STIRRUP_CHARACTERISTIC_VALUE_BINS[:len(values)]):
        if axial_ratio <= axial_limit + 1e-12:
            selected_bin = axial_limit
            selected_value = values[index]
            break
    if selected_value is None:
        return None
    transfer_adjustment = 0.02 if is_transfer else 0.0
    return {
        'value': selected_value + transfer_adjustment,
        'baseValue': selected_value,
        'axialRatioBin': selected_bin,
        'transferAdjustment': transfer_adjustment,
    }


def _frame_column_stirrup_detailing_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_column(context, elem_id, element):
        return None

    reinforcement = _reinforcement_data(element)
    if not reinforcement:
        return None

    grade = _seismic_grade(context, elem_id, element)
    if grade is None:
        return None

    longitudinal = _column_longitudinal_reinforcement_group(reinforcement)
    stirrup = _column_stirrup_group(reinforcement)
    if not stirrup:
        return None

    spacing = _dimension_mm(stirrup.get('spacingMm') or stirrup.get('spacing') or stirrup.get('s'))
    diameter = _reinforcement_diameter_mm(stirrup)
    longitudinal_min_diameter = (
        _dimension_mm(longitudinal.get('minDiameterMm'))
        or _dimension_mm(longitudinal.get('minimumDiameterMm'))
        or _reinforcement_diameter_mm(longitudinal)
    )
    if spacing is None and diameter is None:
        return None

    spacing_limit = None
    spacing_basis: List[str] = []
    if longitudinal_min_diameter is not None:
        multiplier = 6.0 if grade == 1 else 8.0
        spacing_limit = multiplier * longitudinal_min_diameter
        spacing_basis.append(f'{int(multiplier)}d')
    code_limit = 100.0 if grade in {1, 2} else 150.0
    if grade in {3, 4} and _is_true(stirrup.get('isColumnRoot')):
        code_limit = 100.0
        spacing_basis.append('column root 100mm')
    spacing_limit = min(spacing_limit, code_limit) if spacing_limit is not None else code_limit
    spacing_basis.append(f'{int(code_limit)}mm')

    shear_info = _column_shear_span_ratio_info(context, elem_id, element)
    shear_ratio = _number(shear_info.get('ratio')) if shear_info else None
    if shear_ratio is not None and shear_ratio <= 2.0:
        spacing_limit = min(spacing_limit, 100.0)
        spacing_basis.append('shear-span ratio <= 2: 100mm')
    if _is_transfer_frame_member(context, elem_id, element):
        spacing_limit = min(spacing_limit, 100.0)
        spacing_basis.append('frame-supported column: 100mm')

    leg_count = _number(stirrup.get('legCount') or stirrup.get('legs'))
    leg_spacing = _dimension_mm(stirrup.get('legSpacingMm') or stirrup.get('legSpacing'))
    if grade == 1 and diameter is not None and diameter > 12.0 and leg_count is not None and leg_count >= 4.0 and leg_spacing is not None and leg_spacing <= 150.0:
        spacing_limit = max(spacing_limit, 150.0)
        spacing_basis.append('Grade 1 large-diameter multi-leg relaxation capped at 150mm')
    if grade == 2 and diameter is not None and diameter >= 10.0 and leg_spacing is not None and leg_spacing <= 200.0:
        spacing_limit = max(spacing_limit, 150.0)
        spacing_basis.append('Grade 2 large-diameter multi-leg relaxation capped at 150mm')
    if shear_ratio is not None and shear_ratio <= 2.0:
        spacing_limit = min(spacing_limit, 100.0)

    diameter_limit = {1: 10.0, 2: 8.0, 3: 8.0, 4: 6.0}[grade]
    if grade == 4 and shear_ratio is not None and shear_ratio <= 2.0:
        diameter_limit = max(diameter_limit, 8.0)

    subchecks: List[Dict[str, Any]] = []
    if spacing is not None:
        spacing_utilization = spacing / max(spacing_limit, 1e-12)
        subchecks.append({
            'name': 'column_confined_stirrup_spacing',
            'status': 'pass' if spacing_utilization <= 1.0 else 'fail',
            'utilization': round(spacing_utilization, 4),
            'demand': round(spacing, 6),
            'limit': round(spacing_limit, 6),
            'formula': 'confined-zone stirrup spacing <= code spacing limit',
        })
    if diameter is not None:
        diameter_utilization = diameter_limit / max(diameter, 1e-12)
        subchecks.append({
            'name': 'column_confined_stirrup_diameter',
            'status': 'pass' if diameter_utilization <= 1.0 else 'fail',
            'utilization': round(diameter_utilization, 4),
            'demand': round(diameter, 6),
            'limit': round(diameter_limit, 6),
            'formula': 'confined-zone stirrup diameter >= code diameter limit',
        })

    if not subchecks:
        return None

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架柱箍筋加密区构造',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.7',
        'formula': 'confined-zone stirrup spacing <= min(6d/8d, 100/150mm); diameter >= grade limit',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'stirrupSpacingMm': round(spacing, 6) if spacing is not None else None,
            'stirrupDiameterMm': round(diameter, 6) if diameter is not None else None,
            'longitudinalMinDiameterMm': round(longitudinal_min_diameter, 6) if longitudinal_min_diameter is not None else None,
            'spacingLimitMm': round(spacing_limit, 6),
            'spacingBasis': spacing_basis,
            'diameterLimitMm': round(diameter_limit, 6),
            'shearSpanRatio': round(shear_ratio, 6) if shear_ratio is not None else None,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }


def _frame_column_stirrup_confined_zone_range_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_column(context, elem_id, element):
        return None

    reinforcement = _reinforcement_data(element)
    if not reinforcement:
        return None

    grade = _seismic_grade(context, elem_id, element)
    stirrup = _column_stirrup_group(reinforcement)
    if not stirrup:
        return None

    section = _record(element.get('section'))
    width = _section_dimension_mm(section, 'width', 'b', 'B')
    height = _section_dimension_mm(section, 'height', 'h', 'H', 'diameter', 'D')
    column_depth = max(value for value in (width, height) if value is not None) if (width is not None or height is not None) else None
    clear_height = (
        _dimension_from_keys_mm(element, 'clearHeightMm', 'netHeightMm', 'columnClearHeightMm', 'storyClearHeightMm', 'clearHeight', 'netHeight')
        or _dimension_from_keys_mm(_element_metadata(context, elem_id, element), 'clearHeightMm', 'netHeightMm', 'columnClearHeightMm', 'clearHeight', 'netHeight')
        or _dimension_from_keys_mm(_element_context(context, elem_id), 'clearHeightMm', 'netHeightMm', 'columnClearHeightMm', 'clearHeight', 'netHeight')
    )
    confined_length = (
        _dimension_from_keys_mm(stirrup, 'confinedLengthMm', 'endConfinedLengthMm', 'columnEndConfinedLengthMm', 'lengthMm', 'confinedLength', 'endConfinedLength')
        or _dimension_from_keys_mm(reinforcement, 'columnConfinedLengthMm', 'columnEndConfinedLengthMm', 'confinedLengthMm')
        or _dimension_from_keys_mm(element, 'columnConfinedLengthMm', 'columnEndConfinedLengthMm', 'confinedLengthMm')
    )
    bottom_confined_length = _dimension_from_keys_mm(
        stirrup,
        'bottomConfinedLengthMm',
        'lowerEndConfinedLengthMm',
        'columnRootConfinedLengthMm',
        'bottomConfinedLength',
        'lowerEndConfinedLength',
        'columnRootConfinedLength',
    )

    full_height_flag: Optional[bool] = None
    for source in (stirrup, reinforcement, element):
        for key in ('isFullHeightConfined', 'fullHeightConfined', 'confinedFullHeight'):
            if _is_true(source.get(key)):
                full_height_flag = True
                break
            if _is_false(source.get(key)):
                full_height_flag = False
                break
        if full_height_flag is not None:
            break

    shear_info = _column_shear_span_ratio_info(context, elem_id, element)
    shear_ratio = _number(shear_info.get('ratio')) if shear_info else None
    full_height_reasons: List[str] = []
    if shear_ratio is not None and shear_ratio <= 2.0:
        full_height_reasons.append('shear-span ratio <= 2')
    if clear_height is not None and column_depth is not None and clear_height / max(column_depth, 1e-12) <= 4.0:
        full_height_reasons.append('clear-height/depth ratio <= 4')
    if _is_transfer_frame_member(context, elem_id, element):
        full_height_reasons.append('frame-supported column')
    if grade in {1, 2} and _is_corner_or_frame_supported_column(context, elem_id, element):
        full_height_reasons.append('Grade 1/2 corner or frame-supported column')
    for source in (stirrup, reinforcement, element):
        for key in ('requiresFullHeightConfined', 'hasInfillShortColumn', 'isShortColumn'):
            if _is_true(source.get(key)):
                full_height_reasons.append(key)
                break

    subchecks: List[Dict[str, Any]] = []
    if full_height_reasons:
        if full_height_flag is not None:
            subchecks.append({
                'name': 'column_confined_zone_full_height',
                'status': 'pass' if full_height_flag else 'fail',
                'utilization': 0.0 if full_height_flag else 2.0,
                'demand': full_height_flag,
                'limit': True,
                'formula': 'required full-height column stirrup confinement should be provided',
                'reasons': full_height_reasons,
            })
        elif confined_length is not None and clear_height is not None:
            full_height_utilization = clear_height / max(confined_length, 1e-12)
            subchecks.append({
                'name': 'column_confined_zone_full_height',
                'status': 'pass' if full_height_utilization <= 1.0 else 'fail',
                'utilization': round(full_height_utilization, 4),
                'demand': round(confined_length, 6),
                'limit': round(clear_height, 6),
                'formula': 'required full-height column stirrup confinement length >= clear height',
                'reasons': full_height_reasons,
            })
    elif confined_length is not None and (column_depth is not None or clear_height is not None):
        candidates = [500.0]
        basis = ['500mm']
        if column_depth is not None:
            candidates.append(column_depth)
            basis.append('column section depth')
        if clear_height is not None:
            candidates.append(clear_height / 6.0)
            basis.append('clear height / 6')
        required_length = max(candidates)
        length_utilization = required_length / max(confined_length, 1e-12)
        subchecks.append({
            'name': 'column_end_confined_zone_length',
            'status': 'pass' if length_utilization <= 1.0 else 'fail',
            'utilization': round(length_utilization, 4),
            'demand': round(confined_length, 6),
            'limit': round(required_length, 6),
            'formula': 'column-end stirrup confined-zone length >= max(hc, Hn/6, 500mm)',
            'basis': basis,
        })

    bottom_root = any(_is_true(source.get(key)) for source in (stirrup, reinforcement, element) for key in ('isBottomStoryColumnRoot', 'bottomStoryRoot', 'isFirstStoryLowerEnd'))
    if bottom_root and bottom_confined_length is not None and clear_height is not None:
        bottom_required = clear_height / 3.0
        bottom_utilization = bottom_required / max(bottom_confined_length, 1e-12)
        subchecks.append({
            'name': 'column_bottom_story_lower_end_confined_length',
            'status': 'pass' if bottom_utilization <= 1.0 else 'fail',
            'utilization': round(bottom_utilization, 4),
            'demand': round(bottom_confined_length, 6),
            'limit': round(bottom_required, 6),
            'formula': 'bottom-story column lower-end confined-zone length >= Hn/3',
        })

    if not subchecks:
        return None

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架柱箍筋加密区范围',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.9',
        'formula': 'column-end confined-zone length >= max(hc, Hn/6, 500mm); special columns require full-height confinement; bottom-story lower end >= Hn/3',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'columnDepthMm': round(column_depth, 6) if column_depth is not None else None,
            'clearHeightMm': round(clear_height, 6) if clear_height is not None else None,
            'confinedLengthMm': round(confined_length, 6) if confined_length is not None else None,
            'bottomConfinedLengthMm': round(bottom_confined_length, 6) if bottom_confined_length is not None else None,
            'fullHeightConfined': full_height_flag,
            'fullHeightReasons': full_height_reasons,
            'shearSpanRatio': round(shear_ratio, 6) if shear_ratio is not None else None,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }


def _frame_column_stirrup_volume_ratio_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_column(context, elem_id, element):
        return None

    reinforcement = _reinforcement_data(element)
    if not reinforcement:
        return None

    grade = _seismic_grade(context, elem_id, element)
    if grade is None:
        return None

    longitudinal = _column_longitudinal_reinforcement_group(reinforcement)
    stirrup = _column_stirrup_group(reinforcement)
    if not stirrup:
        return None

    volume_ratio = _column_stirrup_volume_ratio_percent(reinforcement, stirrup)
    non_confined_ratio = _column_non_confined_stirrup_volume_ratio_percent(reinforcement, stirrup)
    non_confined_spacing = _dimension_from_keys_mm(
        stirrup,
        'nonConfinedSpacingMm',
        'unconfinedSpacingMm',
        'nonConfinedSpacing',
        'unconfinedSpacing',
    )
    longitudinal_min_diameter = (
        _dimension_mm(longitudinal.get('minDiameterMm'))
        or _dimension_mm(longitudinal.get('minimumDiameterMm'))
        or _reinforcement_diameter_mm(longitudinal)
    )
    if volume_ratio is None and non_confined_ratio is None and non_confined_spacing is None:
        return None

    shear_info = _column_shear_span_ratio_info(context, elem_id, element)
    shear_ratio = _number(shear_info.get('ratio')) if shear_info else None
    design_basis = _record(_record(context.get('analysisSummary')).get('designBasis'))
    site = _record(design_basis.get('siteSeismic'))
    intensity = _number(site.get('intensity')) or _number(design_basis.get('intensity'))
    is_transfer = _is_transfer_frame_member(context, elem_id, element)
    axial_ratio = _column_axial_compression_ratio_value(context, elem_id, element, reinforcement, stirrup)
    stirrup_type = _column_stirrup_type_key(stirrup)
    fyv = _column_stirrup_yield_strength_mpa(context, elem_id, element, reinforcement, stirrup)
    fc = _material_strength_mpa(_record(element.get('material')))
    formula_fc = max(float(fc), C35_DESIGN_STRENGTH_MPA) if fc is not None else None
    characteristic = (
        _column_stirrup_characteristic_value(grade, stirrup_type, axial_ratio, is_transfer)
        if axial_ratio is not None
        else None
    )

    subchecks: List[Dict[str, Any]] = []
    if volume_ratio is not None:
        absolute_minimum = {1: 0.8, 2: 0.6, 3: 0.4, 4: 0.4}[grade]
        absolute_utilization = absolute_minimum / max(volume_ratio, 1e-12)
        subchecks.append({
            'name': 'column_confined_stirrup_volume_ratio_minimum',
            'status': 'pass' if absolute_utilization <= 1.0 else 'fail',
            'utilization': round(absolute_utilization, 4),
            'demand': round(volume_ratio, 6),
            'limit': absolute_minimum,
            'formula': 'confined-zone volumetric stirrup ratio >= grade minimum',
        })

        special_minimum = None
        special_reasons: List[str] = []
        if is_transfer:
            special_minimum = 1.5
            special_reasons.append('frame-supported column')
        if shear_ratio is not None and shear_ratio <= 2.0:
            short_column_minimum = 1.5 if grade == 1 and intensity == 9 else 1.2
            special_minimum = max(special_minimum or 0.0, short_column_minimum)
            special_reasons.append('shear-span ratio <= 2')
        if special_minimum is not None:
            special_utilization = special_minimum / max(volume_ratio, 1e-12)
            subchecks.append({
                'name': 'column_special_stirrup_volume_ratio_minimum',
                'status': 'pass' if special_utilization <= 1.0 else 'fail',
                'utilization': round(special_utilization, 4),
                'demand': round(volume_ratio, 6),
                'limit': round(special_minimum, 6),
                'formula': 'short or frame-supported column confined-zone volumetric ratio minimum',
                'reasons': special_reasons,
            })

    if volume_ratio is not None and characteristic is not None and fyv is not None and formula_fc is not None:
        lambda_v = float(characteristic['value'])
        required_ratio = lambda_v * formula_fc / max(fyv, 1e-12) * 100.0
        formula_utilization = required_ratio / max(volume_ratio, 1e-12)
        subchecks.append({
            'name': 'column_confined_stirrup_volume_ratio_formula',
            'status': 'pass' if formula_utilization <= 1.0 else 'fail',
            'utilization': round(formula_utilization, 4),
            'demand': round(volume_ratio, 6),
            'limit': round(required_ratio, 6),
            'formula': 'rho_v >= lambda_v * fc / fyv',
        })

    if volume_ratio is not None and non_confined_ratio is not None:
        non_confined_limit = 0.5 * volume_ratio
        non_confined_utilization = non_confined_limit / max(non_confined_ratio, 1e-12)
        subchecks.append({
            'name': 'column_non_confined_stirrup_volume_ratio',
            'status': 'pass' if non_confined_utilization <= 1.0 else 'fail',
            'utilization': round(non_confined_utilization, 4),
            'demand': round(non_confined_ratio, 6),
            'limit': round(non_confined_limit, 6),
            'formula': 'non-confined-zone volumetric stirrup ratio >= 50% of confined-zone ratio',
        })

    if non_confined_spacing is not None and longitudinal_min_diameter is not None:
        multiplier = 10.0 if grade in {1, 2} else 15.0
        spacing_limit = multiplier * longitudinal_min_diameter
        spacing_utilization = non_confined_spacing / max(spacing_limit, 1e-12)
        subchecks.append({
            'name': 'column_non_confined_stirrup_spacing',
            'status': 'pass' if spacing_utilization <= 1.0 else 'fail',
            'utilization': round(spacing_utilization, 4),
            'demand': round(non_confined_spacing, 6),
            'limit': round(spacing_limit, 6),
            'formula': 'non-confined-zone stirrup spacing <= 10d for Grade 1/2 and 15d for Grade 3/4',
        })

    if not subchecks:
        return None

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架柱箍筋体积配箍率',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.9',
        'formula': 'rho_v >= lambda_v * fc / fyv and grade absolute minimums; special short/frame-supported column and non-confined-zone requirements',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'stirrupType': stirrup_type,
            'volumeRatioPercent': round(volume_ratio, 6) if volume_ratio is not None else None,
            'nonConfinedVolumeRatioPercent': round(non_confined_ratio, 6) if non_confined_ratio is not None else None,
            'nonConfinedSpacingMm': round(non_confined_spacing, 6) if non_confined_spacing is not None else None,
            'longitudinalMinDiameterMm': round(longitudinal_min_diameter, 6) if longitudinal_min_diameter is not None else None,
            'axialCompressionRatio': round(axial_ratio, 6) if axial_ratio is not None else None,
            'lambdaV': round(float(characteristic['value']), 6) if characteristic is not None else None,
            'lambdaVBase': round(float(characteristic['baseValue']), 6) if characteristic is not None else None,
            'lambdaVAxialRatioBin': characteristic.get('axialRatioBin') if characteristic is not None else None,
            'lambdaVTransferAdjustment': round(float(characteristic.get('transferAdjustment') or 0.0), 6) if characteristic is not None else None,
            'fcForFormulaMPa': round(formula_fc, 6) if formula_fc is not None else None,
            'fyvMPa': round(fyv, 6) if fyv is not None else None,
            'shearSpanRatio': round(shear_ratio, 6) if shear_ratio is not None else None,
            'intensity': round(intensity, 6) if intensity is not None else None,
            'isTransferMember': is_transfer,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }
