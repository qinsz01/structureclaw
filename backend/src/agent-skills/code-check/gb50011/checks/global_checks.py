"""Global seismic checks assembled for the ``__global_seismic__`` element."""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from gb50011_drift_limits import gb50011_elastic_drift_limit_metadata

from .common import (
    _check_item,
    _is_true,
    _minimum_required_ratio_check_item,
    _number,
    _record,
)
from .design_basis import (
    _design_basis_completeness_item,
    _fortification_category_item,
    _gb18306_standard_status_item,
    _seismic_grade_design_basis_item,
)
from .member_capacity import (
    _member_capacity_screening_item,
    _vertical_member_capacity_items,
)
from .response_spectrum import (
    _modal_mass_participation_item,
    _response_spectrum_long_period_special_study_item,
    _story_minimum_seismic_shear_coefficient_item,
)
from .seismic_review import (
    _capability_boundary_item,
    _over_limit_special_review_item,
    _special_system_review_item,
    _workflow_input_mode_item,
)
from .time_history import (
    _actual_ground_motion_item,
    _elastic_plastic_time_history_final_compliance_item,
    _ground_motion_record_count_item,
    _ground_motion_scale_factor_item,
    _ground_motion_spectrum_compatibility_item,
    _required_time_history_item,
    _time_history_combination_rule_item,
    _time_history_direction_trace_item,
)


def _elastic_drift_limit_metadata(design_basis: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    return gb50011_elastic_drift_limit_metadata(design_basis.get('structuralFamily'))


def _regularity_time_history_trigger_item(
    regularity_assessment: Dict[str, Any],
    method_decision: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    if not regularity_assessment:
        return None
    classification = str(regularity_assessment.get('classification') or '').strip().lower()
    if not classification:
        return None
    requires_time_history = _is_true(method_decision.get('requiresTimeHistory'))
    selected_methods = method_decision.get('selectedMethods')
    selected_method_values = [
        str(item).strip().lower()
        for item in selected_methods
        if isinstance(item, str)
    ] if isinstance(selected_methods, list) else []
    has_time_history_method = any('time_history' in item for item in selected_method_values)
    trigger_satisfied = requires_time_history or has_time_history_method
    if classification == 'particularly_irregular':
        passed = trigger_satisfied
        utilization = 0.0
        message = None if passed else 'Particularly irregular regularity classification did not trigger supplementary time-history demand.'
    elif classification in {'regular', 'irregular'}:
        passed = True
        utilization = 0.0
        message = None
    else:
        return {
            'item': '规则性评估与补充时程触发',
            'status': 'input_required',
            'category': 'input_required',
            'utilization': None,
            'clause': 'GB/T 50011-2010(2024) 5.1.2',
            'formula': 'particularly_irregular => supplementary frequent-earthquake time-history analysis',
            'inputs': {
                'classification': classification,
                'regularitySource': regularity_assessment.get('source'),
                'requiresTimeHistory': requires_time_history,
                'selectedMethods': selected_method_values,
            },
            'message': 'Regularity classification is unknown; engineer review is required before final GB50011 compliance.',
        }
    return {
        'item': '规则性评估与补充时程触发',
        'status': 'pass' if passed else 'fail',
        'utilization': utilization,
        'clause': 'GB/T 50011-2010(2024) 5.1.2',
        'formula': 'particularly_irregular => supplementary frequent-earthquake time-history analysis',
        'inputs': {
            'classification': classification,
            'regularitySource': regularity_assessment.get('source'),
            'requiresTimeHistory': requires_time_history,
            'selectedMethods': selected_method_values,
            'checkCount': len(regularity_assessment.get('checks', [])) if isinstance(regularity_assessment.get('checks'), list) else None,
        },
        **({} if passed else {
            'displayUtilization': 'N/A',
            'category': 'input_required',
            'failureType': 'required_time_history_not_triggered',
            'governingEligible': False,
            'message': message,
        }),
    }


def _vertical_seismic_action_item(method_decision: Dict[str, Any], vertical_seismic: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not _is_true(method_decision.get('verticalSeismicRequired')):
        return None
    total_vertical_action = _number(vertical_seismic.get('totalVerticalActionKN'))
    coefficient = _number(vertical_seismic.get('coefficient'))
    if total_vertical_action is None or coefficient is None or total_vertical_action <= 0.0 or coefficient <= 0.0:
        return _check_item(
            '竖向地震作用标准值',
            demand=None,
            capacity=None,
            clause='GB/T 50011-2010(2024) 5.3',
            formula='Evk is calculated when vertical seismic action is required',
            unavailable_message='Vertical seismic action is required but no calculated vertical seismic standard value is available.',
        )
    return {
        'item': '竖向地震作用标准值',
        'status': 'pass',
        'utilization': 0.0,
        'clause': 'GB/T 50011-2010(2024) 5.3',
        'formula': 'Evk = vertical seismic coefficient * representative gravity load',
        'inputs': {
            'coefficient': round(coefficient, 8),
            'totalVerticalActionKN': round(total_vertical_action, 6),
            'method': vertical_seismic.get('method'),
        },
    }


def _vertical_seismic_member_force_item(method_decision: Dict[str, Any], vertical_seismic: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not _is_true(method_decision.get('verticalSeismicRequired')):
        return None
    static_check = _record(vertical_seismic.get('openSeesStatic'))
    member_force_count = _number(static_check.get('memberForceCount'))
    member_forces = static_check.get('memberForces')
    if member_force_count is None and isinstance(member_forces, dict):
        member_force_count = float(len(member_forces))
    if member_force_count is None or member_force_count <= 0.0:
        return _check_item(
            '竖向地震构件内力',
            demand=None,
            capacity=None,
            clause='GB/T 50011-2010(2024) 5.3',
            formula='vertical seismic action is propagated to member end forces',
            unavailable_message='Vertical seismic action was calculated but member end forces are unavailable.',
        )
    return {
        'item': '竖向地震构件内力',
        'status': 'pass',
        'utilization': 0.0,
        'clause': 'GB/T 50011-2010(2024) 5.3',
        'formula': 'OpenSees equivalent vertical static action produces member end forces',
        'inputs': {
            'memberForceCount': int(member_force_count),
            'staticStatus': static_check.get('status'),
        },
    }


def _pushover_nonlinear_estimate_item(analysis_summary: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    pushover = _record(analysis_summary.get('pushover'))
    nonlinear = _record(pushover.get('nonlinearEstimate'))
    if not nonlinear:
        return None
    performance = _record(nonlinear.get('performancePoint'))
    acceptance = _record(nonlinear.get('acceptanceCheck'))
    drift = _number(performance.get('driftRatio'))
    if drift is None:
        drift = _number(nonlinear.get('maxDriftRatio'))
    limit = _number(acceptance.get('limitDriftRatio'))
    if limit is None:
        limit = _number(nonlinear.get('acceptanceDriftRatio'))
    return _check_item(
        'Pushover弹塑性估算位移角',
        demand=drift,
        capacity=limit,
        limit=limit,
        clause='GB 55002-2021 + GB/T 50011-2010(2024)',
        formula='estimated nonlinear pushover drift ratio <= structured or advisory drift limit',
        unavailable_message='Pushover nonlinear estimate is present but its drift ratio or limit is unavailable.',
    )


def _pushover_final_compliance_item(analysis_summary: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    pushover = _record(analysis_summary.get('pushover'))
    final_compliance = _record(pushover.get('finalCompliance'))
    if not final_compliance:
        return None
    utilization = _number(final_compliance.get('utilization'))
    status = str(final_compliance.get('status') or '').strip().lower()
    drift = _number(final_compliance.get('driftRatio'))
    limit = _number(final_compliance.get('limitDriftRatio'))
    if status not in {'pass', 'fail'}:
        return _check_item(
            'Pushover最终符合性',
            demand=None,
            capacity=None,
            clause='GB 55002-2021 + GB/T 50011-2010(2024)',
            formula='pushover final compliance acceptance result is available',
            unavailable_message='Pushover final compliance result is present but does not contain a pass/fail status.',
        )
    return {
        'item': 'Pushover最终符合性',
        'status': 'pass' if status == 'pass' and (utilization is None or utilization <= 1.0) else 'fail',
        'utilization': round(float(utilization or 0.0), 4),
        'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
        'formula': 'pushover acceptance drift ratio <= limit drift ratio',
        'inputs': {
            'demand': round(float(drift), 8) if drift is not None else None,
            'capacity': round(float(limit), 8) if limit is not None else None,
            'method': final_compliance.get('method'),
            'source': final_compliance.get('source'),
            'scope': final_compliance.get('scope'),
        },
    }


def _horizontal_seismic_member_force_item(analysis_summary: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    design_actions = _record(analysis_summary.get('seismicDesignActions'))
    if not design_actions:
        return None
    member_force_count = _number(design_actions.get('memberForceCount'))
    member_forces = design_actions.get('memberForces')
    if member_force_count is None and isinstance(member_forces, dict):
        member_force_count = float(len(member_forces))
    if member_force_count is None or member_force_count <= 0.0:
        return _check_item(
            '水平地震构件内力',
            demand=None,
            capacity=None,
            clause='GB/T 50011-2010(2024) 5.2',
            formula='response-spectrum horizontal floor actions are propagated to member end forces',
            unavailable_message='Horizontal seismic design actions are present but member end forces are unavailable.',
        )
    return {
        'item': '水平地震构件内力',
        'status': 'pass',
        'utilization': 0.0,
        'clause': 'GB/T 50011-2010(2024) 5.2',
        'formula': 'OpenSees equivalent lateral static action from response-spectrum floor forces produces member end forces',
        'inputs': {
            'memberForceCount': int(member_force_count),
            'direction': design_actions.get('direction'),
            'method': design_actions.get('method'),
        },
    }


def _member_design_action_combination_item(analysis_summary: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    combinations = _record(analysis_summary.get('memberDesignActionCombinations'))
    if not combinations:
        return None
    member_count = _number(combinations.get('memberCount'))
    case_count = _number(combinations.get('caseCount'))
    if member_count is None or case_count is None or member_count <= 0.0 or case_count <= 0.0:
        return _check_item(
            '抗震基本作用组合',
            demand=None,
            capacity=None,
            clause='GB/T 50011-2010(2024) 5.4.1',
            formula='1.2G + seismic effect factors produce member design action cases',
            unavailable_message='Seismic member design action combinations are present but have no member or case envelope.',
        )
    status = str(combinations.get('status') or '').strip().lower()
    utilization = 0.0 if status == 'computed' else 9999.0
    return {
        'item': '抗震基本作用组合',
        'status': 'pass' if status == 'computed' else 'fail',
        'utilization': utilization,
        'clause': 'GB/T 50011-2010(2024) 5.4.1',
        'formula': '1.2G + 1.3Eh and optional 1.2G + 1.3Eh + 0.5Ev / 1.2G + 0.5Eh + 1.3Ev',
        'inputs': {
            'memberCount': int(member_count),
            'caseCount': int(case_count),
            'status': combinations.get('status'),
            'controlling': combinations.get('controlling'),
        },
    }


def _member_design_action_combination_capacity_items(
    analysis_summary: Dict[str, Any],
    element_data: Dict[str, Any],
) -> List[Dict[str, Any]]:
    combinations = _record(analysis_summary.get('memberDesignActionCombinations'))
    cases = combinations.get('cases')
    if not isinstance(cases, list) or not cases:
        return []

    entries: List[Dict[str, Any]] = []
    for raw_case in cases:
        case = _record(raw_case)
        case_name = str(case.get('name') or '')
        member_actions = case.get('memberActions')
        if not isinstance(member_actions, list):
            continue
        for raw_action in member_actions:
            action = _record(raw_action)
            if not action:
                continue
            entries.append({
                **action,
                'case': case_name,
            })

    if not entries:
        return []
    return [_member_capacity_screening_item(
        item_name='抗震组合构件承载力抽查',
        force_entries=entries,
        element_data=element_data,
        clause='GB 55002-2021 + GB/T 50011-2010(2024) 5.4.1',
        formula='N/Nu + M/Mu <= 1.0 using seismic basic action combination member envelope',
        unavailable_message='Seismic combination member capacity data is unavailable for all checked members',
    )]


def _global_seismic_checks(context: Dict[str, Any]) -> List[Dict[str, Any]]:
    analysis_summary = _record(context.get('analysisSummary'))
    summary = _record(analysis_summary.get('summary'))
    envelope = _record(analysis_summary.get('envelope'))
    design_basis = _record(analysis_summary.get('designBasis'))
    method_decision = _record(analysis_summary.get('methodDecision'))
    regularity_assessment = _record(analysis_summary.get('regularityAssessment'))
    time_history = _record(analysis_summary.get('timeHistory'))
    vertical_seismic = _record(analysis_summary.get('verticalSeismic'))
    ground_motion_requirement = _record(analysis_summary.get('groundMotionRequirement'))
    element_data = _record(context.get('elementData'))

    drift = _number(summary.get('maxStoryDriftRatio'))
    if drift is None:
        drift = _number(envelope.get('maxStoryDriftRatio'))
    drift_limit_metadata = _elastic_drift_limit_metadata(design_basis)
    drift_limit = None if drift_limit_metadata is None else float(drift_limit_metadata['limit'])
    drift_formula = 'θe <= [θe]'
    if drift_limit_metadata is not None:
        drift_formula = (
            f"θe <= [θe]; {drift_limit_metadata['familyLabel']} "
            f"[θe]=1/{drift_limit_metadata['denominator']}"
        )

    drift_item = _check_item(
        '多遇地震弹性层间位移角',
        demand=drift,
        capacity=drift_limit,
        limit=drift_limit,
        clause='GB/T 50011-2010(2024) 5.5.1',
        formula=drift_formula,
        unavailable_message='Elastic story-drift ratio is unavailable or the structure family has no implemented drift limit.',
    )
    if drift_limit_metadata is not None:
        drift_item['inputs']['limitFamily'] = drift_limit_metadata['familyLabel']
        drift_item['inputs']['limitRatioText'] = f"1/{drift_limit_metadata['denominator']}"
    time_history_controlling_story = _record(time_history.get('controllingStory'))
    if time_history_controlling_story:
        drift_item['inputs']['timeHistoryControllingStory'] = time_history_controlling_story
    design_basis_item = _design_basis_completeness_item(design_basis)
    fortification_category_item = _fortification_category_item(design_basis)
    seismic_grade_item = _seismic_grade_design_basis_item(design_basis)
    gb18306_status_item = _gb18306_standard_status_item(design_basis)
    design_basis_items = [
        item for item in [design_basis_item, fortification_category_item, seismic_grade_item, gb18306_status_item]
        if item is not None
    ]
    design_basis_group = [{
        'name': '抗震设计依据完整性校核',
        'items': design_basis_items,
    }] if design_basis_items else []
    workflow_input_item = _workflow_input_mode_item(analysis_summary)
    workflow_input_group = [{
        'name': '抗震流程输入校核',
        'items': [workflow_input_item],
    }] if workflow_input_item else []
    capability_item = _capability_boundary_item(analysis_summary)
    capability_group = [{
        'name': '抗震能力边界校核',
        'items': [capability_item],
    }] if capability_item else []
    special_system_item = _special_system_review_item(analysis_summary)
    special_system_group = [{
        'name': '隔震与消能减震专门体系校核',
        'items': [special_system_item],
    }] if special_system_item else []
    over_limit_review_item = _over_limit_special_review_item(
        analysis_summary,
        design_basis,
        method_decision,
        regularity_assessment,
    )
    over_limit_review_group = [{
        'name': '超限与专项审查校核',
        'items': [over_limit_review_item],
    }] if over_limit_review_item else []
    modal_item = _modal_mass_participation_item(summary, envelope)
    modal_group = [{
        'name': '振型组合完整性校核',
        'items': [modal_item],
    }] if modal_item else []
    long_period_item = _response_spectrum_long_period_special_study_item(analysis_summary)
    long_period_group = [{
        'name': '反应谱周期范围校核',
        'items': [long_period_item],
    }] if long_period_item else []
    story_shear_item = _story_minimum_seismic_shear_coefficient_item(
        analysis_summary,
        design_basis,
        summary,
        envelope,
        regularity_assessment,
    )
    story_shear_group = [{
        'name': '楼层地震剪力系数校核',
        'items': [story_shear_item],
    }] if story_shear_item else []
    regularity_item = _regularity_time_history_trigger_item(regularity_assessment, method_decision)
    regularity_group = [{
        'name': '规则性与方法选择校核',
        'items': [regularity_item],
    }] if regularity_item else []
    vertical_item = _vertical_seismic_action_item(method_decision, vertical_seismic)
    vertical_member_item = _vertical_seismic_member_force_item(method_decision, vertical_seismic)
    vertical_group = [{
        'name': '竖向地震作用校核',
        'items': [
            item for item in [vertical_item, vertical_member_item]
            if item is not None
        ] + _vertical_member_capacity_items(vertical_seismic, element_data),
    }] if vertical_item or vertical_member_item else []
    pushover_item = _pushover_nonlinear_estimate_item(analysis_summary)
    pushover_final_item = _pushover_final_compliance_item(analysis_summary)
    pushover_group = [{
        'name': 'Pushover弹塑性估算校核',
        'items': [
            item for item in [pushover_item, pushover_final_item]
            if item is not None
        ],
    }] if pushover_item or pushover_final_item else []
    horizontal_member_item = _horizontal_seismic_member_force_item(analysis_summary)
    horizontal_member_group = [{
        'name': '水平地震作用校核',
        'items': [horizontal_member_item],
    }] if horizontal_member_item else []
    combination_item = _member_design_action_combination_item(analysis_summary)
    combination_group = [{
        'name': '抗震基本作用组合校核',
        'items': [combination_item] + _member_design_action_combination_capacity_items(analysis_summary, element_data),
    }] if combination_item else []

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

    time_history_items: List[Dict[str, Any]] = []
    required_time_history_item = _required_time_history_item(method_decision, time_history, ground_motion_requirement)
    if required_time_history_item:
        time_history_items.append(required_time_history_item)
    elastic_plastic_final_item = _elastic_plastic_time_history_final_compliance_item(analysis_summary)
    if elastic_plastic_final_item:
        time_history_items.append(elastic_plastic_final_item)
    if time_history:
        combination_rule_item = _time_history_combination_rule_item(time_history)
        direction_trace_item = _time_history_direction_trace_item(analysis_summary)
        time_history_items.extend([
            _minimum_required_ratio_check_item(
                '单条时程基底剪力比例',
                actual_ratio=min(finite_ratios) if finite_ratios else None,
                required_ratio=0.65,
                clause='GB/T 50011-2010(2024) 5.1.2',
                formula='V_time_history_each / V_response_spectrum >= 0.65',
            ),
            _minimum_required_ratio_check_item(
                '平均时程基底剪力比例',
                actual_ratio=average_ratio,
                required_ratio=0.80,
                clause='GB/T 50011-2010(2024) 5.1.2',
                formula='mean(V_time_history) / V_response_spectrum >= 0.80',
            ),
            _actual_ground_motion_item(_record(time_history.get('groundMotionSetChecks'))),
            _ground_motion_record_count_item(time_history, _record(time_history.get('groundMotionSetChecks'))),
            *([combination_rule_item] if combination_rule_item else []),
            *([direction_trace_item] if direction_trace_item else []),
            _ground_motion_scale_factor_item(_record(time_history.get('spectrumMatch'))),
            _ground_motion_spectrum_compatibility_item(_record(time_history.get('spectrumMatch'))),
        ])

    return [
        *design_basis_group,
        *workflow_input_group,
        *capability_group,
        *special_system_group,
        *over_limit_review_group,
        *regularity_group,
        {
            'name': '整体抗震变形验算',
            'items': [drift_item],
        },
        *modal_group,
        *long_period_group,
        *story_shear_group,
        *horizontal_member_group,
        *combination_group,
        *vertical_group,
        *pushover_group,
        {
            'name': '时程分析输入与结果校核',
            'items': time_history_items,
        },
    ] if time_history_items else [
        *design_basis_group,
        *workflow_input_group,
        *capability_group,
        *special_system_group,
        *over_limit_review_group,
        *regularity_group,
        {
            'name': '整体抗震变形验算',
            'items': [drift_item],
        },
        *modal_group,
        *long_period_group,
        *story_shear_group,
        *horizontal_member_group,
        *combination_group,
        *vertical_group,
        *pushover_group,
    ]
