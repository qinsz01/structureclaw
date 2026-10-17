"""Time-history analysis checks: ground motions, combination rule, direction trace, completeness."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _aggregate_check_status,
    _check_item,
    _is_true,
    _minimum_required_ratio_check_item,
    _number,
    _record,
)


def _actual_ground_motion_item(checks: Dict[str, Any]) -> Dict[str, Any]:
    actual_count = _number(checks.get('actualRecordCount'))
    required_count = _number(checks.get('requiredActualRecordCount'))
    if actual_count is None or required_count is None or required_count <= 0.0:
        return _check_item(
            '实际强震记录比例',
            demand=None,
            capacity=None,
            clause='GB/T 50011-2010(2024) 5.1.2',
            formula='n_actual >= ceil(2n/3)',
            unavailable_message='Ground-motion actual-record counts are unavailable.',
        )
    if actual_count <= 0.0:
        return {
            'item': '实际强震记录比例',
            'status': 'fail',
            'utilization': 0.0,
            'displayUtilization': 'N/A',
            'category': 'input_required',
            'failureType': 'missing_actual_ground_motion_records',
            'governingEligible': False,
            'clause': 'GB/T 50011-2010(2024) 5.1.2',
            'formula': 'n_actual >= ceil(2n/3)',
            'inputs': {
                'demand': actual_count,
                'capacity': required_count,
                'limit': required_count,
            },
            'message': 'No actual strong-motion records are available; provide the required actual records before final time-history compliance.',
        }
    utilization = required_count / max(actual_count, 1e-12)
    return {
        'item': '实际强震记录比例',
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 5.1.2',
        'formula': 'n_actual >= ceil(2n/3)',
        'inputs': {
            'demand': actual_count,
            'capacity': required_count,
            'limit': required_count,
        },
    }


def _ground_motion_record_count_item(time_history: Dict[str, Any], checks: Dict[str, Any]) -> Dict[str, Any]:
    records = time_history.get('records') if isinstance(time_history.get('records'), list) else []
    record_count = _number(checks.get('recordCount'))
    if record_count is None and records:
        record_count = float(len(records))
    if record_count is None:
        return _check_item(
            '地震波组数规则',
            demand=None,
            capacity=None,
            clause='GB/T 50011-2010(2024) 5.1.2',
            formula='n_records == 3 or n_records >= 7',
            unavailable_message='Ground-motion record count is unavailable.',
        )
    count = int(record_count)
    valid = count == 3 or count >= 7
    return {
        'item': '地震波组数规则',
        'status': 'pass' if valid else 'fail',
        'utilization': 0.0,
        **({} if valid else {
            'displayUtilization': 'N/A',
            'category': 'input_required',
            'failureType': 'invalid_ground_motion_record_count',
            'governingEligible': False,
            'message': 'Ground-motion record count must be exactly 3 or at least 7 for the implemented time-history combination rules.',
        }),
        'clause': 'GB/T 50011-2010(2024) 5.1.2',
        'formula': 'n_records == 3 or n_records >= 7',
        'inputs': {
            'recordCount': count,
            'allowedCounts': '3 or >=7',
        },
    }


def _time_history_combination_rule_item(time_history: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    summary = _record(time_history.get('combinationSummary'))
    if not summary:
        return None
    record_count = _number(summary.get('recordCount'))
    records = time_history.get('records') if isinstance(time_history.get('records'), list) else []
    if record_count is None and records:
        record_count = float(len(records))
    response_base = _number(summary.get('responseSpectrumBaseShear'))
    if response_base is None:
        response_base = _number(_record(time_history.get('baseShearCheck')).get('responseSpectrumBaseShear'))
    envelope_base = _number(summary.get('timeHistoryEnvelopeBaseShear'))
    if envelope_base is None:
        envelope_base = _number(time_history.get('envelopeBaseShear'))
    average_base = _number(summary.get('timeHistoryAverageBaseShear'))
    if average_base is None:
        average_base = _number(time_history.get('averageBaseShear'))
    combined_base = _number(summary.get('combinedBaseShear'))
    if combined_base is None:
        combined_base = _number(time_history.get('combinedBaseShear'))
    if record_count is None or response_base is None or combined_base is None:
        return _check_item(
            '时程组合规则',
            demand=None,
            capacity=None,
            clause='GB/T 50011-2010(2024) 5.1.2',
            formula='V_combined = max(V_response_spectrum, V_time_history_statistic)',
            unavailable_message='Time-history combination summary is present but missing record count or base-shear values.',
        )
    rule = str(summary.get('rule') or time_history.get('combinationRule') or '').strip()
    use_average = rule == 'mean_vs_response_spectrum' and record_count >= 7.0
    expected_statistic_name = 'average' if use_average else 'envelope'
    time_history_statistic = average_base if use_average else envelope_base
    if time_history_statistic is None:
        return _check_item(
            '时程组合规则',
            demand=None,
            capacity=None,
            clause='GB/T 50011-2010(2024) 5.1.2',
            formula='V_combined = max(V_response_spectrum, V_time_history_statistic)',
            unavailable_message='Time-history combination summary is present but missing the required statistic base shear.',
        )
    expected_combined = max(response_base, time_history_statistic)
    expected_source = (
        'response_spectrum'
        if response_base >= time_history_statistic
        else f'time_history_{expected_statistic_name}'
    )
    statistic_name = str(summary.get('timeHistoryStatistic') or '').strip()
    governing_source = str(summary.get('governingSource') or '').strip()
    tolerance = max(abs(expected_combined) * 1e-6, 1e-6)
    numeric_ok = abs(combined_base - expected_combined) <= tolerance
    statistic_ok = statistic_name == expected_statistic_name
    source_ok = governing_source == expected_source
    passed = numeric_ok and statistic_ok and source_ok
    utilization = 0.0 if passed else max(abs(combined_base - expected_combined) / tolerance, 1.0001)
    return {
        'item': '时程组合规则',
        'status': 'pass' if passed else 'fail',
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 5.1.2',
        'formula': 'V_combined = max(V_response_spectrum, V_time_history_statistic)',
        'inputs': {
            'rule': rule,
            'recordCount': int(record_count),
            'timeHistoryStatistic': statistic_name,
            'expectedTimeHistoryStatistic': expected_statistic_name,
            'timeHistoryStatisticBaseShear': round(time_history_statistic, 8),
            'responseSpectrumBaseShear': round(response_base, 8),
            'combinedBaseShear': round(combined_base, 8),
            'expectedCombinedBaseShear': round(expected_combined, 8),
            'governingSource': governing_source,
            'expectedGoverningSource': expected_source,
        },
    }


def _ground_motion_scale_factor_item(spectrum_match: Dict[str, Any]) -> Dict[str, Any]:
    max_scale_factor = _number(spectrum_match.get('maxScaleFactor'))
    scale_factor_limit = _number(spectrum_match.get('scaleFactorLimit'))
    if max_scale_factor is None or scale_factor_limit is None or scale_factor_limit <= 0.0:
        return _check_item(
            '地震波调幅系数',
            demand=None,
            capacity=None,
            clause='GB/T 50011-2010(2024) 5.1.2',
            formula='max(scaleFactor) <= projectScaleFactorLimit',
            unavailable_message='Ground-motion spectrum-matching scale factors are unavailable.',
        )
    return _check_item(
        '地震波调幅系数',
        demand=max_scale_factor,
        capacity=scale_factor_limit,
        limit=scale_factor_limit,
        clause='GB/T 50011-2010(2024) 5.1.2',
        formula='max(scaleFactor) <= projectScaleFactorLimit',
    )


def _ground_motion_spectrum_compatibility_item(spectrum_match: Dict[str, Any]) -> Dict[str, Any]:
    min_average_ratio = _number(spectrum_match.get('averageModalSpectrumMinRatioToTarget'))
    required_ratio = _number(spectrum_match.get('modalSpectrumAverageMinRatio'))
    if min_average_ratio is None or required_ratio is None or required_ratio <= 0.0:
        return _check_item(
            '地震波反应谱适配',
            demand=None,
            capacity=None,
            clause='GB/T 50011-2010(2024) 5.1.2',
            formula='min(mean(Sa_TH(T_i) / Sa_code(T_i))) >= modalSpectrumAverageMinRatio',
            unavailable_message='Ground-motion modal-period spectrum compatibility ratios are unavailable.',
        )
    if min_average_ratio <= 0.0:
        return {
            'item': '地震波反应谱适配',
            'status': 'fail',
            'utilization': 0.0,
            'displayUtilization': 'N/A',
            'category': 'input_required',
            'failureType': 'missing_ground_motion_spectrum_compatibility',
            'governingEligible': False,
            'clause': 'GB/T 50011-2010(2024) 5.1.2',
            'formula': 'min(mean(Sa_TH(T_i) / Sa_code(T_i))) >= modalSpectrumAverageMinRatio',
            'inputs': {
                'demand': round(min_average_ratio, 8),
                'capacity': required_ratio,
                'limit': required_ratio,
                'periodCheckScope': spectrum_match.get('periodCheckScope'),
                'periodCheckCount': len(spectrum_match.get('periodChecks', [])) if isinstance(spectrum_match.get('periodChecks'), list) else 0,
            },
            'message': 'Ground-motion spectrum compatibility ratio is zero; provide valid scaled record spectra before final compliance.',
        }
    utilization = required_ratio / max(min_average_ratio, 1e-12)
    return {
        'item': '地震波反应谱适配',
        'status': 'pass' if utilization <= 1.0 else 'fail',
        'utilization': round(utilization, 4),
        'clause': 'GB/T 50011-2010(2024) 5.1.2',
        'formula': 'min(mean(Sa_TH(T_i) / Sa_code(T_i))) >= modalSpectrumAverageMinRatio',
        'inputs': {
            'demand': round(min_average_ratio, 8),
            'capacity': round(required_ratio, 8),
            'limit': required_ratio,
            'periodCheckScope': spectrum_match.get('periodCheckScope'),
            'periodCheckCount': len(spectrum_match.get('periodChecks', [])) if isinstance(spectrum_match.get('periodChecks'), list) else 0,
        },
    }


def _time_history_direction_trace_item(analysis_summary: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    direction_results = analysis_summary.get('directionResults')
    if not isinstance(direction_results, list):
        return None

    direction_checks: List[Dict[str, Any]] = []
    missing_directions: List[str] = []
    for index, raw_result in enumerate(direction_results, start=1):
        result = _record(raw_result)
        if not result:
            continue
        direction = str(result.get('direction') or f'D{index}')
        time_history = _record(result.get('timeHistory'))
        if not time_history:
            missing_directions.append(direction)
            continue

        records = time_history.get('records') if isinstance(time_history.get('records'), list) else []
        ratios = [
            _number(_record(record).get('baseShearRatioToResponseSpectrum'))
            for record in records
            if isinstance(record, dict)
        ]
        finite_ratios = [ratio for ratio in ratios if ratio is not None]
        base_shear_check = _record(time_history.get('baseShearCheck'))
        response_base = _number(base_shear_check.get('responseSpectrumBaseShear'))
        average_base = _number(time_history.get('averageBaseShear'))
        average_ratio = average_base / response_base if average_base is not None and response_base and response_base > 0 else None
        if average_ratio is None and finite_ratios:
            average_ratio = sum(finite_ratios) / len(finite_ratios)

        combination_rule_item = _time_history_combination_rule_item(time_history)
        subchecks = [
            _minimum_required_ratio_check_item(
                'direction_each_record_base_shear_ratio',
                actual_ratio=min(finite_ratios) if finite_ratios else None,
                required_ratio=0.65,
                clause='GB/T 50011-2010(2024) 5.1.2',
                formula='V_time_history_each / V_response_spectrum >= 0.65',
            ),
            _minimum_required_ratio_check_item(
                'direction_average_base_shear_ratio',
                actual_ratio=average_ratio,
                required_ratio=0.80,
                clause='GB/T 50011-2010(2024) 5.1.2',
                formula='mean(V_time_history) / V_response_spectrum >= 0.80',
            ),
            _actual_ground_motion_item(_record(time_history.get('groundMotionSetChecks'))),
            _ground_motion_record_count_item(time_history, _record(time_history.get('groundMotionSetChecks'))),
            *([combination_rule_item] if combination_rule_item else []),
            _ground_motion_scale_factor_item(_record(time_history.get('spectrumMatch'))),
            _ground_motion_spectrum_compatibility_item(_record(time_history.get('spectrumMatch'))),
        ]
        direction_status = _aggregate_check_status(subchecks)
        direction_checks.append({
            'direction': direction,
            'status': direction_status,
            'utilization': round(max(float(item.get('utilization', 0.0) or 0.0) for item in subchecks), 4),
            'recordCount': len(records),
            'minBaseShearRatio': round(min(finite_ratios), 8) if finite_ratios else None,
            'averageBaseShearRatio': round(average_ratio, 8) if average_ratio is not None else None,
            'responseSpectrumBaseShear': round(response_base, 8) if response_base is not None else None,
            'source': f'directionResults[{index}].timeHistory',
            'subchecks': subchecks,
        })

    if not direction_checks and not missing_directions:
        return None

    status = 'input_required' if missing_directions else _aggregate_check_status(direction_checks)
    utilization = max((float(item.get('utilization', 0.0) or 0.0) for item in direction_checks), default=0.0)
    return {
        'item': '时程方向级校核追踪',
        'status': status,
        'utilization': round(utilization, 4),
        'displayUtilization': 'N/A' if status != 'pass' else round(utilization, 4),
        'category': 'diagnostic',
        'governingEligible': False,
        **({} if status == 'pass' else {'failureType': 'time_history_direction_trace'}),
        'clause': 'GB/T 50011-2010(2024) 5.1.2',
        'formula': 'each direction checks ground-motion count, actual-record ratio, base-shear ratios, combination rule, scale factor, and spectrum compatibility',
        'inputs': {
            'checkedDirectionCount': len(direction_checks),
            'missingDirectionCount': len(missing_directions),
            'missingDirections': missing_directions,
            'directionChecks': direction_checks,
        },
    }


def _required_time_history_item(
    method_decision: Dict[str, Any],
    time_history: Dict[str, Any],
    ground_motion_requirement: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    if not _is_true(method_decision.get('requiresTimeHistory')):
        return None
    records = time_history.get('records') if isinstance(time_history.get('records'), list) else []
    provided_count = _number(ground_motion_requirement.get('providedCount'))
    actual_count = int(provided_count) if provided_count is not None else len(records)
    required_count = _number(ground_motion_requirement.get('totalRequiredCount'))
    if required_count is None:
        required_count = _number(ground_motion_requirement.get('requiredCount'))
    if required_count is None:
        required_count = _number(method_decision.get('requiredGroundMotionCount'))
    required = max(1.0, required_count or 0.0)
    missing_count = _number(ground_motion_requirement.get('missingCount'))
    if missing_count is None:
        missing_count = max(required - actual_count, 0.0)
    passed = actual_count >= required and (missing_count or 0.0) <= 0.0
    utilization = 0.0 if passed or actual_count <= 0 else required / float(actual_count)
    return {
        'item': '补充时程分析完整性',
        'status': 'pass' if passed else 'fail',
        'utilization': round(utilization, 4),
        **({} if passed else {
            'displayUtilization': 'N/A',
            'category': 'input_required',
            'failureType': 'supplementary_time_history_incomplete',
            'governingEligible': False,
            'message': 'Supplementary time-history analysis is required but the required ground-motion records or results are incomplete.',
        }),
        'clause': 'GB/T 50011-2010(2024) 5.1.2',
        'formula': 'required supplementary time-history records and results are provided',
        'inputs': {
            'demand': actual_count,
            'capacity': int(required),
            'limit': int(required),
            'missingCount': int(missing_count),
        },
    }


def _elastic_plastic_time_history_final_compliance_item(analysis_summary: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    elastic_plastic = _record(analysis_summary.get('elasticPlasticTimeHistory'))
    final_compliance = _record(elastic_plastic.get('finalCompliance'))
    if not final_compliance:
        return None
    utilization = _number(final_compliance.get('utilization'))
    status = str(final_compliance.get('status') or '').strip().lower()
    drift = _number(final_compliance.get('driftRatio'))
    limit = _number(final_compliance.get('limitDriftRatio'))
    if status not in {'pass', 'fail'}:
        return _check_item(
            '弹塑性时程最终符合性',
            demand=None,
            capacity=None,
            clause='GB 55002-2021 + GB/T 50011-2010(2024)',
            formula='elastic-plastic time-history acceptance result is available',
            unavailable_message='Elastic-plastic time-history final compliance result is present but does not contain a pass/fail status.',
        )
    return {
        'item': '弹塑性时程最终符合性',
        'status': 'pass' if status == 'pass' and (utilization is None or utilization <= 1.0) else 'fail',
        'utilization': round(float(utilization or 0.0), 4),
        'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
        'formula': 'elastic-plastic time-history drift ratio <= limit drift ratio',
        'inputs': {
            'demand': round(float(drift), 8) if drift is not None else None,
            'capacity': round(float(limit), 8) if limit is not None else None,
            'method': final_compliance.get('method'),
            'source': final_compliance.get('source'),
            'scope': final_compliance.get('scope'),
        },
    }
