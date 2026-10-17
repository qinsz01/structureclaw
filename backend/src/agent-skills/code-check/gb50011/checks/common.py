"""Shared GB 50011 helpers: value coercion, check-item builders, element classification."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from .constants import (
    FRAME_COLUMN_AXIAL_RATIO_LIMITS,
)


def _record(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            number = float(value)
        except ValueError:
            return None
        return number if math.isfinite(number) else None
    return None


def _aggregate_check_status(items: List[Dict[str, Any]]) -> str:
    statuses = [
        item.get('category') if item.get('category') in {'input_required', 'unsupported'}
        else item.get('status', 'input_required')
        for item in items
    ]
    for status in ('fail', 'unsupported', 'input_required'):
        if status in statuses:
            return status
    return 'pass' if statuses and 'pass' in statuses else 'not_applicable'


def _check_item(
    item_name: str,
    *,
    demand: Optional[float],
    capacity: Optional[float],
    clause: str,
    formula: str,
    limit: Optional[float] = None,
    unavailable_message: Optional[str] = None,
) -> Dict[str, Any]:
    if demand is None or capacity is None or not math.isfinite(demand) or not math.isfinite(capacity) or capacity <= 0.0:
        return {
            'item': item_name,
            'status': 'input_required',
            'utilization': None,
            'displayUtilization': 'N/A',
            'category': 'input_required',
            'failureType': 'input_unavailable',
            'governingEligible': False,
            'clause': clause,
            'formula': formula,
            'inputs': {
                'demand': demand,
                'capacity': capacity,
                'limit': limit,
            },
            'message': unavailable_message or 'Required seismic analysis value is unavailable.',
        }
    utilization = demand / capacity
    return {
        'item': item_name,
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'clause': clause,
        'formula': formula,
        'inputs': {
            'demand': round(demand, 8),
            'capacity': round(capacity, 8),
            'limit': limit if limit is None else round(limit, 8),
        },
    }


def _minimum_required_ratio_check_item(
    item_name: str,
    *,
    actual_ratio: Optional[float],
    required_ratio: float,
    clause: str,
    formula: str,
) -> Dict[str, Any]:
    if actual_ratio is None:
        return _check_item(
            item_name,
            demand=None,
            capacity=None,
            clause=clause,
            formula=formula,
            limit=required_ratio,
            unavailable_message='Required time-history base-shear ratio is unavailable.',
        )
    if actual_ratio <= 0.0:
        return {
            'item': item_name,
            'status': 'fail',
            'utilization': 0.0,
            'displayUtilization': 'N/A',
            'category': 'input_required',
            'failureType': 'missing_time_history_base_shear_ratio',
            'governingEligible': False,
            'clause': clause,
            'formula': formula,
            'inputs': {
                'demand': round(actual_ratio, 8),
                'capacity': required_ratio,
                'limit': required_ratio,
            },
            'message': 'Time-history base-shear ratio is zero; provide valid ground-motion response results before final compliance.',
        }
    capacity = max(actual_ratio, 1e-12)
    utilization = required_ratio / capacity
    return {
        'item': item_name,
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'clause': clause,
        'formula': formula,
        'inputs': {
            'demand': round(actual_ratio, 8),
            'capacity': round(required_ratio, 8),
            'limit': required_ratio,
        },
    }


def _is_true(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.strip().lower() in {'true', 'yes', '1'})


def _is_false(value: Any) -> bool:
    return value is False or (isinstance(value, str) and value.strip().lower() in {'false', 'no', '0'})


def _optional_bool_from_sources(sources: tuple[Dict[str, Any], ...], keys: tuple[str, ...]) -> Optional[bool]:
    for source in sources:
        for key in keys:
            value = source.get(key)
            if _is_true(value):
                return True
            if _is_false(value):
                return False
    return None


def _ratio_percent_from_keys(
    source: Dict[str, Any],
    percent_keys: tuple[str, ...],
    ratio_keys: tuple[str, ...],
) -> Optional[float]:
    for key in percent_keys:
        ratio = _number(source.get(key))
        if ratio is not None and ratio >= 0.0:
            return ratio
    for key in ratio_keys:
        ratio = _number(source.get(key))
        if ratio is not None and ratio >= 0.0:
            return ratio * 100.0 if ratio <= 1.0 else ratio
    return None


def _section_modulus_mm3(section: Dict[str, Any]) -> Optional[float]:
    for key in ('Wnx', 'Wx', 'W'):
        value = _number(section.get(key))
        if value is not None and value > 0.0:
            return value
    area = _number(section.get('A'))
    inertia = _number(section.get('I'))
    if inertia is None:
        inertia = _number(section.get('Iy')) or _number(section.get('Iz'))
    if area is None or inertia is None or area <= 0.0 or inertia <= 0.0:
        return None
    equivalent_depth = math.sqrt(max(12.0 * inertia / area, 1e-12))
    return 2.0 * inertia / max(equivalent_depth, 1e-12)


def _material_strength_mpa(material: Dict[str, Any]) -> Optional[float]:
    for key in ('fc', 'f', 'fy'):
        value = _number(material.get(key))
        if value is not None and value > 0.0:
            return value
    if material:
        return 14.3
    return None


def _concrete_grade_value(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) and number > 0.0 else None
    text = str(value).strip().upper()
    if not text:
        return None
    if text.startswith('C'):
        text = text[1:]
    digits = []
    decimal_seen = False
    for char in text:
        if char.isdigit():
            digits.append(char)
        elif char == '.' and not decimal_seen:
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


def _concrete_grade_from_material(material: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    extra = _record(material.get('extra'))
    for key in ('concreteGrade', 'grade', 'strengthGrade', 'name'):
        grade = _concrete_grade_value(material.get(key))
        if grade is not None:
            return {'grade': grade, 'source': f'material.{key}'}
    for key in ('concreteGrade', 'grade', 'strengthGrade'):
        grade = _concrete_grade_value(extra.get(key))
        if grade is not None:
            return {'grade': grade, 'source': f'material.extra.{key}'}
    for key in ('fc', 'f'):
        strength = _number(material.get(key))
        if strength is not None and strength > 0.0:
            return {'fcMPa': strength, 'source': f'material.{key}'}
    for key in ('fc', 'f'):
        strength = _number(extra.get(key))
        if strength is not None and strength > 0.0:
            return {'fcMPa': strength, 'source': f'material.extra.{key}'}
    return None


def _normalize_seismic_grade(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        grade = int(value)
        return grade if grade in FRAME_COLUMN_AXIAL_RATIO_LIMITS else None
    text = str(value).strip().lower()
    mapping = {
        '1': 1,
        'i': 1,
        'grade1': 1,
        'grade 1': 1,
        'first': 1,
        '一级': 1,
        '一': 1,
        '2': 2,
        'ii': 2,
        'grade2': 2,
        'grade 2': 2,
        'second': 2,
        '二级': 2,
        '二': 2,
        '3': 3,
        'iii': 3,
        'grade3': 3,
        'grade 3': 3,
        'third': 3,
        '三级': 3,
        '三': 3,
        '4': 4,
        'iv': 4,
        'grade4': 4,
        'grade 4': 4,
        'fourth': 4,
        '四级': 4,
        '四': 4,
    }
    return mapping.get(text)


def _element_context(context: Dict[str, Any], elem_id: str) -> Dict[str, Any]:
    return _record(_record(context.get('elementContextById')).get(elem_id))


def _element_metadata(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> Dict[str, Any]:
    metadata = _record(element.get('metadata'))
    if metadata:
        return metadata
    return _record(_element_context(context, elem_id).get('metadata'))


def _element_type(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> str:
    value = element.get('type')
    if value is None:
        value = _element_context(context, elem_id).get('type')
    return str(value or '').strip().lower()


def _is_concrete_frame_column(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> bool:
    element_type = _element_type(context, elem_id, element)
    if element_type not in {'column', 'frame-column', 'concrete-column', 'rc-column'}:
        return False
    material = _record(element.get('material'))
    category = str(material.get('category') or material.get('family') or '').strip().lower()
    name = str(material.get('name') or material.get('grade') or '').strip().lower()
    if category and category not in {'concrete', 'reinforced-concrete', 'rc'}:
        return False
    if not category and name and not (name.startswith('c') or 'concrete' in name):
        return False
    return True


def _is_concrete_frame_beam_or_column(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> bool:
    element_type = _element_type(context, elem_id, element)
    if element_type not in {'beam', 'frame-beam', 'concrete-beam', 'rc-beam', 'transfer-beam', 'column', 'frame-column', 'concrete-column', 'rc-column', 'transfer-column'}:
        return False
    material = _record(element.get('material'))
    category = str(material.get('category') or material.get('family') or '').strip().lower()
    name = str(material.get('name') or material.get('grade') or '').strip().lower()
    if category and category not in {'concrete', 'reinforced-concrete', 'rc'}:
        return False
    if not category and name and not (name.startswith('c') or 'concrete' in name):
        return False
    if category or name:
        return True
    structural_family = str(_record(_record(context.get('analysisSummary')).get('designBasis')).get('structuralFamily') or '').strip().lower()
    return 'concrete' in structural_family and 'frame' in structural_family


def _is_concrete_frame_beam(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> bool:
    element_type = _element_type(context, elem_id, element)
    return element_type in {'beam', 'frame-beam', 'concrete-beam', 'rc-beam', 'transfer-beam'} and _is_concrete_frame_beam_or_column(context, elem_id, element)


def _is_concrete_frame_joint(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> bool:
    element_type = _element_type(context, elem_id, element)
    if element_type not in {'joint', 'frame-joint', 'beam-column-joint', 'rc-joint', 'core-joint'}:
        return _is_concrete_frame_beam_or_column(context, elem_id, element)

    material = _record(element.get('material'))
    category = str(material.get('category') or material.get('family') or '').strip().lower()
    name = str(material.get('name') or material.get('grade') or '').strip().lower()
    if category and category not in {'concrete', 'reinforced-concrete', 'rc'}:
        return False
    if not category and name and not (name.startswith('c') or 'concrete' in name):
        return False
    if category or name:
        return True
    structural_family = str(_record(_record(context.get('analysisSummary')).get('designBasis')).get('structuralFamily') or '').strip().lower()
    return 'concrete' in structural_family and 'frame' in structural_family


def _is_concrete_shear_wall(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> bool:
    element_type = _element_type(context, elem_id, element)
    if element_type not in {'wall', 'shear-wall', 'shear_wall', 'seismic-wall', 'seismic_wall', 'structural-wall', 'structural_wall', 'rc-wall', 'concrete-wall'}:
        return False
    material = _record(element.get('material'))
    category = str(material.get('category') or material.get('family') or '').strip().lower()
    name = str(material.get('name') or material.get('grade') or '').strip().lower()
    if category and category not in {'concrete', 'reinforced-concrete', 'rc'}:
        return False
    if not category and name and not (name.startswith('c') or 'concrete' in name):
        return False
    if category or name:
        return True
    structural_family = str(_record(_record(context.get('analysisSummary')).get('designBasis')).get('structuralFamily') or '').strip().lower()
    return 'concrete' in structural_family and ('wall' in structural_family or 'shear' in structural_family)


def _is_steel_member(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> bool:
    element_type = _element_type(context, elem_id, element)
    if element_type not in {
        'beam',
        'frame-beam',
        'steel-beam',
        'column',
        'frame-column',
        'steel-column',
        'brace',
        'bracing',
        'steel-brace',
        'link',
        'steel-link',
    }:
        return False
    material = _record(element.get('material'))
    category = str(material.get('category') or material.get('family') or '').strip().lower()
    name = str(material.get('name') or material.get('grade') or '').strip().lower()
    if category:
        return category in {'steel', 'structural-steel', 'structural_steel'}
    if name:
        return 'steel' in name or name.startswith(('q235', 'q345', 'q355', 'q390', 'q420', 'q460'))
    structural_family = str(_record(_record(context.get('analysisSummary')).get('designBasis')).get('structuralFamily') or '').strip().lower()
    return 'steel' in structural_family


def _is_transfer_frame_member(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> bool:
    element_type = _element_type(context, elem_id, element)
    metadata = _element_metadata(context, elem_id, element)
    return element_type in {'transfer-beam', 'transfer-column', 'frame-supported-beam', 'frame-supported-column'} or _is_true(metadata.get('isTransferMember'))


def _ratio_percent_from_sources(
    sources: tuple[Dict[str, Any], ...],
    percent_keys: tuple[str, ...],
    ratio_keys: tuple[str, ...],
) -> Optional[float]:
    for source in sources:
        ratio = _ratio_percent_from_keys(source, percent_keys, ratio_keys)
        if ratio is not None:
            return ratio
    return None


def _number_from_keys(source: Dict[str, Any], keys: tuple[str, ...]) -> Optional[float]:
    for key in keys:
        value = _number(source.get(key))
        if value is not None:
            return value
    return None


def _first_number_from_records(records: tuple[Dict[str, Any], ...], keys: tuple[str, ...]) -> Optional[float]:
    for record in records:
        for key in keys:
            value = _number(record.get(key))
            if value is not None:
                return value
    return None
