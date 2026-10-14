import { expect, test } from '@jest/globals';
import { codeCheckFeedback, codeCheckDeliveryNotice } from '../dist/engineering/code-checks.js';
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
