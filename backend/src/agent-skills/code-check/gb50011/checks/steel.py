"""Steel member seismic detailing checks."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _aggregate_check_status,
    _element_context,
    _element_metadata,
    _is_steel_member,
    _number,
    _number_from_keys,
    _record,
)


STEEL_SEISMIC_DETAILING_MARKER_KEYS = {
    'slendernessRatio',
    'memberSlendernessRatio',
    'slendernessLimit',
    'memberSlendernessLimit',
    'braceSlendernessRatio',
    'braceSlendernessLimit',
    'widthThicknessRatio',
    'widthThicknessLimit',
    'flangeWidthThicknessRatio',
    'flangeWidthThicknessLimit',
    'webHeightThicknessRatio',
    'webHeightThicknessLimit',
    'plateWidthThicknessRatio',
    'plateWidthThicknessLimit',
    'seismicDetailingUtilization',
    'widthThicknessUtilization',
}


def _steel_seismic_detailing_sources(
    context: Dict[str, Any],
    elem_id: str,
    element: Dict[str, Any],
) -> List[Dict[str, Any]]:
    section = _record(element.get('section'))
    metadata = _element_metadata(context, elem_id, element)
    element_context = _element_context(context, elem_id)
    sources: List[Dict[str, Any]] = []

    def add_record(raw: Any, source_name: str) -> None:
        record = _record(raw)
        if record:
            sources.append({**record, '_source': source_name})
            return
        if isinstance(raw, list):
            for index, item in enumerate(raw, start=1):
                item_record = _record(item)
                if item_record:
                    sources.append({**item_record, '_source': f'{source_name}[{index}]'})

    def add_direct_if_marked(record: Dict[str, Any], source_name: str) -> None:
        if any(key in record for key in STEEL_SEISMIC_DETAILING_MARKER_KEYS):
            sources.append({**record, '_source': source_name})

    add_direct_if_marked(element, f'elementData.{elem_id}')
    add_direct_if_marked(section, f'elementData.{elem_id}.section')
    add_direct_if_marked(metadata, f'elementData.{elem_id}.metadata')
    add_direct_if_marked(element_context, f'elementContextById.{elem_id}')
    for owner_name, owner in (
        (f'elementData.{elem_id}', element),
        (f'elementData.{elem_id}.section', section),
        (f'elementData.{elem_id}.metadata', metadata),
        (f'elementContextById.{elem_id}', element_context),
    ):
        for key in (
            'steelSeismicDetailing',
            'steelDetailing',
            'steelSeismicChecks',
            'seismicDetailing',
            'seismicDetailingChecks',
            'detailing',
            'detailingChecks',
            'widthThickness',
            'slenderness',
        ):
            add_record(owner.get(key), f'{owner_name}.{key}')
    return sources


def _steel_detailing_number_info(
    sources: List[Dict[str, Any]],
    keys: tuple[str, ...],
) -> Optional[Dict[str, Any]]:
    for source in sources:
        source_name = str(source.get('_source') or 'steelSeismicDetailing')
        for key in keys:
            value = _number(source.get(key))
            if value is not None and value >= 0.0:
                return {'value': value, 'source': f'{source_name}.{key}'}
    return None


def _steel_detailing_subcheck_from_pair(
    name: str,
    actual_info: Optional[Dict[str, Any]],
    limit_info: Optional[Dict[str, Any]],
    formula: str,
) -> Optional[Dict[str, Any]]:
    if actual_info is None and limit_info is None:
        return None
    actual = float(actual_info['value']) if actual_info is not None else None
    limit = float(limit_info['value']) if limit_info is not None else None
    if actual is None or limit is None or limit <= 0.0:
        return {
            'name': name,
            'status': 'input_required',
            'category': 'input_required',
            'utilization': None,
            'actual': round(actual, 6) if actual is not None else None,
            'limit': round(limit, 6) if limit is not None else None,
            'actualSource': actual_info.get('source') if actual_info is not None else None,
            'limitSource': limit_info.get('source') if limit_info is not None else None,
            'formula': formula,
            'message': 'Structured steel seismic detailing check is present but missing comparable actual value or code-derived limit.',
        }
    utilization = actual / max(limit, 1e-12)
    return {
        'name': name,
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'actual': round(actual, 6),
        'limit': round(limit, 6),
        'actualSource': actual_info.get('source') if actual_info is not None else None,
        'limitSource': limit_info.get('source') if limit_info is not None else None,
        'formula': formula,
    }


def _explicit_steel_detailing_subcheck(source: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    name = str(source.get('name') or source.get('item') or source.get('check') or '').strip()
    actual = _number_from_keys(source, ('actual', 'value', 'demand', 'ratio', 'actualRatio'))
    limit = _number_from_keys(source, ('limit', 'capacity', 'allowable', 'maximum', 'max', 'limitRatio'))
    utilization = _number_from_keys(source, ('utilization', 'demandCapacityRatio', 'dcr'))
    if not name or (actual is None and limit is None and utilization is None):
        return None
    if utilization is None and actual is not None and limit is not None and limit > 0.0:
        utilization = actual / limit
    status_text = str(source.get('status') or '').strip().lower()
    if utilization is not None:
        status = 'pass' if utilization <= 1.0 else 'fail'
    elif status_text in {'pass', 'passed', 'ok', 'satisfied'}:
        status = 'pass'
        utilization = 0.0
    elif status_text in {'fail', 'failed', 'ng', 'not_satisfied'}:
        status = 'fail'
        utilization = 9999.0
    else:
        status = 'not_applicable'
        utilization = 9999.0
    return {
        'name': name,
        'status': status,
        'utilization': round(float(utilization), 4),
        'actual': round(actual, 6) if actual is not None else None,
        'limit': round(limit, 6) if limit is not None else None,
        'source': source.get('_source'),
        'formula': str(source.get('formula') or 'provided steel seismic detailing utilization <= 1.0'),
    }


def _steel_member_seismic_detailing_item(
    elem_id: str,
    context: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    element = _record(_record(context.get('elementData')).get(elem_id))
    if not element or not _is_steel_member(context, elem_id, element):
        return None
    sources = _steel_seismic_detailing_sources(context, elem_id, element)
    if not sources:
        return None

    specs = (
        (
            'member_slenderness_ratio',
            ('memberSlendernessRatio', 'slendernessRatio', 'lambdaRatio', 'lambda'),
            ('memberSlendernessLimit', 'slendernessLimit', 'lambdaRatioLimit', 'lambdaLimit'),
            'member slenderness ratio <= structured code-derived limit',
        ),
        (
            'brace_slenderness_ratio',
            ('braceSlendernessRatio', 'bracingSlendernessRatio'),
            ('braceSlendernessLimit', 'bracingSlendernessLimit'),
            'brace slenderness ratio <= structured code-derived limit',
        ),
        (
            'flange_width_thickness_ratio',
            ('flangeWidthThicknessRatio', 'flangeWidthToThicknessRatio', 'flangeBToTRatio', 'flangeBtRatio'),
            ('flangeWidthThicknessLimit', 'flangeWidthToThicknessLimit', 'flangeBToTLimit', 'flangeBtLimit'),
            'flange width-thickness ratio <= structured code-derived limit',
        ),
        (
            'web_height_thickness_ratio',
            ('webHeightThicknessRatio', 'webHeightToThicknessRatio', 'webHToTRatio', 'webHtRatio'),
            ('webHeightThicknessLimit', 'webHeightToThicknessLimit', 'webHToTLimit', 'webHtLimit'),
            'web height-thickness ratio <= structured code-derived limit',
        ),
        (
            'plate_width_thickness_ratio',
            ('plateWidthThicknessRatio', 'widthThicknessRatio', 'widthToThicknessRatio', 'bToTRatio'),
            ('plateWidthThicknessLimit', 'widthThicknessLimit', 'widthToThicknessLimit', 'bToTLimit'),
            'plate width-thickness ratio <= structured code-derived limit',
        ),
    )
    subchecks: List[Dict[str, Any]] = []
    for name, actual_keys, limit_keys, formula in specs:
        subcheck = _steel_detailing_subcheck_from_pair(
            name,
            _steel_detailing_number_info(sources, actual_keys),
            _steel_detailing_number_info(sources, limit_keys),
            formula,
        )
        if subcheck is not None:
            subchecks.append(subcheck)
    for source in sources:
        explicit = _explicit_steel_detailing_subcheck(source)
        if explicit is not None:
            subchecks.append(explicit)

    if not subchecks:
        return {
            'item': '钢构件抗震构造限值',
            'status': 'input_required',
            'category': 'input_required',
            'utilization': None,
            'clause': 'GB/T 50011-2010(2024) 8.3 + 8.4',
            'formula': 'structured steel seismic detailing actual values are checked against project/code-derived limits',
            'inputs': {
                'elementId': elem_id,
                'sourcePaths': [
                    str(source.get('_source'))
                    for source in sources
                    if str(source.get('_source') or '').strip()
                ],
            },
            'message': 'Structured steel seismic detailing data is present but does not include comparable actual values and code-derived limits.',
        }

    controlling = max(subchecks, key=lambda item: float(item.get('utilization') or 0.0))
    status = _aggregate_check_status(subchecks)
    return {
        'item': '钢构件抗震构造限值',
        'status': status,
        'utilization': float(controlling.get('utilization') or 0.0),
        'clause': 'GB/T 50011-2010(2024) 8.3 + 8.4',
        'formula': 'structured steel seismic detailing actual values are checked against project/code-derived limits',
        'inputs': {
            'elementId': elem_id,
            'sourcePaths': [
                str(source.get('_source'))
                for source in sources
                if str(source.get('_source') or '').strip()
            ],
            'controlling': controlling,
            'subchecks': subchecks,
        },
    }
