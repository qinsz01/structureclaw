"""Section dimension and reinforcement data extraction helpers."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from .common import (
    _element_context,
    _element_metadata,
    _number,
    _record,
)


def _dimension_mm(value: Any) -> Optional[float]:
    number = _number(value)
    if number is None or number <= 0.0:
        return None
    return number * 1000.0 if number <= 10.0 else number


def _section_dimension_mm(section: Dict[str, Any], *keys: str) -> Optional[float]:
    shape = _record(section.get('shape'))
    properties = _record(section.get('properties'))
    for source in (section, properties, shape):
        for key in keys:
            value = _dimension_mm(source.get(key))
            if value is not None:
                return value
    return None


def _reinforcement_data(element: Dict[str, Any]) -> Dict[str, Any]:
    section = _record(element.get('section'))
    return _record(element.get('reinforcement')) or _record(section.get('reinforcement'))


def _reinforcement_group(reinforcement: Dict[str, Any], *keys: str) -> Dict[str, Any]:
    for key in keys:
        group = _record(reinforcement.get(key))
        if group:
            return group
    return {}


def _reinforcement_count(group: Dict[str, Any]) -> Optional[float]:
    for key in ('count', 'barCount', 'number', 'bars'):
        count = _number(group.get(key))
        if count is not None and count >= 0.0:
            return count
    return None


def _reinforcement_diameter_mm(group: Dict[str, Any]) -> Optional[float]:
    for key in ('diameterMm', 'barDiameterMm', 'dMm'):
        diameter = _number(group.get(key))
        if diameter is not None and diameter > 0.0:
            return diameter
    for key in ('diameterM', 'barDiameterM', 'dM'):
        diameter_m = _number(group.get(key))
        if diameter_m is not None and diameter_m > 0.0:
            return diameter_m * 1000.0
    for key in ('diameter', 'd'):
        diameter = _number(group.get(key))
        if diameter is not None and diameter > 0.0:
            return diameter * 1000.0 if diameter <= 0.1 else diameter
    return None


def _reinforcement_area_mm2(group: Dict[str, Any]) -> Optional[float]:
    for key in ('areaMm2', 'asMm2', 'AsMm2', 'totalAreaMm2'):
        area = _number(group.get(key))
        if area is not None and area > 0.0:
            return area
    count = _reinforcement_count(group)
    diameter = _reinforcement_diameter_mm(group)
    if count is not None and count > 0.0 and diameter is not None and diameter > 0.0:
        return count * math.pi * diameter * diameter / 4.0
    return None


def _reinforcement_end_area_mm2(reinforcement: Dict[str, Any], side: str) -> Optional[float]:
    explicit_keys = (
        f'{side}EndMaxAreaMm2',
        f'end{side.capitalize()}MaxAreaMm2',
        f'maxEnd{side.capitalize()}AreaMm2',
    )
    for key in explicit_keys:
        area = _number(reinforcement.get(key))
        if area is not None and area > 0.0:
            return area

    side_group = _record(reinforcement.get(side))
    if side_group:
        area = _number(side_group.get('endMaxAreaMm2')) or _number(side_group.get('maxEndAreaMm2'))
        if area is not None and area > 0.0:
            return area

    candidate_areas: List[float] = []
    for key in (f'left{side.capitalize()}End', f'right{side.capitalize()}End', f'{side}LeftEnd', f'{side}RightEnd'):
        area = _reinforcement_area_mm2(_record(reinforcement.get(key)))
        if area is not None and area > 0.0:
            candidate_areas.append(area)
    return max(candidate_areas) if candidate_areas else None


def _section_area_mm2(section: Dict[str, Any]) -> Optional[float]:
    area = _number(section.get('A'))
    if area is not None and area > 0.0:
        return area
    width = _section_dimension_mm(section, 'width', 'b', 'B')
    height = _section_dimension_mm(section, 'height', 'h', 'H')
    if width is not None and height is not None:
        return width * height
    return None


def _rebar_strength_from_grade(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) and number > 0.0 else None
    text = str(value).strip().upper()
    if not text:
        return None
    digits = []
    decimal_seen = False
    for char in text:
        if char.isdigit():
            digits.append(char)
        elif char == '.' and not decimal_seen and digits:
            digits.append(char)
            decimal_seen = True
        elif digits:
            break
    if not digits:
        return None
    try:
        number = float(''.join(digits))
    except ValueError:
        return None
    return number if math.isfinite(number) and number > 0.0 else None


def _structured_rebar_strength_mpa(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
    reinforcement_group: Dict[str, Any],
) -> Optional[float]:
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    material = _record(element.get('material'))
    source_key_groups = (
        (reinforcement_group, ('rebarGrade', 'grade', 'strengthGrade')),
        (metadata, ('rebarGrade', 'frameRebarGrade')),
        (element_context, ('rebarGrade', 'frameRebarGrade')),
        (material, ('rebarGrade', 'frameRebarGrade')),
        (_record(_record(context.get('analysisSummary')).get('designBasis')), ('rebarGrade', 'frameRebarGrade')),
    )
    for source, grade_keys in source_key_groups:
        for key in ('fykMPa', 'standardStrengthMPa', 'rebarStrengthMPa', 'rebarFykMPa'):
            value = _number(source.get(key))
            if value is not None and value > 0.0:
                return value
        for key in grade_keys:
            strength = _rebar_strength_from_grade(source.get(key))
            if strength is not None:
                return strength
    return None


def _column_longitudinal_reinforcement_group(reinforcement: Dict[str, Any]) -> Dict[str, Any]:
    return _reinforcement_group(
        reinforcement,
        'longitudinal',
        'longitudinalBars',
        'columnLongitudinal',
        'vertical',
        'main',
    )


def _column_stirrup_group(reinforcement: Dict[str, Any]) -> Dict[str, Any]:
    return _reinforcement_group(
        reinforcement,
        'stirrup',
        'stirrups',
        'hoop',
        'hoops',
        'tie',
        'ties',
        'transverse',
    )


def _dimension_from_keys_mm(source: Dict[str, Any], *keys: str) -> Optional[float]:
    for key in keys:
        value = _dimension_mm(source.get(key))
        if value is not None:
            return value
    return None
