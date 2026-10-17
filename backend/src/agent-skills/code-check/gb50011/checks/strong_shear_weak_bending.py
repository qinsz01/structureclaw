"""Frame member strong shear / weak bending checks."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _aggregate_check_status,
    _element_context,
    _element_metadata,
    _element_type,
    _is_concrete_frame_beam_or_column,
    _is_true,
    _number_from_keys,
    _record,
)
from .element_context import (
    _seismic_grade,
)


def _strong_shear_weak_bending_marker(source: Dict[str, Any]) -> bool:
    marker_keys = {
        'strongShearWeakBending',
        'strongShearWeakFlexure',
        'strongShearWeakMoment',
        'shearBendingCapacityDesign',
        'capacityDesignShear',
        'bendingControlledShearDemandKN',
        'flexuralOverstrengthShearDemandKN',
        'strongShearDemandKN',
        'strongShearCapacityKN',
        'capacityDesignShearDemandKN',
        'strongShearWeakBendingUtilization',
        'shearBendingUtilization',
        'capacityDesignShearUtilization',
    }
    if any(key in source for key in marker_keys):
        return True
    for key in ('checks', 'cases', 'directions', 'positive', 'negative', 'x', 'y'):
        raw = source.get(key)
        if isinstance(raw, list) and any(_strong_shear_weak_bending_marker(_record(item)) for item in raw if isinstance(item, dict)):
            return True
        nested = _record(raw)
        if nested and _strong_shear_weak_bending_marker(nested):
            return True
    return False


def _strong_shear_weak_bending_records(source: Dict[str, Any], source_name: str) -> List[Dict[str, Any]]:
    if not source:
        return []
    records: List[Dict[str, Any]] = []
    if _strong_shear_weak_bending_marker(source):
        records.append({**source, '_source': source_name})
    for key in ('checks', 'cases', 'directions'):
        raw = source.get(key)
        if isinstance(raw, list):
            for index, item in enumerate(raw, start=1):
                record = _record(item)
                if _strong_shear_weak_bending_marker(record):
                    records.append({**record, '_source': f'{source_name}.{key}[{index}]'})
    for key in (
        'strongShearWeakBending',
        'strongShearWeakFlexure',
        'strongShearWeakMoment',
        'shearBendingCapacityDesign',
        'capacityDesignShear',
    ):
        record = _record(source.get(key))
        if _strong_shear_weak_bending_marker(record):
            records.extend(_strong_shear_weak_bending_records(record, f'{source_name}.{key}'))
    for key in ('positive', 'negative', 'x', 'y'):
        record = _record(source.get(key))
        if _strong_shear_weak_bending_marker(record):
            records.append({**record, '_source': f'{source_name}.{key}'})
    return records


def _strong_shear_weak_bending_sources(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
) -> List[Dict[str, Any]]:
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    sources: List[Dict[str, Any]] = []
    for owner_name, owner in (
        ('element', element),
        ('metadata', metadata),
        ('elementContext', element_context),
        ('capacityData', _record(_record(context.get('capacityData')).get(elem_id))),
        ('memberCapacityData', _record(_record(context.get('memberCapacityData')).get(elem_id))),
        ('strongShearWeakBending', _record(_record(context.get('strongShearWeakBending')).get(elem_id))),
        ('capacityDesign', _record(_record(context.get('capacityDesign')).get(elem_id))),
    ):
        owner_record = _record(owner)
        sources.extend(_strong_shear_weak_bending_records(owner_record, owner_name))
        for key in (
            'strongShearWeakBending',
            'strongShearWeakFlexure',
            'strongShearWeakMoment',
            'shearBendingCapacityDesign',
            'capacityDesignShear',
            'capacityDesign',
            'seismicCapacity',
            'capacityCheck',
        ):
            nested = _record(owner_record.get(key))
            sources.extend(_strong_shear_weak_bending_records(nested, f'{owner_name}.{key}'))
    deduped: List[Dict[str, Any]] = []
    seen = set()
    for record in sources:
        signature = (
            str(record.get('_source') or ''),
            str(record.get('direction') or record.get('case') or record.get('name') or ''),
            str(record.get('bendingControlledShearDemandKN') or record.get('requiredShearCapacityKN') or record.get('shearDemandKN') or ''),
            str(record.get('shearCapacityKN') or record.get('providedShearCapacityKN') or record.get('VuKN') or ''),
        )
        if signature in seen:
            continue
        seen.add(signature)
        deduped.append(record)
    return deduped


def _strong_shear_weak_bending_subcheck(record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    source = str(record.get('_source') or 'structured')
    label = str(record.get('direction') or record.get('case') or record.get('name') or source)
    if _is_true(record.get('exempt')) or _is_true(record.get('notRequired')) or _is_true(record.get('strongShearWeakBendingExempt')):
        return {
            'name': label,
            'status': 'pass',
            'utilization': 0.0,
            'source': source,
            'message': str(record.get('exemptionReason') or record.get('reason') or 'Structured input marks this member as exempt from strong-shear weak-bending check.'),
        }

    utilization = _number_from_keys(record, (
        'strongShearWeakBendingUtilization',
        'shearBendingUtilization',
        'capacityDesignShearUtilization',
    ))
    if utilization is None and any(token in source.lower() for token in ('strongshearweak', 'shearbending', 'capacitydesignshear')):
        utilization = _number_from_keys(record, ('demandCapacityRatio', 'dcr', 'utilization'))
    if utilization is not None and utilization >= 0.0:
        return {
            'name': label,
            'status': 'pass' if utilization <= 1.0 else 'fail',
            'utilization': round(utilization, 4),
            'source': source,
            'providedUtilization': round(utilization, 6),
        }

    demand = _number_from_keys(record, (
        'bendingControlledShearDemandKN',
        'flexuralOverstrengthShearDemandKN',
        'strongShearDemandKN',
        'capacityDesignShearDemandKN',
        'seismicAdjustedShearDemandKN',
        'requiredShearCapacityKN',
        'requiredShearKN',
        'shearDemandKN',
        'VDemandKN',
        'VbKN',
        'VcKN',
    ))
    capacity = _number_from_keys(record, (
        'providedShearCapacityKN',
        'designShearCapacityKN',
        'shearDesignCapacityKN',
        'shearCapacityKN',
        'strongShearCapacityKN',
        'VuKN',
        'VCapacityKN',
    ))
    if demand is None or capacity is None or capacity <= 0.0:
        return None
    utilization = abs(demand) / max(capacity, 1e-12)
    return {
        'name': label,
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'source': source,
        'bendingControlledShearDemandKN': round(abs(demand), 6),
        'shearCapacityKN': round(capacity, 6),
    }


def _frame_member_strong_shear_weak_bending_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_beam_or_column(context, elem_id, element):
        return None
    sources = _strong_shear_weak_bending_sources(context, elem_id, element)
    if not sources:
        return None
    subchecks = [
        item for item in (_strong_shear_weak_bending_subcheck(source) for source in sources)
        if item is not None
    ]
    grade = _seismic_grade(context, elem_id, element)
    element_type = _element_type(context, elem_id, element)
    if not subchecks:
        return {
            'item': '框架构件强剪弱弯受剪承载力',
            'status': 'input_required',
            'category': 'input_required',
            'utilization': None,
            'clause': 'GB/T 50011-2010(2024) 6.2.4 + 6.2.5',
            'formula': 'Vu >= V_capacity_design from member flexural capacity using structured data',
            'inputs': {
                'elementId': elem_id,
                'elementType': element_type,
                'seismicGrade': grade,
                'sourceCount': len(sources),
            },
            'message': 'Structured strong-shear weak-bending data is present but does not include comparable shear demand/capacity or utilization.',
        }
    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架构件强剪弱弯受剪承载力',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.2.4 + 6.2.5',
        'formula': 'Vu >= V_capacity_design from member flexural capacity using structured data',
        'inputs': {
            'elementId': elem_id,
            'elementType': element_type,
            'seismicGrade': grade,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }
