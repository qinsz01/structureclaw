"""Workflow input, capability boundary, special system and over-limit review checks."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .common import (
    _is_false,
    _is_true,
    _number,
    _record,
)


def _workflow_input_mode_item(analysis_summary: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    raw_mode = analysis_summary.get('workflowInputMode')
    if not isinstance(raw_mode, str) or not raw_mode.strip():
        return None
    mode = raw_mode.strip()
    passed = mode == 'structured_seismic_workflow'
    return {
        'item': '结构化抗震流程输入',
        'status': 'pass' if passed else 'fail',
        'utilization': 0.0 if passed else 9999.0,
        'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
        'formula': 'China seismic final compliance uses structured seismicWorkflow input',
        'inputs': {
            'workflowInputMode': mode,
            'requiredWorkflowInputMode': 'structured_seismic_workflow',
        },
        **({} if passed else {
            'message': 'Analysis result was produced through the legacy compatibility parameter path; rerun with structured seismicWorkflow before claiming final China seismic compliance.',
        }),
    }


def _capability_boundary_item(analysis_summary: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    raw_missing = analysis_summary.get('missingCapabilities')
    missing_capabilities = [
        str(item) for item in raw_missing if str(item).strip()
    ] if isinstance(raw_missing, list) else []
    capability_assessment = _record(analysis_summary.get('capabilityAssessment'))
    final_compliance_supported = capability_assessment.get('finalComplianceSupported')
    if not missing_capabilities and final_compliance_supported is not False:
        return None
    return {
        'item': '抗震能力边界',
        'status': 'unsupported',
        'category': 'unsupported',
        'utilization': None,
        'displayUtilization': 'N/A',
        'governingEligible': False,
        'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
        'formula': 'implemented seismic workflow capabilities cover required final compliance checks',
        'inputs': {
            'missingCapabilities': missing_capabilities,
            'finalComplianceSupported': final_compliance_supported,
            'structuralFamily': capability_assessment.get('structuralFamily'),
        },
    }


def _special_system_check_traces(checks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    traces: List[Dict[str, Any]] = []
    for raw_check in checks:
        check = _record(raw_check)
        inputs = _record(check.get('inputs'))
        trace_inputs = {
            key: value
            for key, value in inputs.items()
            if value is None or isinstance(value, (str, int, float, bool))
        }
        traces.append({
            'item': check.get('item'),
            'status': check.get('status'),
            'utilization': _number(check.get('utilization')),
            'clause': check.get('clause'),
            'formula': check.get('formula'),
            'inputs': trace_inputs,
        })
    return traces


def _special_system_review_item(analysis_summary: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    review = _record(analysis_summary.get('specialSystemReview'))
    if not review:
        review = _record(_record(analysis_summary.get('methodDecision')).get('specialSystemAudit'))
    if review.get('reviewRequired') is not True:
        return None
    systems = [
        str(item) for item in review.get('systems', [])
        if str(item).strip()
    ] if isinstance(review.get('systems'), list) else []
    missing_inputs = [
        str(item) for item in review.get('missingInputs', [])
        if str(item).strip()
    ] if isinstance(review.get('missingInputs'), list) else []
    capability_boundaries = [
        str(item) for item in review.get('capabilityBoundaries', [])
        if str(item).strip()
    ] if isinstance(review.get('capabilityBoundaries'), list) else []
    checks = [
        item for item in review.get('checks', [])
        if isinstance(item, dict)
    ] if isinstance(review.get('checks'), list) else []
    isolation_estimate = _record(review.get('isolationEquivalentLinearEstimate'))
    isolation_time_history_estimate = _record(review.get('isolationLayerTimeHistoryEstimate'))
    energy_dissipation_estimate = _record(review.get('energyDissipationEquivalentEstimate'))
    energy_dissipation_time_history_estimate = _record(review.get('energyDissipationTimeHistoryEstimate'))
    failed_checks = [
        _record(item).get('item') for item in checks
        if _record(item).get('status') == 'fail'
    ]
    status = 'fail' if failed_checks else 'unsupported' if capability_boundaries else 'input_required' if missing_inputs else 'pass'
    return {
        'item': '隔震与消能减震专门体系审计',
        'status': status,
        'category': status if status in {'unsupported', 'input_required'} else 'diagnostic',
        'utilization': None,
        'governingEligible': False,
        'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
        'formula': 'specialized isolation/energy-dissipation systems require structured device audit and specialized analysis before final compliance',
        'inputs': {
            'systems': systems,
            'missingInputs': missing_inputs,
            'capabilityBoundaries': capability_boundaries,
            'deviceCounts': review.get('deviceCounts'),
            'failedChecks': failed_checks,
            'checkCount': len(checks),
            'checks': _special_system_check_traces(checks),
            'isolationEquivalentLinearEstimate': {
                key: isolation_estimate.get(key)
                for key in (
                    'status',
                    'periodSec',
                    'alpha',
                    'baseShearKN',
                    'displacementDemandM',
                    'displacementCapacityM',
                    'displacementUtilization',
                )
                if isolation_estimate.get(key) is not None
            } if isolation_estimate else None,
            'isolationLayerTimeHistoryEstimate': {
                key: isolation_time_history_estimate.get(key)
                for key in (
                    'status',
                    'engineMode',
                    'periodSec',
                    'recordCount',
                    'controllingRecord',
                    'maxDisplacementM',
                    'maxBaseShearKN',
                    'displacementCapacityM',
                    'displacementUtilization',
                )
                if isolation_time_history_estimate.get(key) is not None
            } if isolation_time_history_estimate else None,
            'energyDissipationEquivalentEstimate': {
                key: energy_dissipation_estimate.get(key)
                for key in (
                    'status',
                    'periodSec',
                    'baseDampingRatio',
                    'additionalDampingRatio',
                    'equivalentDampingRatio',
                    'demandReductionRatio',
                    'adjustedDisplacementDemandM',
                    'deformationCapacityM',
                    'deformationUtilization',
                )
                if energy_dissipation_estimate.get(key) is not None
            } if energy_dissipation_estimate else None,
            'energyDissipationTimeHistoryEstimate': {
                key: energy_dissipation_time_history_estimate.get(key)
                for key in (
                    'status',
                    'engineMode',
                    'periodSec',
                    'recordCount',
                    'controllingRecord',
                    'maxDeviceDeformationM',
                    'maxDeviceForceKN',
                    'deformationCapacityM',
                    'deformationUtilization',
                    'forceCapacityKN',
                    'forceUtilization',
                )
                if energy_dissipation_time_history_estimate.get(key) is not None
            } if energy_dissipation_time_history_estimate else None,
        },
        **({} if status == 'pass' else {
            'message': 'Structured workflow includes isolation or energy-dissipation systems; final China seismic compliance requires specialized system analysis and complete device acceptance data.',
        }),
    }


def _review_requirement_trace(
    sources: List[tuple[str, Dict[str, Any]]],
) -> tuple[Optional[bool], List[Dict[str, Any]]]:
    keys = (
        'reviewRequired',
        'required',
        'requiresReview',
        'overLimitReviewRequired',
        'requiresOverLimitReview',
        'specialReviewRequired',
        'requiresSpecialReview',
        'specialSeismicReviewRequired',
    )
    traces: List[Dict[str, Any]] = []
    for source_name, source in sources:
        for key in keys:
            if key not in source:
                continue
            value = source.get(key)
            if _is_true(value):
                traces.append({'source': f'{source_name}.{key}', 'value': True})
            elif _is_false(value):
                traces.append({'source': f'{source_name}.{key}', 'value': False})
    if any(trace.get('value') is True for trace in traces):
        return True, traces
    if any(trace.get('value') is False for trace in traces):
        return False, traces
    return None, traces


def _review_status_trace(record: Dict[str, Any]) -> tuple[str, Optional[str], Optional[str]]:
    status_keys = (
        'status',
        'reviewStatus',
        'approvalStatus',
        'conclusion',
        'reviewConclusion',
        'approvalConclusion',
    )
    approved_statuses = {'approved', 'accepted', 'passed', 'pass', 'complete', 'completed', 'provided'}
    failed_statuses = {'rejected', 'denied', 'failed', 'fail', 'not_approved', 'unapproved'}
    for key in status_keys:
        raw = record.get(key)
        if raw is None:
            continue
        value = str(raw).strip().lower()
        if not value:
            continue
        if value in approved_statuses:
            return 'approved', key, str(raw)
        if value in failed_statuses:
            return 'failed', key, str(raw)
        return 'pending', key, str(raw)

    provided_keys = (
        'approved',
        'reviewApproved',
        'approvalProvided',
        'reviewCompleted',
        'completed',
        'provided',
        'expertReviewProvided',
        'expertReviewCompleted',
    )
    for key in provided_keys:
        if _is_true(record.get(key)):
            return 'approved', key, record.get(key)
    return 'missing', None, None


def _review_reasons(record: Dict[str, Any]) -> List[str]:
    reasons: List[str] = []
    for key in ('reasons', 'reviewReasons', 'overLimitReasons', 'specialReviewReasons'):
        value = record.get(key)
        if isinstance(value, list):
            reasons.extend(str(item) for item in value if str(item).strip())
        elif isinstance(value, str) and value.strip():
            reasons.append(value.strip())
    return list(dict.fromkeys(reasons))


def _over_limit_special_review_item(
    analysis_summary: Dict[str, Any],
    design_basis: Dict[str, Any],
    method_decision: Dict[str, Any],
    regularity_assessment: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    review_sources = [
        ('analysisSummary.overLimitReview', _record(analysis_summary.get('overLimitReview'))),
        ('analysisSummary.specialReview', _record(analysis_summary.get('specialReview'))),
        ('analysisSummary.specialSeismicReview', _record(analysis_summary.get('specialSeismicReview'))),
        ('analysisSummary.overLimitSpecialReview', _record(analysis_summary.get('overLimitSpecialReview'))),
        ('analysisSummary.designBasis.overLimitReview', _record(design_basis.get('overLimitReview'))),
        ('analysisSummary.designBasis.specialReview', _record(design_basis.get('specialReview'))),
        ('analysisSummary.methodDecision.overLimitReview', _record(method_decision.get('overLimitReview'))),
        ('analysisSummary.methodDecision.specialReview', _record(method_decision.get('specialReview'))),
        ('analysisSummary.regularityAssessment', regularity_assessment),
    ]
    nonempty_review_sources = [
        (source_name, source)
        for source_name, source in review_sources
        if source
    ]
    review_required, requirement_traces = _review_requirement_trace(nonempty_review_sources)

    evidence_traces: List[Dict[str, Any]] = []
    failed_sources: List[str] = []
    pending_sources: List[str] = []
    provided = False
    reasons: List[str] = []
    for source_name, source in nonempty_review_sources:
        state, status_key, raw_status = _review_status_trace(source)
        reasons.extend(_review_reasons(source))
        trace = {
            'source': source_name,
            'state': state,
            'statusField': status_key,
            'status': raw_status,
            'reviewType': source.get('reviewType') or source.get('type'),
            'approvalId': source.get('approvalId') or source.get('reviewId') or source.get('reportId'),
            'authority': source.get('authority') or source.get('reviewAuthority'),
            'date': source.get('date') or source.get('reviewDate') or source.get('approvalDate'),
        }
        if any(value is not None for key, value in trace.items() if key not in {'source', 'state'}):
            evidence_traces.append(trace)
        if state == 'approved':
            provided = True
        elif state == 'failed':
            failed_sources.append(source_name)
        elif state == 'pending':
            pending_sources.append(source_name)

    if review_required is None and not provided and not failed_sources:
        return None

    failed = bool(failed_sources) or (review_required is True and not provided)
    missing_evidence = review_required is True and not provided and not failed_sources
    classification = str(regularity_assessment.get('classification') or '').strip().lower() or None
    return {
        'item': '超限与专项审查结构化追踪',
        'status': 'fail' if failed else 'pass',
        'utilization': 9999.0 if failed else 0.0,
        'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
        'formula': 'structured over-limit or special seismic review requirement => traceable approved/completed review evidence',
        'inputs': {
            'reviewRequired': review_required,
            'requirementTraces': requirement_traces,
            'reviewEvidenceProvided': provided,
            'failedReviewSources': failed_sources,
            'pendingReviewSources': pending_sources,
            'reviewEvidence': evidence_traces,
            'regularityClassification': classification,
            'reasons': list(dict.fromkeys(reasons)),
            'missingReviewEvidence': missing_evidence,
        },
        **({} if not failed else {
            'message': 'Structured over-limit or special seismic review is required but approved/completed review evidence is missing or explicitly failed.',
        }),
    }
