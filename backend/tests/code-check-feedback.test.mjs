import { expect, test } from '@jest/globals';
import { codeCheckFeedback, codeCheckDeliveryNotice, validateServiceabilitySelection } from '../dist/engineering/code-checks.js';
import { createRunCodeCheckTool } from '../dist/agent-langgraph/tools.js';
import { beginAnalysisRequest } from '../dist/engineering/model-state.js';
import { prepareEngineeringReport, finishEngineeringReport } from '../dist/services/engineering-report.js';

test.each(['incomplete', 'fail'])('a report cannot accept a fabricated pass narrative for %s checks', status => {
  const check = { completionStatus: status === 'fail' ? 'complete' : 'incomplete', complianceStatus: status,
    summary: { total: 1, passed: 0, failed: status === 'fail' ? 1 : 0, inputRequired: status === 'incomplete' ? 1 : 0 }, meta: { runId: 'run' } };
  const prepared = prepareEngineeringReport({ message: 'report', analysisType: 'static', locale: 'zh',
    analysis: { success: true, runId: 'run', meta: {} }, codeCheck: check });
  const result = finishEngineeringReport(prepared, 'FALSE_PASS_SENTINEL: all requirements met');
  expect(result.markdown).not.toContain('FALSE_PASS_SENTINEL');
  expect(result.json.codeCheck.complianceStatus).toBe(status);
});

test('feedback deduplicates missing fields across cases while keeping member and check identities', () => {
  const result = { completionStatus: 'incomplete', complianceStatus: 'incomplete', summary: { inputRequired: 2 },
    details: ['case:D', 'case:L'].map(resultKey => ({ elementId: 'beam', resultKey,
      checks: [{ items: [{ item: '正应力', status: 'input_required', missingInputs: [{ field: 'material.design.f', label: 'Design strength', unit: 'MPa', source: 'design' }] }] }] })) };
  const feedback = codeCheckFeedback(result);
  expect(feedback.missingInputs).toHaveLength(1);
  expect(feedback.missingInputs[0]).toMatchObject({ elementId: 'beam', field: 'material.design.f', resultKeys: ['case:D', 'case:L'] });
  expect(feedback.conclusionEligible).toBe(false);
  expect(codeCheckDeliveryNotice(result, 'zh')).toContain('不能给出设计合格结论');
  expect(codeCheckDeliveryNotice({ completionStatus: 'complete', complianceStatus: 'fail', summary: { failed: 1 } }, 'en')).toContain('failed items');
});

test('OpenSees native-design mismatch explains the correct provider without submitting a commercial job', async () => {
  const state = { model: { nodes: [], elements: [], materials: [], sections: [] }, modelRevision: 1 };
  state.analysisRequest = beginAnalysisRequest(state, 'fixture').analysisRequest;
  state.analysisResult = { success: true, meta: { ...state.analysisRequest, engineId: 'builtin-opensees' } };
  const runtime = { resolveCodeCheckDesignCodeFromSkillIds: () => 'GB50017', resolveCodeCheckSkillId: () => 'code-check-gb50017' };
  const result = await createRunCodeCheckTool(runtime).invoke({ designCode: 'GB50017', provider: 'native', design: { mode: 'code-check' } },
    { toolCall: { id: 'native-mismatch' }, configurable: { agentState: state } });
  const payload = JSON.parse(result.update.messages[0].content);
  expect(payload).toMatchObject({ success: false, errorCode: 'NATIVE_DESIGN_ENGINE_REQUIRED', engine: 'opensees', allowedProviders: ['auto', 'builtin'] });
  expect(payload.messageZh).toContain('不是 StructureClaw 需要付费版本');
});

test('feedback locates shared material and section owners and states explicit input-to-model unit conversion', () => {
  const model = { elements: ['1','2'].map(id => ({ id, material:'steel', section:'s' })) };
  const check = { details: ['1','2'].map(elementId => ({ elementId, resultKey:'case:S', checks:[{ items:[{ item:'design', status:'input_required', missingInputs:[
    { field:'material.design.f', unit:'MPa' }, { field:'section.S', unit:'mm3' }, { field:'response.deflection', unit:'mm', source:'result' },
  ] }] }] })) };
  const feedback = codeCheckFeedback(check, model, { results:{'case:S':{}} });
  expect(feedback.writeTargets).toEqual(expect.arrayContaining([
    expect.objectContaining({ collection:'materials', id:'steel', path:'design.f', modelUnit:'MPa', elementIds:['1','2'] }),
    expect.objectContaining({ collection:'sections', id:'s', path:'properties.S', modelUnit:'m3', inputToModelScale:1e-9, elementIds:['1','2'] }),
  ]));
  expect(feedback.writeTargets).toHaveLength(2);
  expect(feedback.missingInputs.filter(row => row.field === 'response.deflection').every(row => row.writable === false)).toBe(true);
});

test('a misspelled or absent service result key is rejected before any check is made inapplicable', () => {
  const model = { elements:[{id:'beam', design:{ serviceability_result_keys:['case:S'] }}] };
  expect(() => validateServiceabilitySelection(model, { results:{'case:S':{},'combination:ULS':{}} })).not.toThrow();
  expect(() => validateServiceabilitySelection(model, { results:{'combination:ULS':{}} })).toThrow(/SERVICEABILITY_RESULT_UNAVAILABLE/);
});



test('missing computed responses lead to analysis inspection, while unselected service cases request design clarification', () => {
  const make = fields => ({ completionStatus: 'incomplete', complianceStatus: 'incomplete',
    details: [{ elementId: 'B1', checks: [{ items: [{ item: '挠度', status: 'input_required', missingInputs: fields }] }] }] });
  const response = { field: 'response.deflection', unit: 'mm', source: 'result' };
  expect(codeCheckFeedback(make([response])).nextAction).toBe('inspect_analysis');
  expect(codeCheckFeedback(make([response, { field: 'member.design.serviceability_result_keys', source: 'design' }])).nextAction).toBe('ask_user_clarification');
  expect(codeCheckFeedback({ completionStatus: 'incomplete', summary: { unsupported: 1 } }).nextAction).toBe('inspect_capability');
});

test.each(['zh', 'en'])('selected checks are reported as a limited scope in %s, never complete design compliance', locale => {
  const check = { completionStatus: 'complete', complianceStatus: 'pass', summary: { total: 7, passed: 1, notApplicable: 6 },
    checkScope: { mode: 'selected', limited: true, elements: { B1: { requestedChecks: ['正应力'], omittedChecks: ['整体稳定'] } } }, meta: { runId: 'run' } };
  const feedback = codeCheckFeedback(check);
  expect(feedback.conclusionEligible).toBe(false);
  expect(feedback.requestedChecksPassed).toBe(true);
  expect(feedback.nextAction).toBe('generate_report');
  const notice = codeCheckDeliveryNotice(check, locale);
  expect(notice).toContain('正应力');
  expect(notice).toContain(locale === 'zh' ? '其余项目未校核' : 'Other checks were not requested');
  const prepared = prepareEngineeringReport({ message: 'report selected checks', analysisType: 'static', locale,
    analysis: { success: true, runId: 'run', meta: {} }, codeCheck: check });
  const report = finishEngineeringReport(prepared, 'FALSE_FULL_DESIGN_PASS_SENTINEL');
  expect(report.markdown).not.toContain('FALSE_FULL_DESIGN_PASS_SENTINEL');
  expect(report.markdown).toContain(locale === 'zh' ? '未请求项目未校核' : 'Unrequested checks were not performed');
  expect(report.json.codeCheck.checkScope).toEqual(check.checkScope);
});
