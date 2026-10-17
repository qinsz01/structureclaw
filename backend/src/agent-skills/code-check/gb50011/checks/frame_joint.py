"""Frame joint checks: core stirrups, core shear capacity, strong column / weak beam."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _aggregate_check_status,
    _element_context,
    _element_metadata,
    _element_type,
    _is_concrete_frame_joint,
    _is_true,
    _number,
    _number_from_keys,
    _ratio_percent_from_sources,
    _record,
)
from .constants import (
    FRAME_JOINT_CORE_CHARACTERISTIC_MINIMUMS,
    FRAME_JOINT_CORE_VOLUME_RATIO_MINIMUMS,
)
from .element_context import (
    _column_shear_span_ratio_info,
    _seismic_grade,
)
from .reinforcement import (
    _column_longitudinal_reinforcement_group,
    _dimension_from_keys_mm,
    _dimension_mm,
    _reinforcement_data,
    _reinforcement_diameter_mm,
    _reinforcement_group,
)


def _frame_joint_core_group(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
    reinforcement: Dict[str, Any],
) -> Dict[str, Any]:
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    sources = (
        _record(reinforcement.get('jointCore')),
        _record(reinforcement.get('jointCoreStirrup')),
        _record(reinforcement.get('jointCoreStirrups')),
        _record(reinforcement.get('coreJoint')),
        _record(reinforcement.get('beamColumnJoint')),
        _record(element.get('jointCore')),
        _record(element.get('jointCoreStirrup')),
        _record(element.get('joint')),
        _record(element.get('jointData')),
        _record(metadata.get('jointCore')),
        _record(metadata.get('jointData')),
        _record(element_context.get('jointCore')),
        _record(element_context.get('jointData')),
        _record(_record(context.get('jointData')).get(elem_id)),
        _record(_record(context.get('frameJointData')).get(elem_id)),
    )
    for source in sources:
        if source:
            stirrup = _reinforcement_group(
                source,
                'stirrup',
                'stirrups',
                'hoop',
                'hoops',
                'coreStirrup',
                'coreStirrups',
                'jointCoreStirrup',
                'jointCoreStirrups',
            )
            return stirrup or source
    return {}


def _joint_core_volume_ratio_percent(joint_core: Dict[str, Any], reinforcement: Dict[str, Any]) -> Optional[float]:
    return _ratio_percent_from_sources(
        (joint_core, reinforcement),
        (
            'volumeRatioPercent',
            'volumetricRatioPercent',
            'rhoVPercent',
            'coreVolumeRatioPercent',
            'jointCoreVolumeRatioPercent',
        ),
        (
            'volumeRatio',
            'volumetricRatio',
            'rhoV',
            'coreVolumeRatio',
            'jointCoreVolumeRatio',
        ),
    )


def _joint_core_characteristic_value(joint_core: Dict[str, Any], reinforcement: Dict[str, Any]) -> Optional[float]:
    for source in (joint_core, reinforcement):
        for key in (
            'characteristicValue',
            'stirrupCharacteristicValue',
            'coreCharacteristicValue',
            'jointCoreCharacteristicValue',
            'lambdaV',
            'lambdaNv',
        ):
            value = _number(source.get(key))
            if value is not None and value > 0.0:
                return value
    return None


def _joint_core_adjacent_column_volume_ratio_percent(joint_core: Dict[str, Any], reinforcement: Dict[str, Any]) -> Optional[float]:
    for source in (joint_core, reinforcement):
        explicit = _ratio_percent_from_sources(
            (source,),
            (
                'adjacentColumnEndMaxVolumeRatioPercent',
                'columnEndMaxVolumeRatioPercent',
                'upperLowerColumnEndMaxVolumeRatioPercent',
            ),
            (
                'adjacentColumnEndMaxVolumeRatio',
                'columnEndMaxVolumeRatio',
                'upperLowerColumnEndMaxVolumeRatio',
            ),
        )
        if explicit is not None:
            return explicit

        upper = _ratio_percent_from_sources(
            (source,),
            ('upperColumnEndVolumeRatioPercent',),
            ('upperColumnEndVolumeRatio',),
        )
        lower = _ratio_percent_from_sources(
            (source,),
            ('lowerColumnEndVolumeRatioPercent',),
            ('lowerColumnEndVolumeRatio',),
        )
        values = [value for value in (upper, lower) if value is not None]
        if values:
            return max(values)
    return None


def _joint_core_shear_demand_capacity(
    joint_core: Dict[str, Any],
    reinforcement: Dict[str, Any],
    element: Dict[str, Any],
) -> Dict[str, Optional[float]]:
    sources = (joint_core, reinforcement, element)
    demand = None
    capacity = None
    utilization = None
    for source in sources:
        if demand is None:
            for key in ('shearDemandKN', 'jointCoreShearDemandKN', 'coreShearDemandKN', 'VjKN', 'demandKN'):
                value = _number(source.get(key))
                if value is not None and value >= 0.0:
                    demand = value
                    break
        if capacity is None:
            for key in ('shearCapacityKN', 'jointCoreShearCapacityKN', 'coreShearCapacityKN', 'VjCapacityKN', 'capacityKN'):
                value = _number(source.get(key))
                if value is not None and value > 0.0:
                    capacity = value
                    break
        if utilization is None:
            for key in ('shearUtilization', 'jointCoreShearUtilization', 'utilization', 'demandCapacityRatio'):
                value = _number(source.get(key))
                if value is not None and value >= 0.0:
                    utilization = value
                    break
    return {
        'demandKN': demand,
        'capacityKN': capacity,
        'utilization': utilization,
    }


def _frame_joint_core_stirrup_detailing_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_joint(context, elem_id, element):
        return None

    reinforcement = _reinforcement_data(element)
    joint_core = _frame_joint_core_group(context, elem_id, element, reinforcement)
    if not joint_core:
        return None

    grade = _seismic_grade(context, elem_id, element)
    if grade is None:
        return None

    longitudinal = _column_longitudinal_reinforcement_group(reinforcement)
    spacing = _dimension_from_keys_mm(
        joint_core,
        'spacingMm',
        'maxSpacingMm',
        'coreSpacingMm',
        'jointCoreSpacingMm',
        'spacing',
        'maxSpacing',
        'coreSpacing',
        'jointCoreSpacing',
        's',
    )
    diameter = _reinforcement_diameter_mm(joint_core)
    longitudinal_min_diameter = (
        _dimension_from_keys_mm(joint_core, 'longitudinalMinDiameterMm', 'columnLongitudinalMinDiameterMm')
        or _dimension_mm(longitudinal.get('minDiameterMm'))
        or _dimension_mm(longitudinal.get('minimumDiameterMm'))
        or _reinforcement_diameter_mm(longitudinal)
    )
    characteristic = _joint_core_characteristic_value(joint_core, reinforcement)
    volume_ratio = _joint_core_volume_ratio_percent(joint_core, reinforcement)
    adjacent_column_volume_ratio = _joint_core_adjacent_column_volume_ratio_percent(joint_core, reinforcement)
    shear_info = _column_shear_span_ratio_info(context, elem_id, element)
    shear_ratio = _number(shear_info.get('ratio')) if shear_info else None
    if shear_ratio is None:
        for key in ('shearSpanRatio', 'columnShearSpanRatio', 'adjacentColumnShearSpanRatio'):
            shear_ratio = _number(joint_core.get(key))
            if shear_ratio is not None and shear_ratio > 0.0:
                break

    if spacing is None and diameter is None and characteristic is None and volume_ratio is None:
        return None

    subchecks: List[Dict[str, Any]] = []
    spacing_limit = None
    spacing_basis: List[str] = []
    if spacing is not None:
        if longitudinal_min_diameter is not None:
            multiplier = 6.0 if grade == 1 else 8.0
            spacing_limit = multiplier * longitudinal_min_diameter
            spacing_basis.append(f'{int(multiplier)}d')
        code_spacing_limit = 100.0 if grade in {1, 2} else 150.0
        spacing_limit = min(spacing_limit, code_spacing_limit) if spacing_limit is not None else code_spacing_limit
        spacing_basis.append(f'{int(code_spacing_limit)}mm')
        if shear_ratio is not None and shear_ratio <= 2.0:
            spacing_limit = min(spacing_limit, 100.0)
            spacing_basis.append('shear-span ratio <= 2: 100mm')
        spacing_utilization = spacing / max(spacing_limit, 1e-12)
        subchecks.append({
            'name': 'joint_core_stirrup_spacing',
            'status': 'pass' if spacing_utilization <= 1.0 else 'fail',
            'utilization': round(spacing_utilization, 4),
            'demand': round(spacing, 6),
            'limit': round(spacing_limit, 6),
            'formula': 'joint-core stirrup spacing follows GB/T 50011 6.3.7 column confined-zone limit',
            'basis': spacing_basis,
        })

    if diameter is not None:
        diameter_limit = {1: 10.0, 2: 8.0, 3: 8.0, 4: 6.0}[grade]
        if grade == 4 and shear_ratio is not None and shear_ratio <= 2.0:
            diameter_limit = 8.0
        diameter_utilization = diameter_limit / max(diameter, 1e-12)
        subchecks.append({
            'name': 'joint_core_stirrup_diameter',
            'status': 'pass' if diameter_utilization <= 1.0 else 'fail',
            'utilization': round(diameter_utilization, 4),
            'demand': round(diameter, 6),
            'limit': round(diameter_limit, 6),
            'formula': 'joint-core stirrup diameter follows GB/T 50011 6.3.7 column confined-zone limit',
        })

    characteristic_minimum = FRAME_JOINT_CORE_CHARACTERISTIC_MINIMUMS.get(grade)
    if characteristic is not None and characteristic_minimum is not None:
        characteristic_utilization = characteristic_minimum / max(characteristic, 1e-12)
        subchecks.append({
            'name': 'joint_core_stirrup_characteristic_value',
            'status': 'pass' if characteristic_utilization <= 1.0 else 'fail',
            'utilization': round(characteristic_utilization, 4),
            'demand': round(characteristic, 6),
            'limit': characteristic_minimum,
            'formula': 'joint-core stirrup characteristic value >= grade minimum',
        })

    volume_ratio_minimum = FRAME_JOINT_CORE_VOLUME_RATIO_MINIMUMS.get(grade)
    if volume_ratio is not None and volume_ratio_minimum is not None:
        volume_utilization = volume_ratio_minimum / max(volume_ratio, 1e-12)
        subchecks.append({
            'name': 'joint_core_stirrup_volume_ratio',
            'status': 'pass' if volume_utilization <= 1.0 else 'fail',
            'utilization': round(volume_utilization, 4),
            'demand': round(volume_ratio, 6),
            'limit': volume_ratio_minimum,
            'formula': 'joint-core volumetric stirrup ratio >= grade minimum',
        })

    if shear_ratio is not None and shear_ratio <= 2.0 and volume_ratio is not None and adjacent_column_volume_ratio is not None:
        adjacent_utilization = adjacent_column_volume_ratio / max(volume_ratio, 1e-12)
        subchecks.append({
            'name': 'joint_core_short_column_volume_ratio',
            'status': 'pass' if adjacent_utilization <= 1.0 else 'fail',
            'utilization': round(adjacent_utilization, 4),
            'demand': round(volume_ratio, 6),
            'limit': round(adjacent_column_volume_ratio, 6),
            'formula': 'short-column joint-core volumetric ratio >= max upper/lower column-end volumetric ratio',
        })

    if not subchecks:
        return None

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架节点核芯区箍筋构造',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.3.10',
        'formula': 'joint-core stirrup spacing/diameter follow 6.3.7; lambda_v and rho_v satisfy grade minimums; short-column joint core rho_v >= adjacent column-end rho_v',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'stirrupSpacingMm': round(spacing, 6) if spacing is not None else None,
            'stirrupDiameterMm': round(diameter, 6) if diameter is not None else None,
            'longitudinalMinDiameterMm': round(longitudinal_min_diameter, 6) if longitudinal_min_diameter is not None else None,
            'characteristicValue': round(characteristic, 6) if characteristic is not None else None,
            'volumeRatioPercent': round(volume_ratio, 6) if volume_ratio is not None else None,
            'adjacentColumnEndMaxVolumeRatioPercent': round(adjacent_column_volume_ratio, 6) if adjacent_column_volume_ratio is not None else None,
            'shearSpanRatio': round(shear_ratio, 6) if shear_ratio is not None else None,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }


def _frame_joint_core_shear_capacity_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_joint(context, elem_id, element):
        return None

    reinforcement = _reinforcement_data(element)
    joint_core = _frame_joint_core_group(context, elem_id, element, reinforcement)
    element_type = _element_type(context, elem_id, element)
    if not joint_core and element_type in {'joint', 'frame-joint', 'beam-column-joint', 'rc-joint', 'core-joint'}:
        joint_core = element
    if not joint_core:
        return None

    grade = _seismic_grade(context, elem_id, element)
    if grade is None:
        return None

    shear = _joint_core_shear_demand_capacity(joint_core, reinforcement, element)
    demand = shear.get('demandKN')
    capacity = shear.get('capacityKN')
    utilization = shear.get('utilization')
    has_capacity_check = (
        utilization is not None
        or (demand is not None and capacity is not None and capacity > 0.0)
    )
    required = grade in {1, 2}
    if not has_capacity_check and not required:
        return None

    if not has_capacity_check:
        return {
            'item': '框架节点核芯区截面抗震验算',
            'status': 'input_required',
            'category': 'input_required',
            'utilization': None,
            'clause': 'GB/T 50011-2010(2024) 6.2.15 + Appendix D',
            'formula': 'Grade 1/2 frame joint cores require seismic shear-capacity verification by Appendix D',
            'inputs': {
                'elementId': elem_id,
                'seismicGrade': grade,
                'required': required,
                'shearDemandKN': None,
                'shearCapacityKN': None,
                'utilization': None,
            },
            'message': 'Structured joint-core shear demand/capacity or utilization is unavailable.',
        }

    if utilization is None:
        utilization = float(demand or 0.0) / max(float(capacity or 0.0), 1e-12)
    return {
        'item': '框架节点核芯区截面抗震验算',
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(float(utilization), 4),
        'clause': 'GB/T 50011-2010(2024) 6.2.15 + Appendix D',
        'formula': 'joint-core seismic shear demand/capacity <= 1.0 by Appendix D verification result',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'required': required,
            'shearDemandKN': round(float(demand), 6) if demand is not None else None,
            'shearCapacityKN': round(float(capacity), 6) if capacity is not None else None,
            'utilization': round(float(utilization), 6),
            'verificationSource': joint_core.get('verificationSource') or joint_core.get('source') or 'structured jointCore data',
        },
    }


def _strong_column_weak_beam_marker(source: Dict[str, Any]) -> bool:
    marker_keys = {
        'strongColumnWeakBeam',
        'strongColumnWeakBeamCheck',
        'columnBeamMomentCheck',
        'columnBeamMomentRatio',
        'requiredColumnBeamMomentRatio',
        'strongColumnWeakBeamRatio',
        'requiredStrongColumnWeakBeamRatio',
        'sumColumnMomentCapacityToBeamMomentCapacity',
        'sumColumnMomentCapacityKNm',
        'sumBeamMomentCapacityKNm',
        'etaC',
        'momentAmplificationFactor',
        'columnMomentAmplificationFactor',
        'capacityDesign',
        'momentCapacityDesign',
        'jointMomentCapacityDesign',
    }
    if any(key in source for key in marker_keys):
        return True
    for key in ('directions', 'checks', 'cases', 'loadCases', 'clockwise', 'counterClockwise', 'positive', 'negative'):
        raw = source.get(key)
        if isinstance(raw, list) and any(_strong_column_weak_beam_marker(_record(item)) for item in raw if isinstance(item, dict)):
            return True
        nested = _record(raw)
        if nested and _strong_column_weak_beam_marker(nested):
            return True
    return False


def _strong_column_weak_beam_records(source: Dict[str, Any], source_name: str) -> List[Dict[str, Any]]:
    if not source:
        return []
    records: List[Dict[str, Any]] = []
    if _strong_column_weak_beam_marker(source):
        records.append({**source, '_source': source_name})
    for key in ('directions', 'checks', 'cases', 'loadCases'):
        raw = source.get(key)
        if isinstance(raw, list):
            for index, item in enumerate(raw, start=1):
                record = _record(item)
                if _strong_column_weak_beam_marker(record):
                    records.append({**record, '_source': f'{source_name}.{key}[{index}]'})
    for key in (
        'strongColumnWeakBeam',
        'strongColumnWeakBeamCheck',
        'columnBeamMomentCheck',
        'momentCapacityDesign',
        'jointMomentCapacityDesign',
    ):
        record = _record(source.get(key))
        if _strong_column_weak_beam_marker(record):
            records.extend(_strong_column_weak_beam_records(record, f'{source_name}.{key}'))
    for key in ('clockwise', 'counterClockwise', 'positive', 'negative', 'x', 'y'):
        record = _record(source.get(key))
        if _strong_column_weak_beam_marker(record):
            records.append({**record, '_source': f'{source_name}.{key}'})
    return records


def _strong_column_weak_beam_sources(
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
        ('jointData', _record(_record(context.get('jointData')).get(elem_id))),
        ('strongColumnWeakBeam', _record(_record(context.get('strongColumnWeakBeam')).get(elem_id))),
        ('capacityDesign', _record(_record(context.get('capacityDesign')).get(elem_id))),
        ('jointCapacityDesign', _record(_record(context.get('jointCapacityDesign')).get(elem_id))),
    ):
        owner_record = _record(owner)
        sources.extend(_strong_column_weak_beam_records(owner_record, owner_name))
        for key in (
            'strongColumnWeakBeam',
            'strongColumnWeakBeamCheck',
            'columnBeamMomentCheck',
            'capacityDesign',
            'momentCapacityDesign',
            'jointMomentCapacityDesign',
        ):
            nested = _record(owner_record.get(key))
            sources.extend(_strong_column_weak_beam_records(nested, f'{owner_name}.{key}'))
    deduped: List[Dict[str, Any]] = []
    seen = set()
    for record in sources:
        signature = (
            str(record.get('_source') or ''),
            str(record.get('direction') or record.get('case') or record.get('name') or ''),
            str(record.get('columnBeamMomentRatio') or record.get('strongColumnWeakBeamRatio') or ''),
            str(record.get('sumColumnMomentCapacityKNm') or ''),
            str(record.get('sumBeamMomentCapacityKNm') or ''),
        )
        if signature in seen:
            continue
        seen.add(signature)
        deduped.append(record)
    return deduped


def _strong_column_weak_beam_subcheck(record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    source = str(record.get('_source') or 'structured')
    label = str(record.get('direction') or record.get('case') or record.get('name') or source)
    if _is_true(record.get('exempt')) or _is_true(record.get('notRequired')) or _is_true(record.get('strongColumnWeakBeamExempt')):
        return {
            'name': label,
            'status': 'pass',
            'utilization': 0.0,
            'source': source,
            'message': str(record.get('exemptionReason') or record.get('reason') or 'Structured input marks this joint as exempt from strong-column weak-beam check.'),
        }

    utilization = _number_from_keys(record, (
        'strongColumnWeakBeamUtilization',
        'columnBeamMomentUtilization',
        'momentCapacityUtilization',
    ))
    if utilization is None and any(token in source.lower() for token in ('strongcolumnweakbeam', 'strong_column_weak_beam', 'columnbeammoment', 'capacitydesign', 'momentcapacitydesign')):
        utilization = _number_from_keys(record, ('demandCapacityRatio', 'dcr', 'utilization'))
    if utilization is not None and utilization >= 0.0:
        return {
            'name': label,
            'status': 'pass' if utilization <= 1.0 else 'fail',
            'utilization': round(utilization, 4),
            'source': source,
            'providedUtilization': round(utilization, 6),
        }

    ratio = _number_from_keys(record, (
        'columnBeamMomentRatio',
        'strongColumnWeakBeamRatio',
        'sumColumnMomentCapacityToBeamMomentCapacity',
        'columnToBeamMomentCapacityRatio',
        'columnBeamCapacityRatio',
    ))
    required_ratio = _number_from_keys(record, (
        'requiredColumnBeamMomentRatio',
        'requiredStrongColumnWeakBeamRatio',
        'requiredRatio',
        'minimumRatio',
        'etaC',
        'momentAmplificationFactor',
        'columnMomentAmplificationFactor',
    ))
    column_moment = _number_from_keys(record, (
        'sumColumnMomentCapacityKNm',
        'columnMomentCapacityKNm',
        'sumColumnFlexuralCapacityKNm',
        'columnFlexuralCapacityKNm',
        'McKNm',
        'McuKNm',
    ))
    beam_moment = _number_from_keys(record, (
        'sumBeamMomentCapacityKNm',
        'beamMomentCapacityKNm',
        'sumBeamFlexuralCapacityKNm',
        'beamFlexuralCapacityKNm',
        'MbKNm',
        'MbuKNm',
    ))
    if ratio is None and column_moment is not None and beam_moment is not None and beam_moment > 0.0:
        ratio = column_moment / beam_moment
    if ratio is None or required_ratio is None or required_ratio <= 0.0:
        return None
    utilization = required_ratio / max(ratio, 1e-12)
    return {
        'name': label,
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'source': source,
        'columnBeamMomentRatio': round(ratio, 6),
        'requiredColumnBeamMomentRatio': round(required_ratio, 6),
        'sumColumnMomentCapacityKNm': round(column_moment, 6) if column_moment is not None else None,
        'sumBeamMomentCapacityKNm': round(beam_moment, 6) if beam_moment is not None else None,
    }


def _frame_joint_strong_column_weak_beam_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_concrete_frame_joint(context, elem_id, element):
        return None
    sources = _strong_column_weak_beam_sources(context, elem_id, element)
    if not sources:
        return None
    subchecks = [
        item for item in (_strong_column_weak_beam_subcheck(source) for source in sources)
        if item is not None
    ]
    grade = _seismic_grade(context, elem_id, element)
    if not subchecks:
        return {
            'item': '框架节点强柱弱梁弯矩关系',
            'status': 'input_required',
            'category': 'input_required',
            'utilization': None,
            'clause': 'GB/T 50011-2010(2024) 6.2.2',
            'formula': 'ΣMc >= ηc * ΣMb using structured joint moment-capacity data',
            'inputs': {
                'elementId': elem_id,
                'seismicGrade': grade,
                'sourceCount': len(sources),
            },
            'message': 'Structured strong-column weak-beam data is present but does not include a comparable utilization, required ratio, or column/beam moment-capacity pair.',
        }
    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '框架节点强柱弱梁弯矩关系',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.2.2',
        'formula': 'ΣMc >= ηc * ΣMb using structured joint moment-capacity data',
        'inputs': {
            'elementId': elem_id,
            'seismicGrade': grade,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }
