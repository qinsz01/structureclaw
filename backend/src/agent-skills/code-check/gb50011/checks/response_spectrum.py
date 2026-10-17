"""Modal participation, long-period spectrum and story minimum seismic shear checks."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _aggregate_check_status,
    _check_item,
    _first_number_from_records,
    _number,
    _optional_bool_from_sources,
    _record,
)
from .constants import (
    STORY_MINIMUM_SHEAR_COEFFICIENT_HIGH_ACCELERATION,
    STORY_MINIMUM_SHEAR_COEFFICIENT_LONG_PERIOD,
    STORY_MINIMUM_SHEAR_COEFFICIENT_SHORT_PERIOD,
)


def _modal_mass_participation_item(summary: Dict[str, Any], envelope: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    ratio = _number(summary.get('modalMassParticipationRatio'))
    if ratio is None:
        ratio = _number(envelope.get('modalMassParticipationRatio'))
    if ratio is None:
        return None
    utilization = 0.90 / max(ratio, 1e-12)
    return {
        'item': '振型参与质量系数',
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 5.2.2',
        'formula': 'ΣMeff / M >= 0.90',
        'inputs': {
            'demand': round(ratio, 8),
            'capacity': 0.90,
            'limit': 0.90,
        },
    }


def _response_spectrum_long_period_special_study_item(analysis_summary: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    response_spectrum = _record(analysis_summary.get('responseSpectrum'))
    assessment = _record(analysis_summary.get('periodRangeAssessment'))
    if not assessment:
        assessment = _record(response_spectrum.get('periodRangeAssessment'))
    if not assessment:
        return None
    requires_special_study = assessment.get('requiresSpecialStudy') is True
    max_period = _number(assessment.get('maxModePeriodSec'))
    period_limit = _number(assessment.get('maxCodeSpectrumPeriodSec'))
    if period_limit is None or period_limit <= 0.0:
        period_limit = 6.0
    advisory = _record(response_spectrum.get('longPeriodSpecialStudyAdvisory'))
    governing_mode = _record(advisory.get('governingMode'))
    utilization = (max_period / period_limit) if max_period is not None and period_limit > 0.0 else (9999.0 if requires_special_study else 0.0)
    passed = not requires_special_study
    return {
        'item': '反应谱长周期专项研究',
        'status': 'pass' if passed else 'fail',
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 5.1.5',
        'formula': 'max(T_mode) <= normal code response-spectrum period range before final response-spectrum compliance',
        'inputs': {
            'requiresSpecialStudy': requires_special_study,
            'maxModePeriodSec': round(max_period, 8) if max_period is not None else None,
            'maxCodeSpectrumPeriodSec': round(period_limit, 8),
            'advisoryStatus': advisory.get('status'),
            'governingMode': governing_mode or None,
        },
        **({} if passed else {
            'message': 'A project-specific long-period special study is required; the advisory spectrum trace is not a substitute for final compliance.',
        }),
    }


def _site_seismic_record(design_basis: Dict[str, Any]) -> Dict[str, Any]:
    return _record(design_basis.get('siteSeismic'))


def _design_basic_acceleration_g(design_basis: Dict[str, Any]) -> Optional[float]:
    site = _site_seismic_record(design_basis)
    site_extra = _record(site.get('extra'))
    zonation = _record(design_basis.get('groundMotionZonation'))
    return _first_number_from_records((
        site,
        site_extra,
        design_basis,
        zonation,
    ), (
        'designBasicAccelerationG',
        'basicAccelerationG',
        'accelerationG',
        'acceleration_g',
    ))


def _design_intensity(design_basis: Dict[str, Any]) -> Optional[int]:
    site = _site_seismic_record(design_basis)
    zonation = _record(design_basis.get('groundMotionZonation'))
    raw = _first_number_from_records((
        site,
        design_basis,
        zonation,
    ), (
        'intensity',
        'seismicIntensity',
        'fortificationIntensity',
    ))
    if raw is None:
        return None
    rounded = int(round(raw))
    return rounded if rounded in STORY_MINIMUM_SHEAR_COEFFICIENT_SHORT_PERIOD else None


def _story_minimum_shear_coefficient_rows(
    intensity: int,
    acceleration_g: Optional[float],
) -> Optional[tuple[float, float, str]]:
    if intensity not in STORY_MINIMUM_SHEAR_COEFFICIENT_SHORT_PERIOD:
        return None
    if intensity in STORY_MINIMUM_SHEAR_COEFFICIENT_HIGH_ACCELERATION:
        threshold = 0.15 if intensity == 7 else 0.30
        if acceleration_g is None or acceleration_g >= threshold - 1e-9:
            short, long = STORY_MINIMUM_SHEAR_COEFFICIENT_HIGH_ACCELERATION[intensity]
            return short, long, f'{intensity}度高设计基本地震加速度档'
    return (
        STORY_MINIMUM_SHEAR_COEFFICIENT_SHORT_PERIOD[intensity],
        STORY_MINIMUM_SHEAR_COEFFICIENT_LONG_PERIOD[intensity],
        f'{intensity}度标准设计基本地震加速度档',
    )


def _fundamental_period(
    analysis_summary: Dict[str, Any],
    summary: Dict[str, Any],
    envelope: Dict[str, Any],
) -> tuple[Optional[float], Optional[str]]:
    response_spectrum = _record(analysis_summary.get('responseSpectrum'))
    response_envelope = _record(response_spectrum.get('envelope'))
    direct = _first_number_from_records((
        summary,
        envelope,
        analysis_summary,
        response_spectrum,
        response_envelope,
    ), (
        'fundamentalPeriod',
        'fundamentalPeriodS',
        'fundamentalPeriodSec',
        'firstModePeriod',
        'firstModePeriodS',
    ))
    if direct is not None and direct > 0.0:
        return direct, 'summary'

    modal = _record(analysis_summary.get('modal'))
    modes = modal.get('modes')
    if isinstance(modes, list):
        sorted_modes = sorted(
            [_record(mode) for mode in modes if isinstance(mode, dict)],
            key=lambda item: _number(item.get('modeNumber')) or 9999.0,
        )
        for mode in sorted_modes:
            period = _first_number_from_records((mode,), (
                'period',
                'periodS',
                'periodSec',
            ))
            if period is not None and period > 0.0:
                return period, 'modal.modes[0]'
    return None, None


def _has_significant_torsion(
    design_basis: Dict[str, Any],
    regularity_assessment: Dict[str, Any],
    summary: Dict[str, Any],
    envelope: Dict[str, Any],
) -> Optional[bool]:
    regularity_summary = _record(regularity_assessment.get('summary'))
    return _optional_bool_from_sources((
        design_basis,
        _record(design_basis.get('regularity')),
        regularity_assessment,
        regularity_summary,
        summary,
        envelope,
    ), (
        'hasSignificantTorsion',
        'significantTorsion',
        'torsionEffectSignificant',
        'obviousTorsionalEffect',
        'torsionEffectObvious',
    ))


def _story_minimum_shear_base_limit(
    analysis_summary: Dict[str, Any],
    design_basis: Dict[str, Any],
    summary: Dict[str, Any],
    envelope: Dict[str, Any],
    regularity_assessment: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    intensity = _design_intensity(design_basis)
    if intensity is None:
        return None
    acceleration_g = _design_basic_acceleration_g(design_basis)
    rows = _story_minimum_shear_coefficient_rows(intensity, acceleration_g)
    if rows is None:
        return None
    short_limit, long_limit, acceleration_band = rows
    period, period_source = _fundamental_period(analysis_summary, summary, envelope)
    has_torsion = _has_significant_torsion(design_basis, regularity_assessment, summary, envelope)
    if has_torsion is True:
        limit = short_limit
        basis = 'significant_torsion'
    elif period is None:
        limit = short_limit
        basis = 'missing_period_conservative_short_period'
        period_source = None
    elif period <= 3.5:
        limit = short_limit
        basis = 'period_le_3_5s'
    elif period >= 5.0:
        limit = long_limit
        basis = 'period_ge_5_0s'
    else:
        ratio = (period - 3.5) / 1.5
        limit = short_limit + (long_limit - short_limit) * ratio
        basis = 'period_linear_interpolation_3_5s_to_5_0s'
    return {
        'limit': limit,
        'shortPeriodLimit': short_limit,
        'longPeriodLimit': long_limit,
        'intensity': intensity,
        'designBasicAccelerationG': acceleration_g,
        'accelerationBand': acceleration_band,
        'fundamentalPeriod': period,
        'periodSource': period_source,
        'hasSignificantTorsion': has_torsion,
        'basis': basis,
    }


def _story_label(row: Dict[str, Any], index: int) -> str:
    for key in ('story', 'storyId', 'storyName', 'floor', 'floorId', 'level'):
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value)
    return f'S{index}'


def _story_shear_weight_ratio_from_row(row: Dict[str, Any]) -> Optional[float]:
    ratio = _first_number_from_records((row,), (
        'shearWeightRatio',
        'storyShearWeightRatio',
        'storyShearCoefficient',
        'seismicShearCoefficient',
        'minimumShearCoefficient',
        'ratio',
    ))
    if ratio is not None:
        return ratio if ratio >= 0.0 else None
    story_shear = _first_number_from_records((row,), (
        'storyShearKN',
        'cumulativeStoryShearKN',
        'cumulativeShearKN',
        'floorShearKN',
        'seismicShearKN',
    ))
    cumulative_weight = _first_number_from_records((row,), (
        'cumulativeWeightKN',
        'weightAboveKN',
        'gravityLoadAboveKN',
        'representativeGravityLoadKN',
    ))
    if story_shear is None or cumulative_weight is None or cumulative_weight <= 0.0:
        return None
    return abs(story_shear) / cumulative_weight


def _story_shear_weight_entries_from_rows(
    rows: Any,
    *,
    direction: Optional[str],
    source: str,
) -> List[Dict[str, Any]]:
    if not isinstance(rows, list):
        return []
    entries: List[Dict[str, Any]] = []
    for index, raw_row in enumerate(rows, start=1):
        row = _record(raw_row)
        if not row and _number(raw_row) is None:
            continue
        ratio = _story_shear_weight_ratio_from_row(row) if row else _number(raw_row)
        if ratio is None or ratio < 0.0:
            continue
        weak_story = _optional_bool_from_sources((row,), (
            'isWeakStory',
            'weakStory',
            'isWeakLayer',
            'weakLayer',
        ))
        entries.append({
            'story': _story_label(row, index) if row else f'S{index}',
            'direction': direction or row.get('direction') or row.get('axis'),
            'ratio': ratio,
            'source': source,
            'isWeakStory': weak_story,
            'minimumShearAdjusted': bool(row.get('minimumShearAdjusted')) if row else False,
            'minimumShearAdjustmentFactor': _first_number_from_records((row,), (
                'minimumShearAdjustmentFactor',
                'minimumStoryShearAdjustmentFactor',
                'adjustmentFactor',
            )) if row else None,
            'rawShearWeightRatio': _first_number_from_records((row,), (
                'rawShearWeightRatio',
                'unadjustedShearWeightRatio',
            )) if row else None,
            'storyShearKN': _first_number_from_records((row,), (
                'storyShearKN',
                'cumulativeStoryShearKN',
                'cumulativeShearKN',
                'floorShearKN',
                'seismicShearKN',
            )) if row else None,
            'cumulativeWeightKN': _first_number_from_records((row,), (
                'cumulativeWeightKN',
                'weightAboveKN',
                'gravityLoadAboveKN',
                'representativeGravityLoadKN',
            )) if row else None,
        })
    return entries


def _story_shear_weight_entries(analysis_summary: Dict[str, Any]) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []

    def extend_from_container(container: Dict[str, Any], source: str, direction: Optional[str] = None) -> None:
        container_direction = direction or container.get('direction')
        entries.extend(_story_shear_weight_entries_from_rows(
            container.get('storyShearWeightRatios'),
            direction=container_direction,
            source=f'{source}.storyShearWeightRatios',
        ))
        entries.extend(_story_shear_weight_entries_from_rows(
            container.get('floorResponses'),
            direction=container_direction,
            source=f'{source}.floorResponses',
        ))

    extend_from_container(analysis_summary, 'analysisSummary')
    extend_from_container(_record(analysis_summary.get('summary')), 'analysisSummary.summary')
    extend_from_container(_record(analysis_summary.get('responseSpectrum')), 'analysisSummary.responseSpectrum')
    direction_results = analysis_summary.get('directionResults')
    if isinstance(direction_results, list):
        for index, raw_result in enumerate(direction_results, start=1):
            result = _record(raw_result)
            if not result:
                continue
            direction = result.get('direction')
            extend_from_container(
                _record(result.get('responseSpectrum')),
                f'analysisSummary.directionResults[{index}].responseSpectrum',
                direction=str(direction) if direction is not None else None,
            )

    seen: set[tuple[str, str, str, float]] = set()
    unique_entries: List[Dict[str, Any]] = []
    for entry in entries:
        ratio = _number(entry.get('ratio'))
        if ratio is None:
            continue
        key = (
            str(entry.get('direction') or ''),
            str(entry.get('story') or ''),
            str(entry.get('source') or ''),
            round(ratio, 10),
        )
        if key in seen:
            continue
        seen.add(key)
        unique_entries.append(entry)
    return unique_entries


def _story_minimum_seismic_shear_coefficient_item(
    analysis_summary: Dict[str, Any],
    design_basis: Dict[str, Any],
    summary: Dict[str, Any],
    envelope: Dict[str, Any],
    regularity_assessment: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    entries = _story_shear_weight_entries(analysis_summary)
    if not entries:
        return None
    limit_data = _story_minimum_shear_base_limit(
        analysis_summary,
        design_basis,
        summary,
        envelope,
        regularity_assessment,
    )
    if limit_data is None:
        return _check_item(
            '楼层最小地震剪力系数',
            demand=None,
            capacity=None,
            clause='GB/T 50011-2010(2024) 5.2.5',
            formula='story shear-weight ratio >= minimum coefficient from Table 5.2.5',
            unavailable_message='Story shear-weight ratios are available, but seismic intensity or design basic acceleration for Table 5.2.5 is unavailable.',
        )

    base_limit = float(limit_data['limit'])
    story_results: List[Dict[str, Any]] = []
    for entry in entries:
        ratio = float(entry['ratio'])
        weak_story = entry.get('isWeakStory') is True
        story_limit = base_limit * (1.15 if weak_story else 1.0)
        utilization = story_limit / max(ratio, 1e-12)
        story_results.append({
            'story': entry.get('story'),
            'direction': entry.get('direction'),
            'status': 'pass' if utilization <= 1.0 else 'fail',
            'utilization': round(utilization, 4),
            'shearWeightRatio': round(ratio, 8),
            'limit': round(story_limit, 8),
            'baseLimit': round(base_limit, 8),
            'isWeakStory': weak_story,
            'minimumShearAdjusted': bool(entry.get('minimumShearAdjusted')),
            'minimumShearAdjustmentFactor': (
                round(float(entry['minimumShearAdjustmentFactor']), 6)
                if entry.get('minimumShearAdjustmentFactor') is not None else None
            ),
            'rawShearWeightRatio': (
                round(float(entry['rawShearWeightRatio']), 8)
                if entry.get('rawShearWeightRatio') is not None else None
            ),
            'source': entry.get('source'),
            'storyShearKN': round(float(entry['storyShearKN']), 6) if entry.get('storyShearKN') is not None else None,
            'cumulativeWeightKN': round(float(entry['cumulativeWeightKN']), 6) if entry.get('cumulativeWeightKN') is not None else None,
        })
    controlling = max(story_results, key=lambda item: float(item.get('utilization') or 0.0))
    utilization = float(controlling.get('utilization') or 0.0)
    return {
        'item': '楼层最小地震剪力系数',
        'status': _aggregate_check_status(story_results),
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 5.2.5',
        'formula': 'V_Eki / G_i >= λ; weak story λ is multiplied by 1.15; 3.5s<T1<5.0s uses linear interpolation',
        'inputs': {
            'demand': controlling.get('shearWeightRatio'),
            'capacity': controlling.get('limit'),
            'limit': controlling.get('limit'),
            'baseLimit': round(base_limit, 8),
            'intensity': limit_data.get('intensity'),
            'designBasicAccelerationG': limit_data.get('designBasicAccelerationG'),
            'accelerationBand': limit_data.get('accelerationBand'),
            'fundamentalPeriod': (
                round(float(limit_data['fundamentalPeriod']), 6)
                if limit_data.get('fundamentalPeriod') is not None else None
            ),
            'periodSource': limit_data.get('periodSource'),
            'limitBasis': limit_data.get('basis'),
            'hasSignificantTorsion': limit_data.get('hasSignificantTorsion'),
            'minimumShearAdjustmentApplied': any(item.get('minimumShearAdjusted') for item in story_results),
            'storyCount': len(story_results),
            'controlling': controlling,
            'storyResults': story_results,
        },
    }
