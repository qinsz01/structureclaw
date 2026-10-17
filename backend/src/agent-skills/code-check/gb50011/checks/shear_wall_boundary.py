"""Shear wall boundary element checks."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _aggregate_check_status,
    _element_context,
    _element_metadata,
    _is_concrete_shear_wall,
    _number,
    _optional_bool_from_sources,
    _ratio_percent_from_sources,
    _record,
)
from .reinforcement import (
    _dimension_from_keys_mm,
    _dimension_mm,
    _reinforcement_area_mm2,
    _reinforcement_data,
    _reinforcement_diameter_mm,
    _reinforcement_group,
)
from .shear_wall import (
    _shear_wall_detailing_group,
    _wall_dimension_from_sources,
)


def _wall_boundary_records(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
    reinforcement: Dict[str, Any],
    wall: Dict[str, Any],
) -> List[Dict[str, Any]]:
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    sources = (wall, reinforcement, element, metadata, element_context)
    list_keys = (
        'boundaryElements',
        'edgeMembers',
        'boundaryMembers',
        'boundaryElementList',
        'edgeMemberList',
    )
    record_keys = (
        'boundaryElement',
        'edgeMember',
        'boundaryMember',
        'constrainedBoundaryElement',
        'edgeReinforcement',
        'boundaryReinforcement',
        'leftBoundaryElement',
        'rightBoundaryElement',
        'leftEdgeMember',
        'rightEdgeMember',
    )

    records: List[Dict[str, Any]] = []
    for source in sources:
        for key in list_keys:
            value = source.get(key)
            if isinstance(value, list):
                for index, raw_record in enumerate(value):
                    record = _record(raw_record)
                    if record:
                        records.append({
                            **record,
                            '_source': record.get('source') or f'{key}[{index}]',
                        })
        for key in record_keys:
            record = _record(source.get(key))
            if record:
                records.append({
                    **record,
                    '_source': record.get('source') or key,
                })
    return records


def _wall_boundary_required(
    wall: Dict[str, Any],
    element: Dict[str, Any],
    metadata: Dict[str, Any],
    element_context: Dict[str, Any],
) -> bool:
    return bool(_optional_bool_from_sources(
        (wall, element, metadata, element_context),
        (
            'requiresBoundaryElement',
            'boundaryElementRequired',
            'requiresEdgeMember',
            'edgeMemberRequired',
            'hasBoundaryElement',
            'hasEdgeMember',
            'constrainedBoundaryElementRequired',
        ),
    ))


def _wall_boundary_ratio_percent(
    boundary: Dict[str, Any],
    wall: Dict[str, Any],
    thickness_mm: Optional[float],
) -> Optional[float]:
    longitudinal = _reinforcement_group(
        boundary,
        'longitudinal',
        'longitudinalReinforcement',
        'vertical',
        'verticalReinforcement',
        'bars',
    )
    ratio = _ratio_percent_from_sources(
        (longitudinal, boundary),
        (
            'longitudinalRatioPercent',
            'longitudinalReinforcementRatioPercent',
            'verticalRatioPercent',
            'verticalReinforcementRatioPercent',
            'reinforcementRatioPercent',
            'ratioPercent',
        ),
        (
            'longitudinalRatio',
            'longitudinalReinforcementRatio',
            'verticalRatio',
            'verticalReinforcementRatio',
            'reinforcementRatio',
            'ratio',
        ),
    )
    if ratio is not None:
        return ratio

    area = _reinforcement_area_mm2(longitudinal) or _reinforcement_area_mm2(boundary)
    boundary_length = _dimension_from_keys_mm(
        boundary,
        'lengthMm',
        'boundaryLengthMm',
        'edgeLengthMm',
        'memberLengthMm',
        'length',
        'boundaryLength',
        'edgeLength',
        'memberLength',
    )
    if area is None or boundary_length is None or thickness_mm is None:
        return None
    return area / max(boundary_length * thickness_mm, 1e-12) * 100.0


def _wall_boundary_ratio_limit_percent(boundary: Dict[str, Any], wall: Dict[str, Any]) -> Optional[float]:
    return _ratio_percent_from_sources(
        (boundary, wall),
        (
            'minLongitudinalRatioPercent',
            'requiredLongitudinalRatioPercent',
            'longitudinalRatioLimitPercent',
            'minBoundaryLongitudinalRatioPercent',
            'boundaryLongitudinalRatioLimitPercent',
        ),
        (
            'minLongitudinalRatio',
            'requiredLongitudinalRatio',
            'longitudinalRatioLimit',
            'minBoundaryLongitudinalRatio',
            'boundaryLongitudinalRatioLimit',
        ),
    )


def _wall_boundary_transverse_group(boundary: Dict[str, Any]) -> Dict[str, Any]:
    return _reinforcement_group(
        boundary,
        'hoop',
        'hoops',
        'stirrup',
        'stirrups',
        'tie',
        'ties',
        'transverse',
        'transverseReinforcement',
    )


def _first_wall_boundary_dimension(
    sources: tuple[Dict[str, Any], ...],
    *keys: str,
) -> Optional[float]:
    for source in sources:
        for key in keys:
            if key.lower().endswith('mm'):
                value = _number(source.get(key))
                if value is not None and value > 0.0:
                    return value
                continue
            value = _dimension_mm(source.get(key))
            if value is not None:
                return value
    return None


def _first_wall_boundary_ratio_percent(
    sources: tuple[Dict[str, Any], ...],
    percent_keys: tuple[str, ...],
    ratio_keys: tuple[str, ...],
) -> Optional[float]:
    for source in sources:
        value = _ratio_percent_from_sources((source,), percent_keys, ratio_keys)
        if value is not None:
            return value
    return None


def _shear_wall_boundary_element_item(
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
    required = _wall_boundary_required(wall, element, metadata, element_context)
    boundaries = _wall_boundary_records(context, elem_id, element, reinforcement, wall)
    if not boundaries:
        if required:
            return {
                'item': '抗震墙边缘构件构造',
                'status': 'input_required',
                'category': 'input_required',
                'utilization': None,
                'clause': 'GB/T 50011-2010(2024) 6.4',
                'formula': 'required seismic-wall boundary-element detailing should provide structured longitudinal and transverse checks',
                'inputs': {
                    'elementId': elem_id,
                    'required': required,
                    'boundaryElementCount': 0,
                },
                'message': 'Structured seismic-wall boundary-element reinforcement data is unavailable.',
            }
        return None

    subchecks: List[Dict[str, Any]] = []
    for index, boundary in enumerate(boundaries):
        label = str(boundary.get('id') or boundary.get('name') or boundary.get('_source') or f'boundary-{index + 1}')
        longitudinal = _reinforcement_group(
            boundary,
            'longitudinal',
            'longitudinalReinforcement',
            'vertical',
            'verticalReinforcement',
            'bars',
        )
        transverse = _wall_boundary_transverse_group(boundary)
        sources = (boundary, longitudinal, transverse, wall)

        ratio = _wall_boundary_ratio_percent(boundary, wall, thickness)
        ratio_limit = _wall_boundary_ratio_limit_percent(boundary, wall)
        if ratio is not None and ratio_limit is not None:
            utilization = ratio_limit / max(ratio, 1e-12)
            subchecks.append({
                'name': 'wall_boundary_longitudinal_reinforcement_ratio',
                'boundary': label,
                'status': 'pass' if utilization <= 1.0 else 'fail',
                'utilization': round(utilization, 4),
                'demand': round(ratio, 6),
                'limit': round(ratio_limit, 6),
                'formula': 'boundary longitudinal reinforcement ratio >= structured code-derived limit',
            })

        longitudinal_diameter = _reinforcement_diameter_mm(longitudinal) or _reinforcement_diameter_mm(boundary)
        longitudinal_diameter_limit = _first_wall_boundary_dimension(
            (boundary, longitudinal, wall),
            'minLongitudinalDiameterMm',
            'requiredLongitudinalDiameterMm',
            'longitudinalDiameterLimitMm',
            'boundaryLongitudinalDiameterLimitMm',
            'minLongitudinalDiameter',
            'requiredLongitudinalDiameter',
            'longitudinalDiameterLimit',
        )
        if longitudinal_diameter is not None and longitudinal_diameter_limit is not None:
            utilization = longitudinal_diameter_limit / max(longitudinal_diameter, 1e-12)
            subchecks.append({
                'name': 'wall_boundary_longitudinal_bar_diameter',
                'boundary': label,
                'status': 'pass' if utilization <= 1.0 else 'fail',
                'utilization': round(utilization, 4),
                'demand': round(longitudinal_diameter, 6),
                'limit': round(longitudinal_diameter_limit, 6),
                'formula': 'boundary longitudinal bar diameter >= structured code-derived limit',
            })

        transverse_spacing = _first_wall_boundary_dimension(
            (transverse, boundary),
            'spacingMm',
            'hoopSpacingMm',
            'tieSpacingMm',
            'transverseSpacingMm',
            'spacing',
            'hoopSpacing',
            'tieSpacing',
            'transverseSpacing',
            's',
        )
        transverse_spacing_limit = _first_wall_boundary_dimension(
            sources,
            'maxHoopSpacingMm',
            'maxTieSpacingMm',
            'maxTransverseSpacingMm',
            'hoopSpacingLimitMm',
            'tieSpacingLimitMm',
            'transverseSpacingLimitMm',
            'maxHoopSpacing',
            'maxTieSpacing',
            'maxTransverseSpacing',
            'hoopSpacingLimit',
            'tieSpacingLimit',
            'transverseSpacingLimit',
        )
        if transverse_spacing is not None and transverse_spacing_limit is not None:
            utilization = transverse_spacing / max(transverse_spacing_limit, 1e-12)
            subchecks.append({
                'name': 'wall_boundary_transverse_spacing',
                'boundary': label,
                'status': 'pass' if utilization <= 1.0 else 'fail',
                'utilization': round(utilization, 4),
                'demand': round(transverse_spacing, 6),
                'limit': round(transverse_spacing_limit, 6),
                'formula': 'boundary transverse reinforcement spacing <= structured code-derived limit',
            })

        transverse_diameter = _reinforcement_diameter_mm(transverse)
        transverse_diameter_limit = _first_wall_boundary_dimension(
            sources,
            'minHoopDiameterMm',
            'minTieDiameterMm',
            'minTransverseDiameterMm',
            'hoopDiameterLimitMm',
            'tieDiameterLimitMm',
            'transverseDiameterLimitMm',
            'minHoopDiameter',
            'minTieDiameter',
            'minTransverseDiameter',
            'hoopDiameterLimit',
            'tieDiameterLimit',
            'transverseDiameterLimit',
        )
        if transverse_diameter is not None and transverse_diameter_limit is not None:
            utilization = transverse_diameter_limit / max(transverse_diameter, 1e-12)
            subchecks.append({
                'name': 'wall_boundary_transverse_diameter',
                'boundary': label,
                'status': 'pass' if utilization <= 1.0 else 'fail',
                'utilization': round(utilization, 4),
                'demand': round(transverse_diameter, 6),
                'limit': round(transverse_diameter_limit, 6),
                'formula': 'boundary transverse reinforcement diameter >= structured code-derived limit',
            })

        volume_ratio = _first_wall_boundary_ratio_percent(
            (transverse, boundary),
            (
                'volumeRatioPercent',
                'volumetricRatioPercent',
                'hoopVolumeRatioPercent',
                'transverseVolumeRatioPercent',
            ),
            (
                'volumeRatio',
                'volumetricRatio',
                'hoopVolumeRatio',
                'transverseVolumeRatio',
            ),
        )
        volume_ratio_limit = _first_wall_boundary_ratio_percent(
            sources,
            (
                'minVolumeRatioPercent',
                'minVolumetricRatioPercent',
                'minHoopVolumeRatioPercent',
                'transverseVolumeRatioLimitPercent',
            ),
            (
                'minVolumeRatio',
                'minVolumetricRatio',
                'minHoopVolumeRatio',
                'transverseVolumeRatioLimit',
            ),
        )
        if volume_ratio is not None and volume_ratio_limit is not None:
            utilization = volume_ratio_limit / max(volume_ratio, 1e-12)
            subchecks.append({
                'name': 'wall_boundary_transverse_volume_ratio',
                'boundary': label,
                'status': 'pass' if utilization <= 1.0 else 'fail',
                'utilization': round(utilization, 4),
                'demand': round(volume_ratio, 6),
                'limit': round(volume_ratio_limit, 6),
                'formula': 'boundary transverse reinforcement volumetric ratio >= structured code-derived limit',
            })

    if not subchecks:
        if required:
            return {
                'item': '抗震墙边缘构件构造',
                'status': 'input_required',
                'category': 'input_required',
                'utilization': None,
                'clause': 'GB/T 50011-2010(2024) 6.4',
                'formula': 'required seismic-wall boundary-element detailing should provide comparable structured limits',
                'inputs': {
                    'elementId': elem_id,
                    'required': required,
                    'boundaryElementCount': len(boundaries),
                },
                'message': 'Structured boundary-element data does not include comparable actual values and code-derived limits.',
            }
        return None

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '抗震墙边缘构件构造',
        'status': _aggregate_check_status(subchecks),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 6.4',
        'formula': 'boundary-element longitudinal and transverse reinforcement satisfy structured code-derived limits',
        'inputs': {
            'elementId': elem_id,
            'required': required,
            'boundaryElementCount': len(boundaries),
            'thicknessMm': round(thickness, 6) if thickness is not None else None,
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }
