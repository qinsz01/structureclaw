"""Frame beam reinforcement and detailing data extraction helpers."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _element_context,
    _element_metadata,
    _number,
    _record,
)
from .reinforcement import (
    _dimension_from_keys_mm,
    _dimension_mm,
    _reinforcement_area_mm2,
    _reinforcement_diameter_mm,
    _reinforcement_end_area_mm2,
    _reinforcement_group,
)


def _beam_end_stirrup_group(reinforcement: Dict[str, Any]) -> Dict[str, Any]:
    return _reinforcement_group(
        reinforcement,
        'endStirrup',
        'endStirrups',
        'confinedStirrup',
        'confinedStirrups',
        'stirrup',
        'stirrups',
        'hoop',
        'hoops',
        'transverse',
    )


def _beam_end_longitudinal_group(reinforcement: Dict[str, Any]) -> Dict[str, Any]:
    return _reinforcement_group(
        reinforcement,
        'endLongitudinal',
        'endLongitudinalBars',
        'beamEndLongitudinal',
        'beamEndLongitudinalBars',
        'endReinforcement',
        'endBars',
    )


def _beam_through_joint_longitudinal_group(reinforcement: Dict[str, Any]) -> Dict[str, Any]:
    return _reinforcement_group(
        reinforcement,
        'throughJoint',
        'throughJointBars',
        'throughColumn',
        'throughColumnBars',
        'middleJointLongitudinal',
        'throughInteriorColumnLongitudinal',
    )


def _max_reinforcement_diameter_mm(group: Dict[str, Any]) -> Optional[float]:
    for key in ('maxDiameterMm', 'maxBarDiameterMm', 'maxDMm'):
        diameter = _number(group.get(key))
        if diameter is not None and diameter > 0.0:
            return diameter
    for key in ('maxDiameterM', 'maxBarDiameterM', 'maxDM'):
        diameter_m = _number(group.get(key))
        if diameter_m is not None and diameter_m > 0.0:
            return diameter_m * 1000.0
    return _reinforcement_diameter_mm(group)


def _beam_longitudinal_diameter_mm(reinforcement: Dict[str, Any]) -> Optional[float]:
    diameters: List[float] = []
    for group in (
        _reinforcement_group(reinforcement, 'topContinuous', 'continuousTop', 'longitudinalTopContinuous', 'topLongitudinalContinuous'),
        _reinforcement_group(reinforcement, 'bottomContinuous', 'continuousBottom', 'longitudinalBottomContinuous', 'bottomLongitudinalContinuous'),
        _record(reinforcement.get('leftTopEnd')),
        _record(reinforcement.get('rightTopEnd')),
        _record(reinforcement.get('leftBottomEnd')),
        _record(reinforcement.get('rightBottomEnd')),
        _record(reinforcement.get('topLeftEnd')),
        _record(reinforcement.get('topRightEnd')),
        _record(reinforcement.get('bottomLeftEnd')),
        _record(reinforcement.get('bottomRightEnd')),
        _reinforcement_group(reinforcement, 'longitudinal', 'longitudinalBars'),
    ):
        diameter = _reinforcement_diameter_mm(group)
        if diameter is not None:
            diameters.append(diameter)
    return min(diameters) if diameters else None


def _beam_through_joint_bar_diameter_mm(reinforcement: Dict[str, Any]) -> Optional[float]:
    through_joint = _beam_through_joint_longitudinal_group(reinforcement)
    for source in (through_joint, reinforcement):
        for key in (
            'throughJointBarDiameterMm',
            'maxThroughJointBarDiameterMm',
            'throughColumnBarDiameterMm',
            'maxThroughColumnBarDiameterMm',
            'throughInteriorColumnBarDiameterMm',
        ):
            diameter = _number(source.get(key))
            if diameter is not None and diameter > 0.0:
                return diameter
        for key in (
            'throughJointBarDiameter',
            'maxThroughJointBarDiameter',
            'throughColumnBarDiameter',
            'maxThroughColumnBarDiameter',
        ):
            diameter = _dimension_mm(source.get(key))
            if diameter is not None:
                return diameter
    return _max_reinforcement_diameter_mm(through_joint)


def _beam_through_joint_column_dimension_mm(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
    reinforcement: Dict[str, Any],
) -> Optional[float]:
    through_joint = _beam_through_joint_longitudinal_group(reinforcement)
    sources = (
        through_joint,
        reinforcement,
        _record(element.get('joint')),
        _record(element.get('jointData')),
        _record(element.get('connection')),
        _element_metadata(context, elem_id, element),
        _element_context(context, elem_id),
        _record(_record(context.get('jointData')).get(elem_id)),
        _record(_record(context.get('beamJointData')).get(elem_id)),
    )
    for source in sources:
        dimension = _dimension_from_keys_mm(
            source,
            'columnDimensionMm',
            'jointColumnDimensionMm',
            'directionColumnDimensionMm',
            'columnSideMm',
            'columnWidthMm',
            'rectangularColumnSideMm',
            'columnChordMm',
            'circularColumnChordMm',
            'barLocationChordMm',
            'columnDimension',
            'jointColumnDimension',
            'directionColumnDimension',
            'columnSide',
            'columnWidth',
            'columnChord',
            'circularColumnChord',
            'barLocationChord',
        )
        if dimension is not None:
            return dimension
    return None


def _flat_beam_detailing_group(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
    reinforcement: Dict[str, Any],
) -> Dict[str, Any]:
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    sources = (
        _record(reinforcement.get('flatBeam')),
        _record(reinforcement.get('wideBeam')),
        _record(element.get('flatBeam')),
        _record(element.get('wideBeam')),
        _record(element.get('joint')),
        _record(element.get('jointData')),
        _record(metadata.get('flatBeam')),
        _record(metadata.get('wideBeam')),
        _record(element_context.get('flatBeam')),
        _record(element_context.get('wideBeam')),
        _record(_record(context.get('beamFlatData')).get(elem_id)),
        _record(_record(context.get('flatBeamData')).get(elem_id)),
    )
    for source in sources:
        if source:
            return source
    return {}


def _flat_beam_column_longitudinal_diameter_mm(flat_beam: Dict[str, Any], reinforcement: Dict[str, Any]) -> Optional[float]:
    for source in (flat_beam, reinforcement):
        diameter = _dimension_from_keys_mm(
            source,
            'columnLongitudinalDiameterMm',
            'columnLongitudinalMinDiameterMm',
            'columnBarDiameterMm',
            'columnMainBarDiameterMm',
            'jointColumnLongitudinalDiameterMm',
            'columnLongitudinalDiameter',
            'columnLongitudinalMinDiameter',
            'columnBarDiameter',
            'columnMainBarDiameter',
            'jointColumnLongitudinalDiameter',
        )
        if diameter is not None:
            return diameter
    return None


def _beam_end_tension_reinforcement_ratio_percent(reinforcement: Dict[str, Any]) -> Optional[float]:
    for source in (reinforcement, _beam_end_longitudinal_group(reinforcement), _beam_end_stirrup_group(reinforcement)):
        for key in (
            'endTensionReinforcementRatioPercent',
            'beamEndTensionReinforcementRatioPercent',
            'maxEndTensionReinforcementRatioPercent',
            'tensionReinforcementRatioPercent',
            'maxTensionReinforcementRatioPercent',
        ):
            ratio = _number(source.get(key))
            if ratio is not None and ratio > 0.0:
                return ratio
        for key in (
            'endTensionReinforcementRatio',
            'beamEndTensionReinforcementRatio',
            'maxEndTensionReinforcementRatio',
            'tensionReinforcementRatio',
            'maxTensionReinforcementRatio',
        ):
            ratio = _number(source.get(key))
            if ratio is not None and ratio > 0.0:
                return ratio * 100.0 if ratio <= 1.0 else ratio
    return None


def _beam_end_compression_zone_ratio(reinforcement: Dict[str, Any]) -> Optional[float]:
    for source in (_beam_end_longitudinal_group(reinforcement), reinforcement):
        for key in (
            'compressionZoneRatio',
            'relativeCompressionZoneHeight',
            'xOverH0',
            'compressionZoneHeightRatio',
            'maxCompressionZoneRatio',
            'maxRelativeCompressionZoneHeight',
        ):
            ratio = _number(source.get(key))
            if ratio is not None and ratio > 0.0:
                return ratio
    return None


def _reinforcement_area_from_group_keys(source: Dict[str, Any], *keys: str) -> Optional[float]:
    for key in keys:
        area = _reinforcement_area_mm2(_record(source.get(key)))
        if area is not None and area > 0.0:
            return area
    return None


def _beam_end_bottom_top_area_ratio(reinforcement: Dict[str, Any]) -> Optional[float]:
    end_group = _beam_end_longitudinal_group(reinforcement)
    for source in (end_group, reinforcement):
        for key in (
            'bottomTopAreaRatio',
            'bottomToTopAreaRatio',
            'endBottomTopAreaRatio',
            'endBottomToTopAreaRatio',
            'minEndBottomTopAreaRatio',
            'minBottomTopAreaRatio',
        ):
            ratio = _number(source.get(key))
            if ratio is not None and ratio > 0.0:
                return ratio

    side_ratios: List[float] = []
    for source in (reinforcement, end_group):
        for side in ('left', 'right'):
            side_label = side.capitalize()
            top_area = _reinforcement_area_from_group_keys(
                source,
                f'{side}TopEnd',
                f'top{side_label}End',
                f'{side}EndTop',
                f'end{side_label}Top',
            )
            bottom_area = _reinforcement_area_from_group_keys(
                source,
                f'{side}BottomEnd',
                f'bottom{side_label}End',
                f'{side}EndBottom',
                f'end{side_label}Bottom',
            )
            if top_area is not None and top_area > 0.0 and bottom_area is not None and bottom_area > 0.0:
                side_ratios.append(bottom_area / top_area)
    if side_ratios:
        return min(side_ratios)

    top_area = _reinforcement_end_area_mm2(reinforcement, 'top')
    bottom_area = _reinforcement_end_area_mm2(reinforcement, 'bottom')
    if top_area is not None and top_area > 0.0 and bottom_area is not None and bottom_area > 0.0:
        return bottom_area / top_area
    return None
