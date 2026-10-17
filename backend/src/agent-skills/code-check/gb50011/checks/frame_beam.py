"""Frame beam checks: section geometry, flat beams, longitudinal bars, ductility, stirrups."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _aggregate_check_status,
    _element_context,
    _element_metadata,
    _is_concrete_frame_beam,
    _number,
    _optional_bool_from_sources,
    _record,
)
from .element_context import (
    _beam_span_mm,
    _seismic_grade,
)
from .frame_beam_data import (
    _beam_end_bottom_top_area_ratio,
    _beam_end_compression_zone_ratio,
    _beam_end_stirrup_group,
    _beam_end_tension_reinforcement_ratio_percent,
    _beam_longitudinal_diameter_mm,
    _beam_through_joint_bar_diameter_mm,
    _beam_through_joint_column_dimension_mm,
    _flat_beam_column_longitudinal_diameter_mm,
    _flat_beam_detailing_group,
)
from .reinforcement import (
    _dimension_from_keys_mm,
    _reinforcement_area_mm2,
    _reinforcement_count,
    _reinforcement_data,
    _reinforcement_diameter_mm,
    _reinforcement_end_area_mm2,
    _reinforcement_group,
    _section_dimension_mm,
)


def _frame_beam_section_geometry_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_beam(context, elem_id, element):
        return None

    section = _record(element.get('section'))
    width = _section_dimension_mm(section, 'width', 'b', 'B')
    height = _section_dimension_mm(section, 'height', 'h', 'H')
    if width is None or height is None:
        return None

    subchecks: List[Dict[str, Any]] = []
    width_utilization = 200.0 / max(width, 1e-12)
    subchecks.append({
        'name': 'beam_width',
        'status': 'pass' if width_utilization <= 1.0 else 'fail',
        'utilization': round(width_utilization, 4),
        'demand': round(width, 6),
        'limit': 200.0,
        'formula': 'b >= 200mm',
    })

    depth_width_ratio = height / max(width, 1e-12)
    depth_width_utilization = depth_width_ratio / 4.0
    subchecks.append({
        'name': 'beam_depth_width_ratio',
        'status': 'pass' if depth_width_utilization <= 1.0 else 'fail',
        'utilization': round(depth_width_utilization, 4),
        'demand': round(depth_width_ratio, 6),
        'limit': 4.0,
        'formula': 'h/b <= 4',
    })

    span_info = _beam_span_mm(context, elem_id, element)
    if span_info:
        span = float(span_info['spanMm'])
        span_depth_ratio = span / max(height, 1e-12)
        span_depth_utilization = 4.0 / max(span_depth_ratio, 1e-12)
        subchecks.append({
            'name': 'beam_clear_span_depth_ratio',
            'status': 'pass' if span_depth_utilization <= 1.0 else 'fail',
            'utilization': round(span_depth_utilization, 4),
            'demand': round(span_depth_ratio, 6),
            'limit': 4.0,
            'formula': 'ln/h >= 4',
            'spanMm': round(span, 6),
            'spanSource': span_info.get('source'),
        })

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架梁截面尺寸',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.1',
        'formula': 'b >= 200mm; h/b <= 4; ln/h >= 4 when span is available',
        'inputs': {
            'elementId': elem_id,
            'widthMm': round(width, 6),
            'heightMm': round(height, 6),
            'spanMm': round(float(span_info['spanMm']), 6) if span_info else None,
            'spanSource': span_info.get('source') if span_info else None,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }


def _frame_beam_flat_beam_detailing_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_beam(context, elem_id, element):
        return None

    section = _record(element.get('section'))
    width = _section_dimension_mm(section, 'width', 'b', 'B')
    height = _section_dimension_mm(section, 'height', 'h', 'H')
    if width is None or height is None:
        return None

    reinforcement = _reinforcement_data(element)
    flat_beam = _flat_beam_detailing_group(context, elem_id, element, reinforcement)
    sources = (
        flat_beam,
        reinforcement,
        element,
        _element_metadata(context, elem_id, element),
        _element_context(context, elem_id),
    )
    is_flat_beam = _optional_bool_from_sources(
        sources,
        ('isFlatBeam', 'flatBeam', 'isWideBeam', 'wideBeam', 'beamWidthGreaterThanColumnWidth'),
    )
    column_width = (
        _dimension_from_keys_mm(
            flat_beam,
            'columnWidthMm',
            'columnDimensionMm',
            'jointColumnWidthMm',
            'jointColumnDimensionMm',
            'columnWidth',
            'columnDimension',
            'jointColumnWidth',
            'jointColumnDimension',
        )
        or _beam_through_joint_column_dimension_mm(context, elem_id, element, reinforcement)
    )
    if is_flat_beam is False:
        return None
    if is_flat_beam is not True and (column_width is None or width <= column_width):
        return None

    column_longitudinal_diameter = _flat_beam_column_longitudinal_diameter_mm(flat_beam, reinforcement)
    grade = _seismic_grade(context, elem_id, element)
    cast_in_place = _optional_bool_from_sources(
        sources,
        ('castInPlaceFloor', 'castInPlaceSlab', 'floorCastInPlace', 'roofFloorCastInPlace', 'isCastInPlaceFloor'),
    )
    centerline_aligned = _optional_bool_from_sources(
        sources,
        ('centerlineAligned', 'beamColumnCenterlineAligned', 'beamColumnCenterlineCoincident', 'centerlineCoincident'),
    )
    bidirectional = _optional_bool_from_sources(
        sources,
        ('bidirectional', 'bidirectionalArrangement', 'twoWayArrangement', 'isBidirectionalBeamArrangement'),
    )

    subchecks: List[Dict[str, Any]] = []
    if column_width is not None:
        width_limit_2bc = 2.0 * column_width
        width_utilization_2bc = width / max(width_limit_2bc, 1e-12)
        subchecks.append({
            'name': 'flat_beam_width_2bc',
            'status': 'pass' if width_utilization_2bc <= 1.0 else 'fail',
            'utilization': round(width_utilization_2bc, 4),
            'demand': round(width, 6),
            'limit': round(width_limit_2bc, 6),
            'formula': 'bb <= 2bc',
        })

        width_limit_bc_hb = column_width + height
        width_utilization_bc_hb = width / max(width_limit_bc_hb, 1e-12)
        subchecks.append({
            'name': 'flat_beam_width_bc_plus_hb',
            'status': 'pass' if width_utilization_bc_hb <= 1.0 else 'fail',
            'utilization': round(width_utilization_bc_hb, 4),
            'demand': round(width, 6),
            'limit': round(width_limit_bc_hb, 6),
            'formula': 'bb <= bc + hb',
        })

    if column_longitudinal_diameter is not None:
        height_limit = 16.0 * column_longitudinal_diameter
        height_utilization = height_limit / max(height, 1e-12)
        subchecks.append({
            'name': 'flat_beam_depth_column_bar',
            'status': 'pass' if height_utilization <= 1.0 else 'fail',
            'utilization': round(height_utilization, 4),
            'demand': round(height, 6),
            'limit': round(height_limit, 6),
            'formula': 'hb >= 16d',
        })

    if grade is not None:
        grade_utilization = 2.0 if grade == 1 else 0.0
        subchecks.append({
            'name': 'flat_beam_grade_one_restriction',
            'status': 'fail' if grade == 1 else 'pass',
            'utilization': grade_utilization,
            'demand': grade,
            'limit': 'not Grade 1',
            'formula': 'flat beams should not be used for Grade 1 frame structures',
        })

    for name, value, formula in (
        ('flat_beam_cast_in_place_floor', cast_in_place, 'flat-beam floor/roof should be cast-in-place'),
        ('flat_beam_centerline_alignment', centerline_aligned, 'flat-beam centerline should coincide with column centerline'),
        ('flat_beam_bidirectional_arrangement', bidirectional, 'flat beams should be arranged in two directions'),
    ):
        if value is None:
            continue
        subchecks.append({
            'name': name,
            'status': 'pass' if value else 'fail',
            'utilization': 0.0 if value else 2.0,
            'demand': value,
            'limit': True,
            'formula': formula,
        })

    if not subchecks:
        return None

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架扁梁构造',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.2',
        'formula': 'bb <= 2bc; bb <= bc + hb; hb >= 16d; flat beams should not be used in Grade 1 frames',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'beamWidthMm': round(width, 6),
            'beamHeightMm': round(height, 6),
            'columnWidthMm': round(column_width, 6) if column_width is not None else None,
            'columnLongitudinalDiameterMm': round(column_longitudinal_diameter, 6) if column_longitudinal_diameter is not None else None,
            'castInPlaceFloor': cast_in_place,
            'centerlineAligned': centerline_aligned,
            'bidirectional': bidirectional,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }


def _frame_beam_longitudinal_reinforcement_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_beam(context, elem_id, element):
        return None

    reinforcement = _reinforcement_data(element)
    if not reinforcement:
        return None

    grade = _seismic_grade(context, elem_id, element)
    required_diameter = 14.0 if grade in {1, 2} else 12.0 if grade in {3, 4} else None
    top = _reinforcement_group(
        reinforcement,
        'topContinuous',
        'continuousTop',
        'longitudinalTopContinuous',
        'topLongitudinalContinuous',
    )
    bottom = _reinforcement_group(
        reinforcement,
        'bottomContinuous',
        'continuousBottom',
        'longitudinalBottomContinuous',
        'bottomLongitudinalContinuous',
    )
    groups = (('top', top), ('bottom', bottom))
    subchecks: List[Dict[str, Any]] = []

    for side, group in groups:
        count = _reinforcement_count(group)
        if count is not None:
            count_utilization = 2.0 / max(count, 1e-12)
            subchecks.append({
                'name': f'{side}_continuous_bar_count',
                'status': 'pass' if count_utilization <= 1.0 else 'fail',
                'utilization': round(count_utilization, 4),
                'demand': round(count, 6),
                'limit': 2.0,
                'formula': f'{side} continuous longitudinal bars >= 2',
            })

        diameter = _reinforcement_diameter_mm(group)
        if required_diameter is not None and diameter is not None:
            diameter_utilization = required_diameter / max(diameter, 1e-12)
            subchecks.append({
                'name': f'{side}_continuous_bar_diameter',
                'status': 'pass' if diameter_utilization <= 1.0 else 'fail',
                'utilization': round(diameter_utilization, 4),
                'demand': round(diameter, 6),
                'limit': required_diameter,
                'formula': f'{side} continuous longitudinal bar diameter >= required grade limit',
            })

        area = _reinforcement_area_mm2(group)
        end_area = _reinforcement_end_area_mm2(reinforcement, side)
        if grade in {1, 2} and area is not None and end_area is not None:
            required_area = 0.25 * end_area
            area_utilization = required_area / max(area, 1e-12)
            subchecks.append({
                'name': f'{side}_continuous_area_ratio',
                'status': 'pass' if area_utilization <= 1.0 else 'fail',
                'utilization': round(area_utilization, 4),
                'demand': round(area, 6),
                'limit': round(required_area, 6),
                'formula': f'{side} continuous area >= 1/4 max end longitudinal area',
            })

    if not subchecks:
        return None

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架梁贯通纵筋构造',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.4',
        'formula': 'top and bottom continuous longitudinal bars: Grade 1/2 >= 2φ14 and >= 1/4 max end area; Grade 3/4 >= 2φ12',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'requiredDiameterMm': required_diameter,
            'topContinuous': {
                'count': _reinforcement_count(top),
                'diameterMm': _reinforcement_diameter_mm(top),
                'areaMm2': _reinforcement_area_mm2(top),
                'endMaxAreaMm2': _reinforcement_end_area_mm2(reinforcement, 'top'),
            },
            'bottomContinuous': {
                'count': _reinforcement_count(bottom),
                'diameterMm': _reinforcement_diameter_mm(bottom),
                'areaMm2': _reinforcement_area_mm2(bottom),
                'endMaxAreaMm2': _reinforcement_end_area_mm2(reinforcement, 'bottom'),
            },
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }


def _frame_beam_end_longitudinal_ductility_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_beam(context, elem_id, element):
        return None

    reinforcement = _reinforcement_data(element)
    if not reinforcement:
        return None

    grade = _seismic_grade(context, elem_id, element)
    compression_zone_ratio = _beam_end_compression_zone_ratio(reinforcement)
    bottom_top_area_ratio = _beam_end_bottom_top_area_ratio(reinforcement)
    end_tension_ratio = _beam_end_tension_reinforcement_ratio_percent(reinforcement)
    subchecks: List[Dict[str, Any]] = []

    compression_limit = None
    if grade in {1, 2, 3} and compression_zone_ratio is not None:
        compression_limit = 0.25 if grade == 1 else 0.35
        compression_utilization = compression_zone_ratio / compression_limit
        subchecks.append({
            'name': 'beam_end_compression_zone_ratio',
            'status': 'pass' if compression_utilization <= 1.0 else 'fail',
            'utilization': round(compression_utilization, 4),
            'demand': round(compression_zone_ratio, 6),
            'limit': compression_limit,
            'formula': 'beam-end compression-zone height ratio <= grade limit',
        })

    bottom_top_limit = None
    if grade in {1, 2, 3} and bottom_top_area_ratio is not None:
        bottom_top_limit = 0.5 if grade == 1 else 0.3
        bottom_top_utilization = bottom_top_limit / max(bottom_top_area_ratio, 1e-12)
        subchecks.append({
            'name': 'beam_end_bottom_top_area_ratio',
            'status': 'pass' if bottom_top_utilization <= 1.0 else 'fail',
            'utilization': round(bottom_top_utilization, 4),
            'demand': round(bottom_top_area_ratio, 6),
            'limit': bottom_top_limit,
            'formula': 'beam-end bottom/top longitudinal reinforcement area ratio >= grade limit',
        })

    tension_ratio_limit = 2.5
    if end_tension_ratio is not None:
        tension_utilization = end_tension_ratio / tension_ratio_limit
        subchecks.append({
            'name': 'beam_end_tension_reinforcement_ratio',
            'status': 'pass' if tension_utilization <= 1.0 else 'fail',
            'utilization': round(tension_utilization, 4),
            'demand': round(end_tension_ratio, 6),
            'limit': tension_ratio_limit,
            'formula': 'beam-end longitudinal tension reinforcement ratio <= 2.5%',
        })

    if not subchecks:
        return None

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架梁端纵筋延性构造',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.3 + 6.3.4',
        'formula': 'beam-end compression-zone ratio, bottom/top area ratio, and end tension reinforcement ratio limits',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'compressionZoneRatio': round(compression_zone_ratio, 6) if compression_zone_ratio is not None else None,
            'compressionZoneRatioLimit': compression_limit,
            'bottomTopAreaRatio': round(bottom_top_area_ratio, 6) if bottom_top_area_ratio is not None else None,
            'bottomTopAreaRatioLimit': bottom_top_limit,
            'endTensionReinforcementRatioPercent': round(end_tension_ratio, 6) if end_tension_ratio is not None else None,
            'endTensionReinforcementRatioPercentLimit': tension_ratio_limit,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }


def _frame_beam_through_joint_bar_diameter_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_beam(context, elem_id, element):
        return None

    grade = _seismic_grade(context, elem_id, element)
    if grade not in {1, 2, 3}:
        return None

    reinforcement = _reinforcement_data(element)
    if not reinforcement:
        return None

    diameter = _beam_through_joint_bar_diameter_mm(reinforcement)
    column_dimension = _beam_through_joint_column_dimension_mm(context, elem_id, element, reinforcement)
    if diameter is None or column_dimension is None:
        return None

    limit = column_dimension / 20.0
    utilization = diameter / max(limit, 1e-12)
    return {
        'item': '框架梁贯通中柱纵筋直径',
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.4',
        'formula': 'longitudinal bar diameter through an interior column <= column dimension / 20',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'barDiameterMm': round(diameter, 6),
            'columnDimensionMm': round(column_dimension, 6),
            'diameterLimitMm': round(limit, 6),
        },
    }


def _frame_beam_stirrup_detailing_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_beam(context, elem_id, element):
        return None

    reinforcement = _reinforcement_data(element)
    if not reinforcement:
        return None

    grade = _seismic_grade(context, elem_id, element)
    if grade is None:
        return None

    stirrup = _beam_end_stirrup_group(reinforcement)
    if not stirrup:
        return None

    section = _record(element.get('section'))
    height = _section_dimension_mm(section, 'height', 'h', 'H')
    longitudinal_diameter = _beam_longitudinal_diameter_mm(reinforcement)
    diameter = _reinforcement_diameter_mm(stirrup)
    spacing = _dimension_from_keys_mm(stirrup, 'spacingMm', 'spacing', 's')
    confined_length = _dimension_from_keys_mm(stirrup, 'confinedLengthMm', 'endZoneLengthMm', 'lengthMm', 'confinedLength', 'endZoneLength')
    leg_spacing = _dimension_from_keys_mm(stirrup, 'legSpacingMm', 'legSpacing')
    first_spacing = _dimension_from_keys_mm(stirrup, 'firstSpacingMm', 'firstStirrupDistanceMm', 'firstDistanceMm', 'firstSpacing')
    hook_straight_length = _dimension_from_keys_mm(stirrup, 'hookStraightLengthMm', 'hookLengthMm', 'hookStraightLength', 'hookLength')
    hook_angle = _number(stirrup.get('hookAngleDeg')) or _number(stirrup.get('hookAngle'))

    subchecks: List[Dict[str, Any]] = []
    if height is not None and confined_length is not None:
        length_limit = max((2.0 if grade == 1 else 1.5) * height, 500.0)
        length_utilization = length_limit / max(confined_length, 1e-12)
        subchecks.append({
            'name': 'beam_end_stirrup_confined_length',
            'status': 'pass' if length_utilization <= 1.0 else 'fail',
            'utilization': round(length_utilization, 4),
            'demand': round(confined_length, 6),
            'limit': round(length_limit, 6),
            'formula': 'beam-end confined-zone length >= max(2hb/1.5hb, 500mm)',
        })

    spacing_candidates: List[float] = []
    spacing_basis: List[str] = []
    if height is not None:
        spacing_candidates.append(height / 4.0)
        spacing_basis.append('hb/4')
    if longitudinal_diameter is not None:
        multiplier = 6.0 if grade == 1 else 8.0
        spacing_candidates.append(multiplier * longitudinal_diameter)
        spacing_basis.append(f'{int(multiplier)}d')
    code_spacing_limit = 100.0 if grade in {1, 2} else 150.0
    spacing_candidates.append(code_spacing_limit)
    spacing_basis.append(f'{int(code_spacing_limit)}mm')
    spacing_limit = min(spacing_candidates)
    if spacing is not None:
        spacing_utilization = spacing / max(spacing_limit, 1e-12)
        subchecks.append({
            'name': 'beam_end_stirrup_spacing',
            'status': 'pass' if spacing_utilization <= 1.0 else 'fail',
            'utilization': round(spacing_utilization, 4),
            'demand': round(spacing, 6),
            'limit': round(spacing_limit, 6),
            'formula': 'beam-end stirrup spacing <= min(hb/4, 6d/8d, 100/150mm)',
        })

    if diameter is not None:
        diameter_limit = {1: 10.0, 2: 8.0, 3: 8.0, 4: 6.0}[grade]
        end_tension_ratio = _beam_end_tension_reinforcement_ratio_percent(reinforcement)
        if end_tension_ratio is not None and end_tension_ratio > 2.0:
            diameter_limit += 2.0
        diameter_utilization = diameter_limit / max(diameter, 1e-12)
        subchecks.append({
            'name': 'beam_end_stirrup_diameter',
            'status': 'pass' if diameter_utilization <= 1.0 else 'fail',
            'utilization': round(diameter_utilization, 4),
            'demand': round(diameter, 6),
            'limit': round(diameter_limit, 6),
            'formula': 'beam-end stirrup diameter >= table minimum, plus 2mm when end tension ratio > 2%',
        })

    if leg_spacing is not None:
        leg_spacing_limit = 300.0 if grade == 4 else 250.0 if grade in {2, 3} else 200.0
        if grade in {1, 2, 3} and diameter is not None:
            leg_spacing_limit = max(leg_spacing_limit, 20.0 * diameter)
        leg_spacing_utilization = leg_spacing / max(leg_spacing_limit, 1e-12)
        subchecks.append({
            'name': 'beam_end_stirrup_leg_spacing',
            'status': 'pass' if leg_spacing_utilization <= 1.0 else 'fail',
            'utilization': round(leg_spacing_utilization, 4),
            'demand': round(leg_spacing, 6),
            'limit': round(leg_spacing_limit, 6),
            'formula': 'beam-end stirrup leg spacing <= grade limit',
        })

    if first_spacing is not None:
        first_utilization = first_spacing / 50.0
        subchecks.append({
            'name': 'beam_first_stirrup_distance',
            'status': 'pass' if first_utilization <= 1.0 else 'fail',
            'utilization': round(first_utilization, 4),
            'demand': round(first_spacing, 6),
            'limit': 50.0,
            'formula': 'first stirrup distance from support edge <= 50mm',
        })

    if hook_angle is not None:
        hook_angle_utilization = 135.0 / max(hook_angle, 1e-12)
        subchecks.append({
            'name': 'beam_stirrup_hook_angle',
            'status': 'pass' if hook_angle_utilization <= 1.0 else 'fail',
            'utilization': round(hook_angle_utilization, 4),
            'demand': round(hook_angle, 6),
            'limit': 135.0,
            'formula': 'stirrup hook angle >= 135 degrees',
        })

    if hook_straight_length is not None and diameter is not None:
        hook_length_limit = max(10.0 * diameter, 75.0)
        hook_length_utilization = hook_length_limit / max(hook_straight_length, 1e-12)
        subchecks.append({
            'name': 'beam_stirrup_hook_straight_length',
            'status': 'pass' if hook_length_utilization <= 1.0 else 'fail',
            'utilization': round(hook_length_utilization, 4),
            'demand': round(hook_straight_length, 6),
            'limit': round(hook_length_limit, 6),
            'formula': 'stirrup hook straight length >= max(10d, 75mm)',
        })

    if not subchecks:
        return None

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架梁箍筋加密区构造',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.3 + 6.3.4',
        'formula': 'beam-end stirrup confined-zone length, spacing, diameter, leg spacing, first stirrup, and hook detailing',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'heightMm': round(height, 6) if height is not None else None,
            'longitudinalDiameterMm': round(longitudinal_diameter, 6) if longitudinal_diameter is not None else None,
            'stirrupDiameterMm': round(diameter, 6) if diameter is not None else None,
            'stirrupSpacingMm': round(spacing, 6) if spacing is not None else None,
            'spacingLimitMm': round(spacing_limit, 6),
            'spacingBasis': spacing_basis,
            'endTensionReinforcementRatioPercent': _beam_end_tension_reinforcement_ratio_percent(reinforcement),
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }
