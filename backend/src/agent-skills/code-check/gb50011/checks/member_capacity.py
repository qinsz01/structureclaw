"""Seismic combination member capacity checks (structured and vertical seismic)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _aggregate_check_status,
    _check_item,
    _element_context,
    _element_metadata,
    _material_strength_mpa,
    _number,
    _number_from_keys,
    _record,
    _section_modulus_mm3,
)
from .element_context import (
    _member_combination_action_entries,
)


def _structured_capacity_sources(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
) -> List[Dict[str, Any]]:
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    sources: List[Dict[str, Any]] = []
    direct_capacity_keys = {
        'axialCapacityKN',
        'maxAbsAxialCapacityKN',
        'compressionCapacityKN',
        'tensionCapacityKN',
        'nCapacityKN',
        'NuKN',
        'NCapacityKN',
        'shearCapacityKN',
        'maxAbsShearCapacityKN',
        'vCapacityKN',
        'VuKN',
        'VCapacityKN',
        'momentCapacityKNm',
        'maxAbsMomentCapacityKNm',
        'bendingCapacityKNm',
        'flexuralCapacityKNm',
        'mCapacityKNm',
        'MuKNm',
        'MCapacityKNm',
        'seismicCombinationUtilization',
        'seismicUtilization',
        'capacityUtilization',
        'demandCapacityRatio',
        'dcr',
        'dcRatio',
        'interaction',
    }
    nested_capacity_keys = {'axial', 'compression', 'tension', 'n', 'shear', 'v', 'moment', 'bending', 'flexural', 'm'}

    def has_capacity_marker(record: Dict[str, Any]) -> bool:
        if any(key in record for key in direct_capacity_keys):
            return True
        return any(_record(record.get(key)) for key in nested_capacity_keys)

    for owner_name, owner in (
        ('element', element),
        ('metadata', metadata),
        ('elementContext', element_context),
        ('capacityData', _record(_record(context.get('capacityData')).get(elem_id))),
        ('memberCapacityData', _record(_record(context.get('memberCapacityData')).get(elem_id))),
    ):
        direct = _record(owner)
        if direct and (owner_name in {'capacityData', 'memberCapacityData'} or has_capacity_marker(direct)):
            sources.append({**direct, '_source': owner_name})
        for key in (
            'seismicCapacity',
            'capacity',
            'capacities',
            'designCapacity',
            'designCapacities',
            'memberCapacity',
            'memberCapacities',
            'capacityCheck',
            'capacityChecks',
            'strengthCheck',
            'strengthChecks',
            'seismicCapacityCheck',
            'seismicCapacityChecks',
        ):
            raw = direct.get(key)
            record = _record(raw)
            if record:
                sources.append({**record, '_source': f'{owner_name}.{key}'})
                continue
            if isinstance(raw, list):
                for index, item in enumerate(raw, start=1):
                    item_record = _record(item)
                    if item_record:
                        sources.append({**item_record, '_source': f'{owner_name}.{key}[{index}]'})
    return sources


def _component_capacity_from_sources(
    sources: List[Dict[str, Any]],
    direct_keys: tuple[str, ...],
    nested_keys: tuple[str, ...],
    nested_capacity_keys: tuple[str, ...],
) -> Optional[Dict[str, Any]]:
    for source in sources:
        source_name = str(source.get('_source') or 'capacity')
        for key in direct_keys:
            value = _number(source.get(key))
            if value is not None and value > 0.0:
                return {'value': value, 'source': f'{source_name}.{key}'}
        for nested_key in nested_keys:
            nested = _record(source.get(nested_key))
            if not nested:
                continue
            for capacity_key in nested_capacity_keys:
                value = _number(nested.get(capacity_key))
                if value is not None and value > 0.0:
                    return {'value': value, 'source': f'{source_name}.{nested_key}.{capacity_key}'}
    return None


def _structured_capacity_utilization_from_sources(sources: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for source in sources:
        source_name = str(source.get('_source') or 'capacity')
        for key in (
            'seismicCombinationUtilization',
            'seismicUtilization',
            'capacityUtilization',
            'demandCapacityRatio',
            'dcr',
            'dcRatio',
            'interaction',
            'utilization',
        ):
            value = _number(source.get(key))
            if value is not None and value >= 0.0:
                return {'value': value, 'source': f'{source_name}.{key}'}
    return None


def _component_capacity_adjustment_from_sources(
    sources: List[Dict[str, Any]],
    nested_keys: tuple[str, ...],
) -> Optional[Dict[str, Any]]:
    adjustment_keys = (
        'gammaRE',
        'gammaRe',
        'seismicCapacityAdjustmentFactor',
        'capacityAdjustmentFactor',
    )
    for source in sources:
        source_name = str(source.get('_source') or 'capacity')
        for key in adjustment_keys:
            value = _number(source.get(key))
            if value is not None and value > 0.0:
                return {'value': value, 'source': f'{source_name}.{key}'}
        for nested_key in nested_keys:
            nested = _record(source.get(nested_key))
            if not nested:
                continue
            for key in adjustment_keys:
                value = _number(nested.get(key))
                if value is not None and value > 0.0:
                    return {'value': value, 'source': f'{source_name}.{nested_key}.{key}'}
    return None


def _structured_seismic_combination_member_capacity_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element:
        return None
    actions = _member_combination_action_entries(_record(context.get('analysisSummary')), elem_id)
    if not actions:
        return None
    capacity_sources = _structured_capacity_sources(context, elem_id, element)
    if not capacity_sources:
        return None

    axial_capacity = _component_capacity_from_sources(
        capacity_sources,
        ('axialCapacityKN', 'maxAbsAxialCapacityKN', 'compressionCapacityKN', 'tensionCapacityKN', 'nCapacityKN', 'NuKN', 'NCapacityKN'),
        ('axial', 'compression', 'tension', 'n'),
        ('capacityKN', 'designCapacityKN', 'capacity', 'designCapacity', 'NuKN'),
    )
    shear_capacity = _component_capacity_from_sources(
        capacity_sources,
        ('shearCapacityKN', 'maxAbsShearCapacityKN', 'vCapacityKN', 'VuKN', 'VCapacityKN'),
        ('shear', 'v'),
        ('capacityKN', 'designCapacityKN', 'capacity', 'designCapacity', 'VuKN'),
    )
    moment_capacity = _component_capacity_from_sources(
        capacity_sources,
        ('momentCapacityKNm', 'maxAbsMomentCapacityKNm', 'bendingCapacityKNm', 'flexuralCapacityKNm', 'mCapacityKNm', 'MuKNm', 'MCapacityKNm'),
        ('moment', 'bending', 'flexural', 'm'),
        ('capacityKNm', 'designCapacityKNm', 'capacity', 'designCapacity', 'MuKNm'),
    )
    axial_gamma = _component_capacity_adjustment_from_sources(capacity_sources, ('axial', 'compression', 'tension', 'n'))
    shear_gamma = _component_capacity_adjustment_from_sources(capacity_sources, ('shear', 'v'))
    moment_gamma = _component_capacity_adjustment_from_sources(capacity_sources, ('moment', 'bending', 'flexural', 'm'))
    explicit_utilization = _structured_capacity_utilization_from_sources(capacity_sources)

    subchecks: List[Dict[str, Any]] = []
    if explicit_utilization is not None:
        utilization = float(explicit_utilization['value'])
        subchecks.append({
            'name': 'member_structured_capacity_utilization',
            'status': 'pass' if utilization <= 1.0 else 'fail',
            'utilization': round(utilization, 4),
            'demand': round(utilization, 6),
            'limit': 1.0,
            'case': None,
            'source': explicit_utilization.get('source'),
            'formula': 'provided member seismic capacity utilization <= 1.0',
        })

    component_specs = (
        ('axial', 'maxAbsAxialKN', axial_capacity, axial_gamma, 'N/Nu <= 1.0'),
        ('shear', 'maxAbsShearKN', shear_capacity, shear_gamma, 'V/Vu <= 1.0'),
        ('moment', 'maxAbsMomentKNm', moment_capacity, moment_gamma, 'M/Mu <= 1.0'),
    )
    for action in actions:
        case_name = action.get('case')
        for component_name, demand_key, capacity_info, gamma_info, formula in component_specs:
            if capacity_info is None:
                continue
            demand = _number(action.get(demand_key))
            if demand is None:
                continue
            capacity = float(capacity_info['value'])
            gamma_re = float(gamma_info['value']) if gamma_info is not None else 1.0
            utilization = abs(demand) * gamma_re / max(capacity, 1e-12)
            subchecks.append({
                'name': f'member_{component_name}_capacity',
                'status': 'pass' if utilization <= 1.0 else 'fail',
                'utilization': round(utilization, 4),
                'demand': round(abs(demand), 6),
                'capacity': round(capacity, 6),
                **({'gammaRE': round(gamma_re, 6)} if gamma_info is not None else {}),
                **({'adjustedCapacity': round(capacity / gamma_re, 6)} if gamma_info is not None else {}),
                **({'gammaRESource': gamma_info.get('source')} if gamma_info is not None else {}),
                'case': case_name,
                'source': capacity_info.get('source'),
                'formula': f'gammaRE * {formula}' if gamma_info is not None else formula,
            })

    if not subchecks:
        return None
    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '抗震组合构件承载力',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB 55002-2021 + GB/T 50011-2010(2024) 5.4.1 + 5.4.2 + 6.2',
        'formula': 'structured seismic combination member force effect satisfies S <= R/gammaRE when gammaRE is provided',
        'inputs': {
            'elementId': elem_id,
            'actionCount': len(actions),
            'capacitySources': [
                str(source.get('_source'))
                for source in capacity_sources
                if str(source.get('_source') or '').strip()
            ],
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }


def _member_force_entries_from_map(member_forces: Dict[str, Any]) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    for elem_id, raw_force in member_forces.items():
        force = _record(raw_force)
        if not force:
            continue
        entries.append({
            **force,
            'elementId': str(elem_id),
        })
    return entries


def _vertical_member_capacity_records(elem: Dict[str, Any]) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []

    def append_records(raw: Any, source_name: str) -> None:
        if isinstance(raw, list):
            for index, item in enumerate(raw, start=1):
                append_records(item, f'{source_name}[{index}]')
            return
        record = _record(raw)
        if not record:
            return
        records.append({**record, '_source': source_name})
        for key in ('cases', 'checks', 'directions'):
            append_records(record.get(key), f'{source_name}.{key}')
        for key in ('capacity', 'capacityCheck', 'memberCapacity', 'memberCapacityCheck'):
            append_records(record.get(key), f'{source_name}.{key}')

    for key in (
        'verticalSeismicCapacity',
        'verticalSeismicCapacityCheck',
        'verticalSeismicMemberCapacity',
        'verticalMemberCapacity',
        'verticalCapacity',
        'verticalSeismic',
    ):
        append_records(elem.get(key), key)

    return records


def _vertical_member_explicit_capacity_result(
    elem: Dict[str, Any],
    force: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    subchecks: List[Dict[str, Any]] = []
    for record in _vertical_member_capacity_records(elem):
        source = str(record.get('_source') or 'verticalSeismicCapacity')
        label = str(record.get('case') or record.get('name') or record.get('direction') or source)
        utilization = _number_from_keys(record, (
            'verticalSeismicCapacityUtilization',
            'verticalCapacityUtilization',
            'capacityUtilization',
            'demandCapacityRatio',
            'dcr',
            'utilization',
        ))
        if utilization is not None and utilization >= 0.0:
            subchecks.append({
                'name': label,
                'source': source,
                'method': 'provided_vertical_capacity_utilization',
                'interaction': utilization,
                'axialRatio': 0.0,
                'momentRatio': 0.0,
                'verticalRatio': utilization,
            })
            continue

        vertical_demand = _number_from_keys(record, (
            'verticalSeismicDemandKN',
            'verticalDemandKN',
            'maxAbsVerticalDemandKN',
            'demandKN',
        ))
        vertical_capacity = _number_from_keys(record, (
            'verticalSeismicCapacityKN',
            'verticalCapacityKN',
            'capacityKN',
        ))
        if vertical_demand is not None and vertical_capacity is not None and vertical_capacity > 0.0:
            gamma_info = _component_capacity_adjustment_from_sources([record], ('vertical', 'verticalSeismic', 'capacity'))
            gamma_re = float(gamma_info['value']) if gamma_info is not None else 1.0
            vertical_ratio = abs(vertical_demand) * gamma_re / max(vertical_capacity, 1e-12)
            subchecks.append({
                'name': label,
                'source': source,
                'method': 'provided_vertical_demand_capacity',
                'interaction': vertical_ratio,
                'axialRatio': 0.0,
                'momentRatio': 0.0,
                'verticalRatio': vertical_ratio,
                'verticalDemandKN': abs(vertical_demand),
                'verticalCapacityKN': vertical_capacity,
                **({'gammaRE': gamma_re} if gamma_info is not None else {}),
                **({'gammaRESource': gamma_info.get('source')} if gamma_info is not None else {}),
                **({'verticalAdjustedCapacityKN': vertical_capacity / gamma_re} if gamma_info is not None else {}),
            })
            continue

        axial_capacity = _number_from_keys(record, (
            'axialCapacityKN',
            'designAxialCapacityKN',
            'compressionCapacityKN',
            'NuKN',
        ))
        moment_capacity = _number_from_keys(record, (
            'momentCapacityKNm',
            'designMomentCapacityKNm',
            'MuKNm',
        ))
        if axial_capacity is None and moment_capacity is None:
            continue
        axial_gamma = _component_capacity_adjustment_from_sources([record], ('axial', 'compression', 'n'))
        moment_gamma = _component_capacity_adjustment_from_sources([record], ('moment', 'bending', 'flexural', 'm'))
        axial_gamma_re = float(axial_gamma['value']) if axial_gamma is not None else 1.0
        moment_gamma_re = float(moment_gamma['value']) if moment_gamma is not None else 1.0
        axial = _number_from_keys(record, ('axialDemandKN', 'verticalAxialDemandKN')) or _number(force.get('maxAbsAxialKN')) or 0.0
        moment = _number_from_keys(record, ('momentDemandKNm', 'verticalMomentDemandKNm')) or _number(force.get('maxAbsMomentKNm')) or 0.0
        axial_ratio = abs(axial) * axial_gamma_re / max(axial_capacity, 1e-12) if axial_capacity is not None and axial_capacity > 0.0 else 0.0
        moment_ratio = abs(moment) * moment_gamma_re / max(moment_capacity, 1e-12) if moment_capacity is not None and moment_capacity > 0.0 else 0.0
        subchecks.append({
            'name': label,
            'source': source,
            'method': 'provided_vertical_member_capacity',
            'interaction': axial_ratio + moment_ratio,
            'axialRatio': axial_ratio,
            'momentRatio': moment_ratio,
            'verticalRatio': 0.0,
            'axialDemandKN': abs(axial),
            'momentDemandKNm': abs(moment),
            'axialCapacityKN': axial_capacity,
            'momentCapacityKNm': moment_capacity,
            **({'axialGammaRE': axial_gamma_re} if axial_gamma is not None and axial_capacity is not None else {}),
            **({'axialGammaRESource': axial_gamma.get('source')} if axial_gamma is not None and axial_capacity is not None else {}),
            **({'axialAdjustedCapacityKN': axial_capacity / axial_gamma_re} if axial_gamma is not None and axial_capacity is not None else {}),
            **({'momentGammaRE': moment_gamma_re} if moment_gamma is not None and moment_capacity is not None else {}),
            **({'momentGammaRESource': moment_gamma.get('source')} if moment_gamma is not None and moment_capacity is not None else {}),
            **({'momentAdjustedCapacityKNm': moment_capacity / moment_gamma_re} if moment_gamma is not None and moment_capacity is not None else {}),
        })

    if not subchecks:
        return None
    controlling = max(subchecks, key=lambda item: float(item.get('interaction', 0.0)))
    return {
        'elementId': str(force.get('elementId') or ''),
        'case': force.get('case') or controlling.get('name'),
        'interaction': float(controlling.get('interaction', 0.0)),
        'axialRatio': float(controlling.get('axialRatio', 0.0)),
        'momentRatio': float(controlling.get('momentRatio', 0.0)),
        'verticalRatio': float(controlling.get('verticalRatio', 0.0)),
        'axialDemandKN': float(controlling.get('axialDemandKN', _number(force.get('maxAbsAxialKN')) or 0.0)),
        'shearDemandKN': float(_number(force.get('maxAbsShearKN')) or 0.0),
        'momentDemandKNm': float(controlling.get('momentDemandKNm', _number(force.get('maxAbsMomentKNm')) or 0.0)),
        'axialCapacityKN': controlling.get('axialCapacityKN'),
        'momentCapacityKNm': controlling.get('momentCapacityKNm'),
        'verticalDemandKN': controlling.get('verticalDemandKN'),
        'verticalCapacityKN': controlling.get('verticalCapacityKN'),
        'gammaRE': controlling.get('gammaRE'),
        'gammaRESource': controlling.get('gammaRESource'),
        'verticalAdjustedCapacityKN': controlling.get('verticalAdjustedCapacityKN'),
        'axialGammaRE': controlling.get('axialGammaRE'),
        'axialGammaRESource': controlling.get('axialGammaRESource'),
        'axialAdjustedCapacityKN': controlling.get('axialAdjustedCapacityKN'),
        'momentGammaRE': controlling.get('momentGammaRE'),
        'momentGammaRESource': controlling.get('momentGammaRESource'),
        'momentAdjustedCapacityKNm': controlling.get('momentAdjustedCapacityKNm'),
        'source': controlling.get('source'),
        'method': controlling.get('method'),
        'subchecks': subchecks,
    }


def _member_capacity_screening_item(
    *,
    item_name: str,
    force_entries: List[Dict[str, Any]],
    element_data: Dict[str, Any],
    clause: str,
    formula: str,
    unavailable_message: str,
) -> Dict[str, Any]:
    results: List[Dict[str, Any]] = []
    max_interaction = -1.0
    controlling: Dict[str, Any] = {}
    unavailable: List[str] = []

    for force in force_entries:
        elem_id = str(force.get('elementId') or '')
        if not elem_id:
            continue
        elem = _record(element_data.get(elem_id)) if isinstance(element_data, dict) else {}
        explicit_capacity_result = (
            _vertical_member_explicit_capacity_result(elem, force)
            if item_name == '竖向地震构件承载力' else None
        )
        if explicit_capacity_result is not None:
            results.append(explicit_capacity_result)
            interaction = float(explicit_capacity_result.get('interaction', 0.0))
            if interaction > max_interaction:
                max_interaction = interaction
                controlling = explicit_capacity_result
            continue
        section = _record(elem.get('section'))
        material = _record(elem.get('material'))
        area = _number(section.get('A'))
        strength = _material_strength_mpa(material)
        section_modulus = _section_modulus_mm3(section)
        axial = _number(force.get('maxAbsAxialKN')) or 0.0
        moment = _number(force.get('maxAbsMomentKNm')) or 0.0
        shear = _number(force.get('maxAbsShearKN')) or 0.0
        if area is None or area <= 0.0 or strength is None or strength <= 0.0:
            unavailable.append(elem_id)
            continue
        axial_capacity = 0.9 * strength * area / 1000.0
        axial_ratio = axial / max(axial_capacity, 1e-12)
        moment_ratio = 0.0
        moment_capacity = None
        if section_modulus is not None and section_modulus > 0.0:
            moment_capacity = 0.35 * strength * section_modulus / 1e6
            moment_ratio = moment / max(moment_capacity, 1e-12)
        interaction = axial_ratio + moment_ratio
        item = {
            'elementId': elem_id,
            'case': force.get('case'),
            'interaction': interaction,
            'axialRatio': axial_ratio,
            'momentRatio': moment_ratio,
            'axialDemandKN': axial,
            'shearDemandKN': shear,
            'momentDemandKNm': moment,
            'axialCapacityKN': axial_capacity,
            'momentCapacityKNm': moment_capacity,
        }
        results.append(item)
        if interaction > max_interaction:
            max_interaction = interaction
            controlling = item

    if not results:
        suffix = f": {', '.join(unavailable[:6])}" if unavailable else '.'
        return _check_item(
            item_name,
            demand=None,
            capacity=None,
            clause=clause,
            formula='member force effects have matching section and material capacity data',
            unavailable_message=f"{unavailable_message}{suffix}",
        )

    utilization = max_interaction
    return {
        'item': item_name,
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'clause': clause,
        'formula': formula,
        'inputs': {
            'checkedMemberCount': len(results),
            'unavailableMemberCount': len(unavailable),
            'controllingElement': controlling.get('elementId'),
            'controllingCase': controlling.get('case'),
            'axialRatio': round(float(controlling.get('axialRatio', 0.0)), 6),
            'momentRatio': round(float(controlling.get('momentRatio', 0.0)), 6),
            'axialDemandKN': round(float(controlling.get('axialDemandKN', 0.0)), 6),
            'shearDemandKN': round(float(controlling.get('shearDemandKN', 0.0)), 6),
            'momentDemandKNm': round(float(controlling.get('momentDemandKNm', 0.0)), 6),
            'axialCapacityKN': (
                round(float(controlling['axialCapacityKN']), 6)
                if controlling.get('axialCapacityKN') is not None else None
            ),
            'momentCapacityKNm': (
                round(float(controlling['momentCapacityKNm']), 6)
                if controlling.get('momentCapacityKNm') is not None else None
            ),
            'verticalRatio': round(float(controlling.get('verticalRatio', 0.0)), 6),
            'verticalDemandKN': (
                round(float(controlling['verticalDemandKN']), 6)
                if controlling.get('verticalDemandKN') is not None else None
            ),
            'verticalCapacityKN': (
                round(float(controlling['verticalCapacityKN']), 6)
                if controlling.get('verticalCapacityKN') is not None else None
            ),
            'gammaRE': (
                round(float(controlling['gammaRE']), 6)
                if controlling.get('gammaRE') is not None else None
            ),
            'gammaRESource': controlling.get('gammaRESource'),
            'verticalAdjustedCapacityKN': (
                round(float(controlling['verticalAdjustedCapacityKN']), 6)
                if controlling.get('verticalAdjustedCapacityKN') is not None else None
            ),
            'axialGammaRE': (
                round(float(controlling['axialGammaRE']), 6)
                if controlling.get('axialGammaRE') is not None else None
            ),
            'axialGammaRESource': controlling.get('axialGammaRESource'),
            'axialAdjustedCapacityKN': (
                round(float(controlling['axialAdjustedCapacityKN']), 6)
                if controlling.get('axialAdjustedCapacityKN') is not None else None
            ),
            'momentGammaRE': (
                round(float(controlling['momentGammaRE']), 6)
                if controlling.get('momentGammaRE') is not None else None
            ),
            'momentGammaRESource': controlling.get('momentGammaRESource'),
            'momentAdjustedCapacityKNm': (
                round(float(controlling['momentAdjustedCapacityKNm']), 6)
                if controlling.get('momentAdjustedCapacityKNm') is not None else None
            ),
            'capacitySource': controlling.get('source'),
            'capacityMethod': controlling.get('method') or 'section_material_screening',
            'subchecks': controlling.get('subchecks', []),
        },
    }


def _vertical_member_capacity_items(vertical_seismic: Dict[str, Any], element_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    static_check = _record(vertical_seismic.get('openSeesStatic'))
    member_forces = static_check.get('memberForces')
    if not isinstance(member_forces, dict) or not member_forces:
        return []
    return [_member_capacity_screening_item(
        item_name='竖向地震构件承载力',
        force_entries=_member_force_entries_from_map(member_forces),
        element_data=element_data,
        clause='GB 55002-2021 + GB/T 50011-2010(2024) 5.4.2',
        formula='N/Nu + M/Mu <= 1.0 using vertical seismic member end-force envelope; explicit S/R checks apply S <= R/gammaRE when gammaRE is provided',
        unavailable_message='Vertical member capacity data is unavailable for all checked members',
    )]
