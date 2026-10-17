"""Frame column checks: axial compression ratio, shear span, longitudinal bars, strength grade, geometry."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _aggregate_check_status,
    _concrete_grade_from_material,
    _element_type,
    _is_concrete_frame_beam_or_column,
    _is_concrete_frame_column,
    _is_false,
    _is_transfer_frame_member,
    _is_true,
    _material_strength_mpa,
    _number,
    _ratio_percent_from_keys,
    _record,
)
from .constants import (
    C30_DESIGN_STRENGTH_MPA,
)
from .element_context import (
    _column_shear_span_ratio_info,
    _element_axial_demand_kn,
    _frame_column_axial_limit_info,
    _frame_column_min_side_mm,
    _is_corner_or_frame_supported_column,
    _seismic_grade,
    _site_category_text,
    _story_count,
    _structured_high_rise,
)
from .reinforcement import (
    _column_longitudinal_reinforcement_group,
    _dimension_from_keys_mm,
    _reinforcement_area_mm2,
    _reinforcement_data,
    _section_area_mm2,
    _section_dimension_mm,
    _structured_rebar_strength_mpa,
)


def _frame_column_axial_compression_ratio_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_column(context, elem_id, element):
        return None

    grade = _seismic_grade(context, elem_id, element)
    section = _record(element.get('section'))
    material = _record(element.get('material'))
    area = _number(section.get('A'))
    strength = _material_strength_mpa(material)
    axial_demand_kn = _element_axial_demand_kn(context, elem_id, element)
    if grade is None or area is None or area <= 0.0 or strength is None or strength <= 0.0 or axial_demand_kn is None:
        return None

    capacity_kn = strength * area / 1000.0
    axial_ratio = axial_demand_kn / max(capacity_kn, 1e-12)
    limit_info = _frame_column_axial_limit_info(context, elem_id, element, grade)
    limit = float(limit_info['limit'])
    utilization = axial_ratio / max(limit, 1e-12)
    return {
        'item': '框架柱轴压比限值',
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.6',
        'formula': 'N/(fc*A) <= axial compression ratio limit by seismic grade; reduce by 0.05 when shear-span ratio <= 2',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'axialDemandKN': round(axial_demand_kn, 6),
            'areaMm2': round(area, 6),
            'fcMPa': round(strength, 6),
            'axialCompressionRatio': round(axial_ratio, 6),
            'limit': round(limit, 6),
            'baseLimit': round(float(limit_info['baseLimit']), 6),
            'manualAdjustment': round(float(limit_info.get('manualAdjustment') or 0.0), 6),
            'manualAdjustmentSource': limit_info.get('manualAdjustmentSource'),
            'shearSpanRatio': round(float(limit_info['shearSpanRatio']), 6) if limit_info.get('shearSpanRatio') is not None else None,
            'shearSpanRatioSource': limit_info.get('shearSpanRatioSource'),
            'shearSpanLimitAdjustment': round(float(limit_info.get('shearSpanLimitAdjustment') or 0.0), 6),
            'limitSource': limit_info.get('limitSource'),
        },
    }


def _frame_column_shear_span_ratio_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_column(context, elem_id, element):
        return None

    shear_info = _column_shear_span_ratio_info(context, elem_id, element)
    if not shear_info:
        return None

    ratio = _number(shear_info.get('ratio'))
    if ratio is None or ratio <= 0.0:
        return None

    minimum_without_special_measures = 1.5
    utilization = minimum_without_special_measures / max(ratio, 1e-12)
    return {
        'item': '框架柱剪跨比专项要求',
        'status': 'pass' if ratio >= minimum_without_special_measures else 'fail',
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.6',
        'formula': 'shear-span ratio >= 1.5; ratio <= 2 triggers axial-ratio limit reduction',
        'inputs': {
            'elementId': elem_id,
            'shearSpanRatio': round(ratio, 6),
            'source': shear_info.get('source'),
            'minimumWithoutSpecialMeasures': minimum_without_special_measures,
            'requiresSpecialStudy': ratio < minimum_without_special_measures,
            'requiresAxialRatioLimitReduction': ratio <= 2.0,
            'axialRatioLimitAdjustment': -0.05 if ratio <= 2.0 else 0.0,
        },
    }


def _frame_column_longitudinal_reinforcement_item(
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
    section = _record(element.get('section'))
    section_area = _section_area_mm2(section)
    longitudinal = _column_longitudinal_reinforcement_group(reinforcement)
    if grade is None:
        return None

    total_area = _reinforcement_area_mm2(longitudinal)
    if total_area is None:
        total_area = _number(reinforcement.get('longitudinalAreaMm2')) or _number(reinforcement.get('totalLongitudinalAreaMm2'))
    total_ratio = _number(longitudinal.get('ratioPercent')) or _number(longitudinal.get('reinforcementRatioPercent'))
    if total_ratio is None:
        ratio_fraction = _number(longitudinal.get('ratio')) or _number(longitudinal.get('reinforcementRatio'))
        if ratio_fraction is not None and ratio_fraction <= 1.0:
            total_ratio = ratio_fraction * 100.0
    if total_ratio is None and total_area is not None and section_area is not None and section_area > 0.0:
        total_ratio = total_area / section_area * 100.0

    side_area = (
        _number(longitudinal.get('sideMinAreaMm2'))
        or _number(longitudinal.get('minSideAreaMm2'))
        or _number(longitudinal.get('sideAreaMm2'))
        or _number(reinforcement.get('sideMinLongitudinalAreaMm2'))
    )
    side_ratio = (
        _number(longitudinal.get('sideMinRatioPercent'))
        or _number(longitudinal.get('sideReinforcementRatioPercent'))
        or _number(reinforcement.get('sideMinLongitudinalRatioPercent'))
    )
    if side_ratio is None:
        side_ratio_fraction = (
            _number(longitudinal.get('sideMinRatio'))
            or _number(longitudinal.get('sideReinforcementRatio'))
            or _number(reinforcement.get('sideMinLongitudinalRatio'))
        )
        if side_ratio_fraction is not None and side_ratio_fraction <= 1.0:
            side_ratio = side_ratio_fraction * 100.0
    if side_ratio is None and side_area is not None and section_area is not None and section_area > 0.0:
        side_ratio = side_area / section_area * 100.0

    if total_ratio is None and side_ratio is None:
        return None

    base_limits = (
        {1: 1.1, 2: 0.9, 3: 0.8, 4: 0.7}
        if _is_corner_or_frame_supported_column(context, elem_id, element)
        else {1: 1.0, 2: 0.8, 3: 0.7, 4: 0.6}
    )
    base_limit = base_limits[grade]
    strength = _structured_rebar_strength_mpa(context, elem_id, element, longitudinal)
    rebar_strength_adjustment = 0.0
    if strength is not None and strength < 400.0:
        rebar_strength_adjustment = 0.1
    elif strength is not None and abs(strength - 400.0) < 1e-9:
        rebar_strength_adjustment = 0.05
    concrete_grade = _concrete_grade_from_material(_record(element.get('material')))
    concrete_grade_value = _number(_record(concrete_grade).get('grade'))
    concrete_adjustment = 0.1 if concrete_grade_value is not None and concrete_grade_value > 60.0 else 0.0
    site_high_rise_adjustment = 0.1 if _site_category_text(context) == 'IV' and _structured_high_rise(context) else 0.0
    total_limit = base_limit + rebar_strength_adjustment + concrete_adjustment + site_high_rise_adjustment

    subchecks: List[Dict[str, Any]] = []
    if total_ratio is not None:
        total_utilization = total_limit / max(total_ratio, 1e-12)
        subchecks.append({
            'name': 'column_total_longitudinal_ratio',
            'status': 'pass' if total_utilization <= 1.0 else 'fail',
            'utilization': round(total_utilization, 4),
            'demand': round(total_ratio, 6),
            'limit': round(total_limit, 6),
            'formula': 'total longitudinal reinforcement ratio >= seismic minimum',
        })

    if side_ratio is not None:
        side_limit = 0.2
        side_utilization = side_limit / max(side_ratio, 1e-12)
        subchecks.append({
            'name': 'column_each_side_longitudinal_ratio',
            'status': 'pass' if side_utilization <= 1.0 else 'fail',
            'utilization': round(side_utilization, 4),
            'demand': round(side_ratio, 6),
            'limit': side_limit,
            'formula': 'longitudinal reinforcement ratio on each side >= 0.2%',
        })

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架柱纵筋构造',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.7',
        'formula': 'column longitudinal reinforcement ratio >= table minimum; each side >= 0.2%',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'sectionAreaMm2': round(section_area, 6) if section_area is not None else None,
            'totalLongitudinalAreaMm2': round(total_area, 6) if total_area is not None else None,
            'totalLongitudinalRatioPercent': round(total_ratio, 6) if total_ratio is not None else None,
            'sideMinLongitudinalAreaMm2': round(side_area, 6) if side_area is not None else None,
            'sideMinLongitudinalRatioPercent': round(side_ratio, 6) if side_ratio is not None else None,
            'columnCategory': 'corner_or_frame_supported' if _is_corner_or_frame_supported_column(context, elem_id, element) else 'frame_middle_or_edge',
            'baseLimitPercent': round(base_limit, 6),
            'rebarStrengthMPa': round(strength, 6) if strength is not None else None,
            'rebarStrengthAdjustmentPercent': round(rebar_strength_adjustment, 6),
            'concreteGrade': concrete_grade_value,
            'concreteGradeAdjustmentPercent': round(concrete_adjustment, 6),
            'siteHighRiseAdjustmentPercent': round(site_high_rise_adjustment, 6),
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }


def _frame_column_longitudinal_detailing_item(
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
    section = _record(element.get('section'))
    width = _section_dimension_mm(section, 'width', 'b', 'B')
    height = _section_dimension_mm(section, 'height', 'h', 'H')
    section_area = _section_area_mm2(section)
    longitudinal = _column_longitudinal_reinforcement_group(reinforcement)

    total_area = _reinforcement_area_mm2(longitudinal)
    if total_area is None:
        for source in (longitudinal, reinforcement):
            for key in ('totalAreaMm2', 'areaMm2', 'longitudinalAreaMm2', 'totalLongitudinalAreaMm2'):
                value = _number(source.get(key))
                if value is not None and value >= 0.0:
                    total_area = value
                    break
            if total_area is not None:
                break

    total_ratio = _ratio_percent_from_keys(
        longitudinal,
        ('totalRatioPercent', 'ratioPercent', 'reinforcementRatioPercent', 'totalLongitudinalRatioPercent'),
        ('totalRatio', 'ratio', 'reinforcementRatio', 'totalLongitudinalRatio'),
    )
    if total_ratio is None:
        total_ratio = _ratio_percent_from_keys(
            reinforcement,
            ('totalLongitudinalRatioPercent', 'longitudinalRatioPercent'),
            ('totalLongitudinalRatio', 'longitudinalRatio'),
        )
    if total_ratio is None and total_area is not None and section_area is not None and section_area > 0.0:
        total_ratio = total_area / section_area * 100.0

    side_area = None
    for source in (longitudinal, reinforcement):
        for key in ('sideMinAreaMm2', 'minSideAreaMm2', 'sideAreaMm2', 'sideMinLongitudinalAreaMm2'):
            value = _number(source.get(key))
            if value is not None and value >= 0.0:
                side_area = value
                break
        if side_area is not None:
            break
    side_ratio = _ratio_percent_from_keys(
        longitudinal,
        ('sideMinRatioPercent', 'sideReinforcementRatioPercent', 'sideMinLongitudinalRatioPercent'),
        ('sideMinRatio', 'sideReinforcementRatio', 'sideMinLongitudinalRatio'),
    )
    if side_ratio is None:
        side_ratio = _ratio_percent_from_keys(
            reinforcement,
            ('sideMinLongitudinalRatioPercent',),
            ('sideMinLongitudinalRatio',),
        )
    if side_ratio is None and side_area is not None and section_area is not None and section_area > 0.0:
        side_ratio = side_area / section_area * 100.0

    spacing = (
        _dimension_from_keys_mm(longitudinal, 'maxSpacingMm', 'spacingMm', 'longitudinalSpacingMm', 'spacing')
        or _dimension_from_keys_mm(reinforcement, 'longitudinalMaxSpacingMm', 'longitudinalSpacingMm')
    )

    symmetric: Optional[bool] = None
    for source in (longitudinal, reinforcement, element):
        for key in ('isSymmetric', 'symmetric', 'longitudinalSymmetric'):
            if _is_true(source.get(key)):
                symmetric = True
                break
            if _is_false(source.get(key)):
                symmetric = False
                break
        if symmetric is not None:
            break

    small_eccentric_tension = False
    for source in (longitudinal, reinforcement, element):
        for key in ('smallEccentricTension', 'requiresSmallEccentricTensionIncrease'):
            if _is_true(source.get(key)):
                small_eccentric_tension = True
                break
        if small_eccentric_tension:
            break
    calculated_area = None
    for source in (longitudinal, reinforcement):
        for key in ('calculatedAreaMm2', 'requiredCalculatedAreaMm2', 'designAreaMm2'):
            value = _number(source.get(key))
            if value is not None and value > 0.0:
                calculated_area = value
                break
        if calculated_area is not None:
            break

    subchecks: List[Dict[str, Any]] = []
    if symmetric is not None:
        subchecks.append({
            'name': 'column_longitudinal_symmetric_configuration',
            'status': 'pass' if symmetric else 'fail',
            'utilization': 0.0 if symmetric else 2.0,
            'demand': symmetric,
            'limit': True,
            'formula': 'column longitudinal bars should be symmetrically arranged',
        })

    if width is not None and height is not None and max(width, height) > 400.0 and spacing is not None:
        spacing_utilization = spacing / 200.0
        subchecks.append({
            'name': 'column_longitudinal_spacing',
            'status': 'pass' if spacing_utilization <= 1.0 else 'fail',
            'utilization': round(spacing_utilization, 4),
            'demand': round(spacing, 6),
            'limit': 200.0,
            'formula': 'when column side dimension > 400mm, longitudinal bar spacing <= 200mm',
        })

    if total_ratio is not None:
        total_max_ratio = 5.0
        total_max_utilization = total_ratio / total_max_ratio
        subchecks.append({
            'name': 'column_total_longitudinal_ratio_max',
            'status': 'pass' if total_max_utilization <= 1.0 else 'fail',
            'utilization': round(total_max_utilization, 4),
            'demand': round(total_ratio, 6),
            'limit': total_max_ratio,
            'formula': 'total longitudinal reinforcement ratio <= 5%',
        })

    shear_info = _column_shear_span_ratio_info(context, elem_id, element)
    shear_ratio = _number(shear_info.get('ratio')) if shear_info else None
    if grade == 1 and shear_ratio is not None and shear_ratio <= 2.0 and side_ratio is not None:
        side_max_ratio = 1.2
        side_max_utilization = side_ratio / side_max_ratio
        subchecks.append({
            'name': 'column_grade_one_short_column_side_ratio_max',
            'status': 'pass' if side_max_utilization <= 1.0 else 'fail',
            'utilization': round(side_max_utilization, 4),
            'demand': round(side_ratio, 6),
            'limit': side_max_ratio,
            'formula': 'Grade 1 frame column with shear-span ratio <= 2: each-side longitudinal ratio <= 1.2%',
        })

    if small_eccentric_tension and calculated_area is not None and total_area is not None:
        required_area = 1.25 * calculated_area
        area_utilization = required_area / max(total_area, 1e-12)
        subchecks.append({
            'name': 'column_small_eccentric_tension_area_increase',
            'status': 'pass' if area_utilization <= 1.0 else 'fail',
            'utilization': round(area_utilization, 4),
            'demand': round(total_area, 6),
            'limit': round(required_area, 6),
            'formula': 'small-eccentric tension edge/corner/wall-end column longitudinal area >= 1.25 * calculated area',
        })

    if not subchecks:
        return None

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架柱纵筋补充构造',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.8',
        'formula': 'column longitudinal symmetry, spacing, maximum reinforcement ratio, short-column side-ratio, and small-eccentric-tension increase detailing',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'widthMm': round(width, 6) if width is not None else None,
            'heightMm': round(height, 6) if height is not None else None,
            'longitudinalSpacingMm': round(spacing, 6) if spacing is not None else None,
            'totalLongitudinalAreaMm2': round(total_area, 6) if total_area is not None else None,
            'totalLongitudinalRatioPercent': round(total_ratio, 6) if total_ratio is not None else None,
            'sideMinLongitudinalRatioPercent': round(side_ratio, 6) if side_ratio is not None else None,
            'shearSpanRatio': round(shear_ratio, 6) if shear_ratio is not None else None,
            'smallEccentricTension': small_eccentric_tension,
            'calculatedAreaMm2': round(calculated_area, 6) if calculated_area is not None else None,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }


def _concrete_frame_member_strength_grade_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_beam_or_column(context, elem_id, element):
        return None

    grade = _seismic_grade(context, elem_id, element)
    is_transfer = _is_transfer_frame_member(context, elem_id, element)
    if not is_transfer and (grade is None or grade > 2):
        return None

    material = _record(element.get('material'))
    material_grade = _concrete_grade_from_material(material)
    requirement = 'transfer member' if is_transfer else f'seismic grade {grade}'
    if material_grade is None:
        return {
            'item': '框架梁柱混凝土强度等级',
            'status': 'input_required',
            'category': 'input_required',
            'utilization': None,
            'clause': 'GB 55002-2021 5.1.2',
            'formula': 'transfer beam/column and seismic grade <= 2 frame beam/column: concrete strength grade >= C30',
            'inputs': {
                'elementId': elem_id,
                'elementType': _element_type(context, elem_id, element),
                'seismicGrade': grade,
                'isTransferMember': is_transfer,
                'requiredGrade': 'C30',
                'requirement': requirement,
            },
            'message': 'Concrete material grade or explicit concrete design strength is unavailable.',
        }

    actual_grade = _number(material_grade.get('grade'))
    actual_fc = _number(material_grade.get('fcMPa'))
    if actual_grade is not None:
        utilization = 30.0 / max(actual_grade, 1e-12)
        actual_label = f"C{actual_grade:g}"
        actual_value = actual_grade
        source_kind = 'grade'
    else:
        utilization = C30_DESIGN_STRENGTH_MPA / max(float(actual_fc or 0.0), 1e-12)
        actual_label = f"fc={float(actual_fc or 0.0):g}MPa"
        actual_value = actual_fc
        source_kind = 'fcMPa'
    return {
        'item': '框架梁柱混凝土强度等级',
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'clause': 'GB 55002-2021 5.1.2',
        'formula': 'transfer beam/column and seismic grade <= 2 frame beam/column: concrete strength grade >= C30',
        'inputs': {
            'elementId': elem_id,
            'elementType': _element_type(context, elem_id, element),
            'seismicGrade': grade,
            'isTransferMember': is_transfer,
            'requiredGrade': 'C30',
            'requiredFcMPa': C30_DESIGN_STRENGTH_MPA,
            'actual': actual_label,
            'actualValue': round(float(actual_value or 0.0), 6),
            'actualValueType': source_kind,
            'source': material_grade.get('source'),
            'requirement': requirement,
        },
    }


def _frame_column_section_geometry_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_column(context, elem_id, element):
        return None

    section = _record(element.get('section'))
    width = _section_dimension_mm(section, 'width', 'b', 'B')
    height = _section_dimension_mm(section, 'height', 'h', 'H')
    if width is None or height is None:
        return None

    short_side = min(width, height)
    long_side = max(width, height)
    subchecks: List[Dict[str, Any]] = []
    min_side_limit = _frame_column_min_side_mm(context, elem_id, element)
    if min_side_limit is not None:
        min_side_utilization = min_side_limit / max(short_side, 1e-12)
        subchecks.append({
            'name': 'column_min_side',
            'status': 'pass' if min_side_utilization <= 1.0 else 'fail',
            'utilization': round(min_side_utilization, 4),
            'demand': round(short_side, 6),
            'limit': round(min_side_limit, 6),
            'formula': 'min(b,h) >= required side length',
        })

    side_ratio = long_side / max(short_side, 1e-12)
    side_ratio_utilization = side_ratio / 3.0
    subchecks.append({
        'name': 'column_long_short_side_ratio',
        'status': 'pass' if side_ratio_utilization <= 1.0 else 'fail',
        'utilization': round(side_ratio_utilization, 4),
        'demand': round(side_ratio, 6),
        'limit': 3.0,
        'formula': 'long side / short side <= 3',
    })

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架柱截面尺寸',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.5',
        'formula': 'min(b,h) >= 300/400mm by seismic grade and story count; long side / short side <= 3',
        'inputs': {
            'elementId': elem_id,
            'widthMm': round(width, 6),
            'heightMm': round(height, 6),
            'shortSideMm': round(short_side, 6),
            'longSideMm': round(long_side, 6),
            'seismicGrade': _seismic_grade(context, elem_id, element),
            'storyCount': _story_count(context),
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }
