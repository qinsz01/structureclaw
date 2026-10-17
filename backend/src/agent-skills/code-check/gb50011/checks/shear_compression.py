"""Concrete member shear-compression limit checks."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _element_type,
    _is_concrete_frame_beam_or_column,
    _is_concrete_shear_wall,
    _is_transfer_frame_member,
    _is_true,
    _material_strength_mpa,
    _number,
    _number_from_keys,
    _record,
)
from .element_context import (
    _column_shear_span_ratio_info,
    _member_combination_action_entries,
)
from .reinforcement import (
    _dimension_from_keys_mm,
    _reinforcement_data,
)
from .shear_wall import (
    _shear_wall_detailing_group,
)


def _is_concrete_shear_compression_member(context: Dict[str, Any], elem_id: str, element: Dict[str, Any]) -> bool:
    if _is_concrete_frame_beam_or_column(context, elem_id, element) or _is_concrete_shear_wall(context, elem_id, element):
        return True
    element_type = _element_type(context, elem_id, element)
    if element_type not in {'coupling-beam', 'coupling_beam', 'link-beam', 'link_beam', 'wall-beam', 'wall_beam'}:
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
    return 'concrete' in structural_family


def _shear_compression_group(element: Dict[str, Any]) -> Dict[str, Any]:
    for key in (
        'shearCompression',
        'shearCompressionLimit',
        'shearCompressionCheck',
        'seismicShearCompression',
        'seismicShearCompressionLimit',
        'seismicShearCompressionCheck',
    ):
        record = _record(element.get(key))
        if record:
            return record
    return {}


def _shear_compression_has_marker(element: Dict[str, Any], group: Dict[str, Any]) -> bool:
    marker_keys = {
        'shearCompression',
        'shearCompressionLimit',
        'shearCompressionCheck',
        'seismicShearCompression',
        'seismicShearCompressionLimit',
        'seismicShearCompressionCheck',
        'shearCompressionUtilization',
        'seismicShearCompressionUtilization',
        'shearCompressionRatio',
        'seismicShearCompressionRatio',
    }
    return bool(group) or any(key in element for key in marker_keys)


def _shear_compression_explicit_utilization(element: Dict[str, Any], group: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    for source_name, source in (('shearCompression', group), ('element', element)):
        for key in (
            'shearCompressionUtilization',
            'seismicShearCompressionUtilization',
            'shearCompressionDcr',
            'seismicShearCompressionDcr',
            'demandCapacityRatio',
            'dcr',
            'utilization',
        ):
            value = _number(source.get(key))
            if value is not None and value >= 0.0:
                return {'value': value, 'source': f'{source_name}.{key}'}
    return None


def _shear_compression_demand_kn(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
    group: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    for source_name, source in (('shearCompression', group), ('element', element)):
        for key in (
            'shearDesignValueKN',
            'seismicShearDesignValueKN',
            'shearDemandKN',
            'seismicShearDemandKN',
            'maxAbsShearKN',
            'VDemandKN',
            'VcKN',
            'VKN',
        ):
            value = _number(source.get(key))
            if value is not None:
                return {'value': abs(value), 'source': f'{source_name}.{key}'}

    actions = _member_combination_action_entries(_record(context.get('analysisSummary')), elem_id)
    best: Optional[Dict[str, Any]] = None
    for action in actions:
        value = _number(action.get('maxAbsShearKN'))
        if value is None:
            continue
        demand = abs(value)
        if best is None or demand > float(best.get('value', 0.0)):
            best = {
                'value': demand,
                'source': 'memberDesignActionCombinations.maxAbsShearKN',
                'case': action.get('case'),
            }
    return best


def _shear_compression_gamma_re(
    context: Dict[str, Any],
    element: Dict[str, Any],
    group: Dict[str, Any],
) -> float:
    design_basis = _record(_record(context.get('analysisSummary')).get('designBasis'))
    for source in (group, element, design_basis, context):
        value = _number(source.get('gammaRE') or source.get('gammaRe') or source.get('seismicCapacityAdjustmentFactor'))
        if value is not None and value > 0.0:
            return value
    return 0.85


def _shear_compression_span_depth_ratio(element: Dict[str, Any], group: Dict[str, Any], section: Dict[str, Any], h0: Optional[float]) -> Optional[float]:
    for source in (group, element, section):
        ratio = _number_from_keys(source, ('spanDepthRatio', 'clearSpanDepthRatio', 'couplingBeamSpanDepthRatio'))
        if ratio is not None and ratio > 0.0:
            return ratio
    span = _dimension_from_keys_mm(element, 'clearSpanMm', 'spanMm', 'clearSpan', 'span')
    if span is None:
        span = _dimension_from_keys_mm(section, 'clearSpanMm', 'spanMm', 'clearSpan', 'span')
    if span is not None and h0 is not None and h0 > 0.0:
        return span / h0
    return None


def _shear_compression_effective_depth_mm(element: Dict[str, Any], group: Dict[str, Any], section: Dict[str, Any], is_wall: bool) -> Optional[Dict[str, Any]]:
    for source_name, source in (('shearCompression', group), ('element', element), ('section', section)):
        value = _dimension_from_keys_mm(source, 'h0Mm', 'h0', 'effectiveDepthMm', 'effectiveDepth', 'effectiveHeightMm', 'effectiveHeight')
        if value is not None:
            return {'value': value, 'source': source_name}
    if is_wall:
        value = _dimension_from_keys_mm(section, 'wallLengthMm', 'wallLength', 'lengthMm', 'length', 'LwMm', 'Lw')
        if value is not None:
            return {'value': value, 'source': 'section.wallLength'}
        properties = _record(section.get('properties'))
        value = _dimension_from_keys_mm(properties, 'wallLengthMm', 'wallLength', 'lengthMm', 'length', 'LwMm', 'Lw')
        if value is not None:
            return {'value': value, 'source': 'section.properties.wallLength'}
    return None


def _shear_compression_width_mm(element: Dict[str, Any], group: Dict[str, Any], section: Dict[str, Any], is_wall: bool) -> Optional[Dict[str, Any]]:
    keys = (
        ('bwMm', 'bw', 'wallThicknessMm', 'wallThickness', 'thicknessMm', 'thickness', 'bMm', 'b', 'widthMm', 'width')
        if is_wall else
        ('bwMm', 'bw', 'bMm', 'b', 'widthMm', 'width')
    )
    for source_name, source in (('shearCompression', group), ('element', element), ('section', section)):
        value = _dimension_from_keys_mm(source, *keys)
        if value is not None:
            return {'value': value, 'source': source_name}
    return None


def _shear_compression_coefficient(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
    group: Dict[str, Any],
    section: Dict[str, Any],
    h0: Optional[float],
) -> Dict[str, Any]:
    element_type = _element_type(context, elem_id, element)
    is_wall = _is_concrete_shear_wall(context, elem_id, element)
    shear_info = _column_shear_span_ratio_info(context, elem_id, element)
    shear_span_ratio = _number(shear_info.get('ratio')) if shear_info else _number_from_keys(group, ('shearSpanRatio', 'lambda', 'lambdaV'))
    span_depth_ratio = _shear_compression_span_depth_ratio(element, group, section, h0)
    is_short = False
    basis: List[str] = []
    if element_type in {'beam', 'frame-beam', 'concrete-beam', 'rc-beam', 'transfer-beam', 'coupling-beam', 'coupling_beam', 'link-beam', 'link_beam', 'wall-beam', 'wall_beam'}:
        if span_depth_ratio is not None and span_depth_ratio <= 2.5:
            is_short = True
            basis.append('span-depth ratio <= 2.5')
    if element_type in {'column', 'frame-column', 'concrete-column', 'rc-column', 'transfer-column'} or is_wall:
        if shear_span_ratio is not None and shear_span_ratio <= 2.0:
            is_short = True
            basis.append('shear-span ratio <= 2.0')
    if _is_transfer_frame_member(context, elem_id, element):
        is_short = True
        basis.append('transfer member')
    wall = _shear_wall_detailing_group(context, elem_id, element, _reinforcement_data(element))
    if is_wall and (_is_true(wall.get('isBottomStrengthenedZone')) or _is_true(group.get('isBottomStrengthenedZone'))):
        is_short = True
        basis.append('bottom strengthened wall zone')
    return {
        'coefficient': 0.15 if is_short else 0.20,
        'basis': basis or ['ordinary span/shear-span condition'],
        'spanDepthRatio': span_depth_ratio,
        'shearSpanRatio': shear_span_ratio,
    }


def _concrete_member_shear_compression_limit_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_shear_compression_member(context, elem_id, element):
        return None
    group = _shear_compression_group(element)
    marker = _shear_compression_has_marker(element, group)
    explicit_utilization = _shear_compression_explicit_utilization(element, group)
    element_type = _element_type(context, elem_id, element)
    if explicit_utilization is not None:
        utilization = float(explicit_utilization['value'])
        return {
            'item': '混凝土构件剪压比限值',
            'status': 'pass' if utilization <= 1.0 else 'fail',
            'utilization': round(utilization, 4),
            'clause': 'GB/T 50011-2010(2024) 6.2.9',
            'formula': 'provided structured shear-compression utilization <= 1.0',
            'inputs': {
                'elementId': elem_id,
                'elementType': element_type,
                'source': explicit_utilization.get('source'),
                'providedUtilization': round(utilization, 6),
            },
        }

    demand_info = _shear_compression_demand_kn(context, elem_id, element, group)
    section = _record(element.get('section'))
    material = _record(element.get('material'))
    fc = _material_strength_mpa(material)
    is_wall = _is_concrete_shear_wall(context, elem_id, element)
    h0_info = _shear_compression_effective_depth_mm(element, group, section, is_wall)
    width_info = _shear_compression_width_mm(element, group, section, is_wall)
    gamma_re = _shear_compression_gamma_re(context, element, group)
    if demand_info is None or fc is None or h0_info is None or width_info is None:
        if not marker:
            return None
        return {
            'item': '混凝土构件剪压比限值',
            'status': 'input_required',
            'category': 'input_required',
            'utilization': None,
            'clause': 'GB/T 50011-2010(2024) 6.2.9',
            'formula': 'V <= coefficient * fc * b * h0 / gammaRE',
            'inputs': {
                'elementId': elem_id,
                'elementType': element_type,
                'hasDemand': demand_info is not None,
                'hasConcreteStrength': fc is not None,
                'hasWidth': width_info is not None,
                'hasEffectiveDepth': h0_info is not None,
            },
            'message': 'Structured shear-compression data is present but does not include comparable shear demand, concrete strength, width, and effective depth.',
        }
    h0 = float(h0_info['value'])
    width = float(width_info['value'])
    coefficient_info = _shear_compression_coefficient(context, elem_id, element, group, section, h0)
    coefficient = float(coefficient_info['coefficient'])
    capacity = coefficient * float(fc) * width * h0 / max(gamma_re, 1e-12) / 1000.0
    demand = float(demand_info['value'])
    utilization = demand / max(capacity, 1e-12)
    return {
        'item': '混凝土构件剪压比限值',
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.2.9',
        'formula': 'V <= coefficient * fc * b * h0 / gammaRE',
        'inputs': {
            'elementId': elem_id,
            'elementType': element_type,
            'shearDemandKN': round(demand, 6),
            'shearDemandSource': demand_info.get('source'),
            'case': demand_info.get('case'),
            'fcMPa': round(float(fc), 6),
            'widthMm': round(width, 6),
            'widthSource': width_info.get('source'),
            'effectiveDepthMm': round(h0, 6),
            'effectiveDepthSource': h0_info.get('source'),
            'gammaRE': round(gamma_re, 6),
            'coefficient': coefficient,
            'coefficientBasis': coefficient_info.get('basis'),
            'spanDepthRatio': (
                round(float(coefficient_info['spanDepthRatio']), 6)
                if coefficient_info.get('spanDepthRatio') is not None else None
            ),
            'shearSpanRatio': (
                round(float(coefficient_info['shearSpanRatio']), 6)
                if coefficient_info.get('shearSpanRatio') is not None else None
            ),
            'capacityKN': round(capacity, 6),
        },
    }
