"""Shear wall checks: thickness, axial compression ratio, distributed reinforcement."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from .common import (
    _aggregate_check_status,
    _element_context,
    _element_metadata,
    _first_number_from_records,
    _is_concrete_shear_wall,
    _material_strength_mpa,
    _number,
    _optional_bool_from_sources,
    _ratio_percent_from_sources,
    _record,
)
from .element_context import (
    _element_axial_demand_kn,
    _seismic_grade,
)
from .reinforcement import (
    _dimension_from_keys_mm,
    _reinforcement_data,
    _reinforcement_diameter_mm,
    _reinforcement_group,
)


def _shear_wall_detailing_group(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
    reinforcement: Dict[str, Any],
) -> Dict[str, Any]:
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    sources = (
        _record(reinforcement.get('shearWall')),
        _record(reinforcement.get('seismicWall')),
        _record(reinforcement.get('wall')),
        _record(element.get('shearWall')),
        _record(element.get('seismicWall')),
        _record(element.get('wallData')),
        _record(metadata.get('shearWall')),
        _record(metadata.get('seismicWall')),
        _record(metadata.get('wallData')),
        _record(element_context.get('shearWall')),
        _record(element_context.get('seismicWall')),
        _record(element_context.get('wallData')),
        _record(_record(context.get('wallData')).get(elem_id)),
        _record(_record(context.get('shearWallData')).get(elem_id)),
    )
    for source in sources:
        if source:
            return source
    return {}


def _wall_orientation_group(reinforcement: Dict[str, Any], wall: Dict[str, Any], orientation: str) -> Dict[str, Any]:
    if orientation == 'vertical':
        keys = (
            'verticalDistributed',
            'verticalDistribution',
            'distributedVertical',
            'verticalReinforcement',
            'verticalBars',
        )
    else:
        keys = (
            'horizontalDistributed',
            'horizontalDistribution',
            'distributedHorizontal',
            'horizontalReinforcement',
            'horizontalBars',
            'transverseDistributed',
        )
    for source in (reinforcement, wall):
        group = _reinforcement_group(source, *keys)
        if group:
            return group
    distributed = _reinforcement_group(reinforcement, 'distributed', 'distribution', 'webDistributed', 'webReinforcement')
    wall_distributed = _reinforcement_group(wall, 'distributed', 'distribution', 'webDistributed', 'webReinforcement')
    return distributed or wall_distributed


def _wall_bool(wall: Dict[str, Any], element: Dict[str, Any], metadata: Dict[str, Any], context_record: Dict[str, Any], *keys: str) -> Optional[bool]:
    return _optional_bool_from_sources((wall, element, metadata, context_record), keys)


def _wall_dimension_from_sources(
    wall: Dict[str, Any],
    element: Dict[str, Any],
    metadata: Dict[str, Any],
    context_record: Dict[str, Any],
    section: Dict[str, Any],
    *keys: str,
) -> Optional[float]:
    for source in (wall, element, metadata, context_record, section):
        value = _dimension_from_keys_mm(source, *keys)
        if value is not None:
            return value
    return None


def _shear_wall_thickness_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_shear_wall(context, elem_id, element):
        return None

    section = _record(element.get('section'))
    reinforcement = _reinforcement_data(element)
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    wall = _shear_wall_detailing_group(context, elem_id, element, reinforcement)
    thickness = _wall_dimension_from_sources(
        wall,
        element,
        metadata,
        element_context,
        section,
        'thicknessMm',
        'wallThicknessMm',
        'tMm',
        'thickness',
        'wallThickness',
        't',
    )
    if thickness is None:
        return None

    grade = _seismic_grade(context, elem_id, element)
    story_height = _wall_dimension_from_sources(
        wall,
        element,
        metadata,
        element_context,
        section,
        'storyHeightMm',
        'floorHeightMm',
        'heightBetweenFloorsMm',
        'storyHeight',
        'floorHeight',
        'heightBetweenFloors',
    )
    is_bottom_strengthened = _wall_bool(
        wall,
        element,
        metadata,
        element_context,
        'isBottomStrengthenedZone',
        'bottomStrengthenedZone',
        'isBottomStrengtheningZone',
        'bottomStrengtheningZone',
        'bottomEnhancedZone',
    )
    has_end_column_or_wing = _wall_bool(
        wall,
        element,
        metadata,
        element_context,
        'hasEndColumn',
        'hasBoundaryColumn',
        'hasWingWall',
        'hasFlangeWall',
        'hasEndPier',
    )

    subchecks: List[Dict[str, Any]] = []
    absolute_limit = 160.0 if grade in {1, 2} else 140.0 if grade in {3, 4} else None
    if absolute_limit is not None:
        utilization = absolute_limit / max(thickness, 1e-12)
        subchecks.append({
            'name': 'wall_thickness_absolute_minimum',
            'status': 'pass' if utilization <= 1.0 else 'fail',
            'utilization': round(utilization, 4),
            'demand': round(thickness, 6),
            'limit': absolute_limit,
            'formula': 'Grade 1/2 wall thickness >= 160mm; Grade 3/4 wall thickness >= 140mm',
        })

    if grade in {1, 2, 3, 4} and story_height is not None:
        divisor = 20.0 if grade in {1, 2} else 25.0
        story_limit = story_height / divisor
        utilization = story_limit / max(thickness, 1e-12)
        subchecks.append({
            'name': 'wall_thickness_story_height_ratio',
            'status': 'pass' if utilization <= 1.0 else 'fail',
            'utilization': round(utilization, 4),
            'demand': round(thickness, 6),
            'limit': round(story_limit, 6),
            'storyHeightMm': round(story_height, 6),
            'formula': 'Grade 1/2 wall thickness >= story height / 20; Grade 3/4 >= story height / 25',
        })

    if is_bottom_strengthened and grade in {1, 2}:
        bottom_limits = [200.0]
        if story_height is not None:
            bottom_limits.append(story_height / 16.0)
            if has_end_column_or_wing is False:
                bottom_limits.append(story_height / 12.0)
        bottom_limit = max(bottom_limits)
        utilization = bottom_limit / max(thickness, 1e-12)
        subchecks.append({
            'name': 'wall_bottom_strengthened_thickness',
            'status': 'pass' if utilization <= 1.0 else 'fail',
            'utilization': round(utilization, 4),
            'demand': round(thickness, 6),
            'limit': round(bottom_limit, 6),
            'storyHeightMm': round(story_height, 6) if story_height is not None else None,
            'hasEndColumnOrWingWall': has_end_column_or_wing,
            'formula': 'Grade 1/2 bottom-strengthened wall thickness >= 200mm and story height / 16; without end column or wing wall >= story height / 12',
        })

    if not subchecks:
        return None
    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '抗震墙墙厚',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.4.1',
        'formula': 'wall thickness satisfies seismic-grade absolute and story-height limits',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'thicknessMm': round(thickness, 6),
            'storyHeightMm': round(story_height, 6) if story_height is not None else None,
            'isBottomStrengthenedZone': is_bottom_strengthened,
            'hasEndColumnOrWingWall': has_end_column_or_wing,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }


def _shear_wall_section_area_mm2(
    section: Dict[str, Any],
    wall: Dict[str, Any],
    element: Dict[str, Any],
    metadata: Dict[str, Any],
    element_context: Dict[str, Any],
) -> Optional[float]:
    for source in (section, wall, element, metadata, element_context):
        area = _number(source.get('A')) or _number(source.get('areaMm2')) or _number(source.get('area'))
        if area is not None and area > 0.0:
            return area
    thickness = _wall_dimension_from_sources(
        wall,
        element,
        metadata,
        element_context,
        section,
        'thicknessMm',
        'wallThicknessMm',
        'tMm',
        'thickness',
        'wallThickness',
        't',
    )
    length = _wall_dimension_from_sources(
        wall,
        element,
        metadata,
        element_context,
        section,
        'lengthMm',
        'wallLengthMm',
        'lMm',
        'length',
        'wallLength',
        'l',
    )
    if thickness is None or length is None:
        return None
    return thickness * length


def _shear_wall_axial_ratio_from_sources(sources: tuple[Dict[str, Any], ...]) -> Optional[float]:
    ratio = _first_number_from_records(sources, (
        'axialCompressionRatio',
        'axialRatio',
        'axialLoadRatio',
        'axialStressRatio',
        'nOverFcA',
    ))
    if ratio is None or ratio < 0.0:
        return None
    return ratio


def _shear_wall_axial_ratio_limit_from_sources(sources: tuple[Dict[str, Any], ...]) -> Optional[Dict[str, Any]]:
    for source in sources:
        for key in (
            'axialCompressionRatioLimit',
            'axialRatioLimit',
            'maxAxialCompressionRatio',
            'maxAxialRatio',
            'nOverFcALimit',
        ):
            value = _number(source.get(key))
            if value is not None and value > 0.0:
                return {
                    'limit': value,
                    'source': key,
                }
    return None


def _shear_wall_axial_compression_ratio_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_shear_wall(context, elem_id, element):
        return None

    section = _record(element.get('section'))
    reinforcement = _reinforcement_data(element)
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    wall = _shear_wall_detailing_group(context, elem_id, element, reinforcement)
    sources = (wall, element, metadata, element_context, section)
    limit_info = _shear_wall_axial_ratio_limit_from_sources(sources)
    axial_ratio = _shear_wall_axial_ratio_from_sources(sources)
    axial_demand_kn = _element_axial_demand_kn(context, elem_id, element)
    area = _shear_wall_section_area_mm2(section, wall, element, metadata, element_context)
    material = _record(element.get('material'))
    strength = _material_strength_mpa(material)
    ratio_source = 'structuredAxialRatio'
    if axial_ratio is None and axial_demand_kn is not None and area is not None and area > 0.0 and strength is not None and strength > 0.0:
        axial_ratio = axial_demand_kn / max(strength * area / 1000.0, 1e-12)
        ratio_source = 'memberDesignActionCombinations/section/material'

    if axial_ratio is None and axial_demand_kn is None:
        return None

    if axial_ratio is None or limit_info is None:
        return {
            'item': '抗震墙轴压比限值',
            'status': 'input_required',
            'category': 'input_required',
            'utilization': None,
            'clause': 'GB/T 50011-2010(2024) 6.4',
            'formula': 'wall axial compression ratio should be checked against a structured project/code-derived limit',
            'inputs': {
                'elementId': elem_id,
                'axialDemandKN': round(axial_demand_kn, 6) if axial_demand_kn is not None else None,
                'areaMm2': round(area, 6) if area is not None else None,
                'fcMPa': round(strength, 6) if strength is not None else None,
                'axialCompressionRatio': round(axial_ratio, 6) if axial_ratio is not None else None,
                'limit': None if limit_info is None else round(float(limit_info['limit']), 6),
            },
            'message': 'Structured seismic-wall axial ratio data or its project/code-derived limit is unavailable.',
        }

    limit = float(limit_info['limit'])
    utilization = axial_ratio / max(limit, 1e-12)
    return {
        'item': '抗震墙轴压比限值',
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.4',
        'formula': 'N/(fc*A) or structured axial compression ratio <= structured project/code-derived limit',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': _seismic_grade(context, elem_id, element),
            'axialDemandKN': round(axial_demand_kn, 6) if axial_demand_kn is not None else None,
            'areaMm2': round(area, 6) if area is not None else None,
            'fcMPa': round(strength, 6) if strength is not None else None,
            'axialCompressionRatio': round(axial_ratio, 6),
            'limit': round(limit, 6),
            'limitSource': limit_info.get('source'),
            'ratioSource': ratio_source,
        },
    }


def _wall_reinforcement_ratio_percent(
    group: Dict[str, Any],
    wall: Dict[str, Any],
    orientation: str,
    *,
    thickness_mm: Optional[float],
) -> Optional[float]:
    orientation_prefix = 'vertical' if orientation == 'vertical' else 'horizontal'
    explicit = _ratio_percent_from_sources(
        (group, wall),
        (
            f'{orientation_prefix}RatioPercent',
            f'{orientation_prefix}ReinforcementRatioPercent',
            f'{orientation_prefix}DistributedRatioPercent',
            f'{orientation_prefix}DistributionRatioPercent',
            'ratioPercent',
            'reinforcementRatioPercent',
            'distributedReinforcementRatioPercent',
        ),
        (
            f'{orientation_prefix}Ratio',
            f'{orientation_prefix}ReinforcementRatio',
            f'{orientation_prefix}DistributedRatio',
            f'{orientation_prefix}DistributionRatio',
            'ratio',
            'reinforcementRatio',
            'distributedReinforcementRatio',
        ),
    )
    if explicit is not None:
        return explicit
    diameter = _reinforcement_diameter_mm(group)
    spacing = _dimension_from_keys_mm(
        group,
        f'{orientation_prefix}SpacingMm',
        'spacingMm',
        'spacing',
        's',
    )
    if diameter is None or spacing is None or thickness_mm is None:
        return None
    layer_count = _number(group.get('layerCount') or wall.get(f'{orientation_prefix}LayerCount') or wall.get('layerCount'))
    if layer_count is None:
        double_layer = _optional_bool_from_sources((group, wall), ('doubleLayer', 'doubleRows', 'twoLayers', 'twoRows'))
        layer_count = 2.0 if double_layer else 1.0
    area_per_bar = math.pi * diameter * diameter / 4.0
    ratio = float(layer_count) * area_per_bar / max(spacing * thickness_mm, 1e-12) * 100.0
    return ratio


def _wall_reinforcement_diameter_mm(group: Dict[str, Any], orientation: str) -> Optional[float]:
    prefix = 'vertical' if orientation == 'vertical' else 'horizontal'
    diameter = _dimension_from_keys_mm(
        group,
        f'{prefix}DiameterMm',
        f'{prefix}BarDiameterMm',
        f'{prefix}DMm',
    )
    return diameter if diameter is not None else _reinforcement_diameter_mm(group)


def _shear_wall_distributed_reinforcement_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_shear_wall(context, elem_id, element):
        return None

    section = _record(element.get('section'))
    reinforcement = _reinforcement_data(element)
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    wall = _shear_wall_detailing_group(context, elem_id, element, reinforcement)
    if not reinforcement and not wall:
        return None
    thickness = _wall_dimension_from_sources(
        wall,
        element,
        metadata,
        element_context,
        section,
        'thicknessMm',
        'wallThicknessMm',
        'tMm',
        'thickness',
        'wallThickness',
        't',
    )
    grade = _seismic_grade(context, elem_id, element)
    is_partial_frame_supported_bottom = _wall_bool(
        wall,
        element,
        metadata,
        element_context,
        'isPartialFrameSupportedBottomStrengthenedZone',
        'partialFrameSupportedBottomStrengthenedZone',
        'isFrameSupportedWallBottomStrengthenedZone',
        'frameSupportedWallBottomStrengthenedZone',
    )
    ratio_limit = 0.30 if is_partial_frame_supported_bottom else 0.20 if grade == 4 else 0.25 if grade in {1, 2, 3} else None
    spacing_limit = 200.0 if is_partial_frame_supported_bottom else 300.0
    diameter_limit = 8.0
    vertical = _wall_orientation_group(reinforcement, wall, 'vertical')
    horizontal = _wall_orientation_group(reinforcement, wall, 'horizontal')

    subchecks: List[Dict[str, Any]] = []
    if thickness is not None and thickness > 140.0:
        double_layer = _optional_bool_from_sources(
            (wall, reinforcement, vertical, horizontal),
            ('doubleLayer', 'doubleRows', 'twoLayers', 'twoRows', 'distributedReinforcementDoubleLayer'),
        )
        if double_layer is not None:
            subchecks.append({
                'name': 'wall_distributed_reinforcement_double_layer',
                'status': 'pass' if double_layer else 'fail',
                'utilization': 0.0 if double_layer else 2.0,
                'demand': double_layer,
                'limit': True,
                'formula': 'when wall thickness > 140mm, vertical and horizontal distributed reinforcement should be double-layer',
            })
        tie = _reinforcement_group(wall, 'tie', 'ties', 'tieBars', '拉筋') or _reinforcement_group(reinforcement, 'tie', 'ties', 'tieBars', '拉筋')
        tie_spacing = _dimension_from_keys_mm(tie, 'spacingMm', 'tieSpacingMm', 'spacing', 's')
        tie_diameter = _reinforcement_diameter_mm(tie)
        if tie_spacing is not None:
            tie_spacing_utilization = tie_spacing / 600.0
            subchecks.append({
                'name': 'wall_tie_spacing',
                'status': 'pass' if tie_spacing_utilization <= 1.0 else 'fail',
                'utilization': round(tie_spacing_utilization, 4),
                'demand': round(tie_spacing, 6),
                'limit': 600.0,
                'formula': 'tie spacing between double-layer distributed reinforcement <= 600mm',
            })
        if tie_diameter is not None:
            tie_diameter_utilization = 6.0 / max(tie_diameter, 1e-12)
            subchecks.append({
                'name': 'wall_tie_diameter',
                'status': 'pass' if tie_diameter_utilization <= 1.0 else 'fail',
                'utilization': round(tie_diameter_utilization, 4),
                'demand': round(tie_diameter, 6),
                'limit': 6.0,
                'formula': 'tie diameter between double-layer distributed reinforcement >= 6mm',
            })

    for orientation, group in (('vertical', vertical), ('horizontal', horizontal)):
        if not group:
            continue
        label = 'vertical' if orientation == 'vertical' else 'horizontal'
        ratio = _wall_reinforcement_ratio_percent(group, wall, orientation, thickness_mm=thickness)
        if ratio is not None and ratio_limit is not None:
            ratio_utilization = ratio_limit / max(ratio, 1e-12)
            subchecks.append({
                'name': f'wall_{label}_distributed_reinforcement_ratio',
                'status': 'pass' if ratio_utilization <= 1.0 else 'fail',
                'utilization': round(ratio_utilization, 4),
                'demand': round(ratio, 6),
                'limit': ratio_limit,
                'formula': 'vertical and horizontal distributed reinforcement ratio >= grade limit',
            })
        spacing = _dimension_from_keys_mm(group, f'{label}SpacingMm', 'spacingMm', 'spacing', 's')
        if spacing is not None:
            spacing_utilization = spacing / spacing_limit
            subchecks.append({
                'name': f'wall_{label}_distributed_reinforcement_spacing',
                'status': 'pass' if spacing_utilization <= 1.0 else 'fail',
                'utilization': round(spacing_utilization, 4),
                'demand': round(spacing, 6),
                'limit': spacing_limit,
                'formula': 'distributed reinforcement spacing <= 300mm; frame-supported bottom-strengthened wall <= 200mm',
            })
        diameter = _wall_reinforcement_diameter_mm(group, orientation)
        if diameter is not None:
            diameter_utilization = diameter_limit / max(diameter, 1e-12)
            subchecks.append({
                'name': f'wall_{label}_distributed_reinforcement_diameter',
                'status': 'pass' if diameter_utilization <= 1.0 else 'fail',
                'utilization': round(diameter_utilization, 4),
                'demand': round(diameter, 6),
                'limit': diameter_limit,
                'formula': 'distributed reinforcement bar diameter >= 8mm',
            })

    if not subchecks:
        return None
    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '抗震墙分布钢筋构造',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.4.2 + 6.4.3',
        'formula': 'wall distributed reinforcement layer, tie, ratio, spacing, and diameter satisfy seismic detailing limits',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'thicknessMm': round(thickness, 6) if thickness is not None else None,
            'ratioLimitPercent': ratio_limit,
            'spacingLimitMm': spacing_limit,
            'isPartialFrameSupportedBottomStrengthenedZone': is_partial_frame_supported_bottom,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }
