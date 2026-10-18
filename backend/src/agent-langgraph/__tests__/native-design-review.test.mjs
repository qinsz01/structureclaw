import { afterAll, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { randomUUID } from 'node:crypto';
import { END, START, StateGraph } from '@langchain/langgraph';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-design-review-'));
process.env.SCLAW_DATA_DIR = directory;
const { LangGraphAgentService } = await import('../../../dist/agent-langgraph/agent-service.js');
const { AgentStateAnnotation } = await import('../../../dist/agent-langgraph/state.js');
const { FileCheckpointer } = await import('../../../dist/agent-langgraph/file-checkpointer.js');
const { resolveApplicationRunPolicy } = await import('../../../dist/runtime/policy-settings.js');
const { createRunContext, snapshotRunUsage } = await import('../../../dist/runtime/run-context.js');
const { beginAnalysisRequest, currentAnalysisError, modelHash } = await import('../../../dist/engineering/model-state.js');
const { createQueryResultsTool } = await import('../../../dist/agent-langgraph/model-tools.js');
const { createGenerateReportTool } = await import('../../../dist/agent-langgraph/tools.js');
const { nativeDesignOptions, nativeDesignReview, savedNativeDesignRecord } = await import('../../../dist/engineering/native-design-options.js');
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
const model = { nodes: [{ id: 'A', x: 0, y: 0, z: 0 }], elements: [], sections: [], materials: [{ id: 'c', type: 'concrete', E: 30000 }], load_cases: [] };
const request = { requested: true, mode: 'required-reinforcement', code: 'PKPM-2025R2.5-native', adoptedNativeDefaults: true, parameters: {} };
function designRun(runId, meta, design = request) {
  return { runId, success: true, modelSnapshot: model, selectedResultKey: 'case:D', meta: { ...meta, engineId: 'builtin-pkpm', requestParameters: { design } },
    data: { displacements: { A: { ux: 0, uy: 0, uz: 0 } }, nativeDesignContext: { request: design, status: 'completed', eligibleForConclusion: true,
      effectiveParameters: { beamCoverMm: { value: 25, unit: 'mm' } }, combinationScope: 'software-automatic-design-combinations' },
    nativeDesignResults: { status: 'completed', records: [{ elementId: 'B', component: 'top', requiredArea: 550, unit: 'mm2', nativeCombination: { id: 2 }, source: { method: 'documented-test-sdk-field' } }] } } };
}
async function setup(enabled = ['run_code_check', 'generate_report']) {
  const id = randomUUID(), graphConfig = { configurable: { thread_id: id } };
  const policy = resolveApplicationRunPolicy({ availableSkillIds: ['generic'], requested: { skillIds: ['generic'], tools: { enabledIds: enabled } } });
  const runtime = createRunContext(policy, { journalDir: path.join(directory, 'run-records') });
  const graph = new StateGraph(AgentStateAnnotation).addNode('agent', () => ({})).addEdge(START, 'agent').addEdge('agent', END)
    .compile({ checkpointer: new FileCheckpointer(path.join(directory, 'checkpoints')) });
  const service = new LangGraphAgentService({ listSkillManifests: async () => [{ id: 'generic' }],
    resolveCodeCheckDesignCodeFromSkillIds: () => undefined, resolveCodeCheckSkillId: () => undefined });
  service.getGraph = async () => graph;
  const initial = { model, modelRevision: 3, runPolicy: policy, runUsage: snapshotRunUsage(runtime), selectedSkillIds: ['generic'] };
  const pending = beginAnalysisRequest(initial, 'initial-settings');
  const analysis = { runId: 'initial', success: true, modelSnapshot: model, selectedResultKey: 'case:D', data: { displacements: { A: { ux: .001, uy: 0, uz: 0 } } }, meta: { ...pending.analysisRequest, engineId: 'builtin-pkpm' } };
  await graph.updateState(graphConfig, { ...initial, ...pending, analysisResult: analysis, analysisRuns: { initial: analysis } }, 'agent');
  return { id, graphConfig, graph, service, runtime };
}

test('descriptions expose actual input boundaries without promising model acceptance', () => {
  const pkpm = nativeDesignOptions('pkpm', model);
  expect(pkpm.codes).toEqual(['PKPM-2025R2.5-native']);
  expect(pkpm.descriptionScope).toBe('request-options-not-native-acceptance');
  expect(pkpm.parameters.find(row => row.key === 'beamStirrupSpacingMm')).toMatchObject({ min: 100, max: 100 });
  const yjk = nativeDesignOptions('yjk', { materials: [{ type: 'steel' }] });
  expect(yjk.codes).toEqual(['GB50017-2017']); expect(yjk.modes).toEqual(['code-check']);
  expect(yjk.parameters.map(row => row.key)).toEqual(['steelColumnSwayX', 'steelColumnSwayY']);
  expect(nativeDesignOptions('opensees', model)).toBeNull();
});

test('failed attempts never replace accepted design records; changed revisions and unrequested raw data are excluded', () => {
  const meta = { modelHash: modelHash(model), modelRevision: 3, requestSequence: 1 };
  const accepted = designRun('accepted', meta);
  const failed = { ...designRun('failed', { ...meta, requestSequence: 2 }), success: false, data: {}, error_code: 'ANALYSIS_INPUT_REQUIRED', message: 'Explicit cover required' };
  const state = { model, modelRevision: 3, analysisResult: failed, analysisRuns: { accepted, failed }, analysisRequest: { ...meta, settingsHash: 'x' } };
  const view = nativeDesignReview(state, ['run_code_check']);
  expect(view.acceptedRecords).toHaveLength(1);
  expect(view.acceptedRecords[0]).toMatchObject({ complianceStatus: 'not_evaluated', reinforcementScope: 'required-not-installed', current: false });
  expect(view.latestAttempt).toMatchObject({ completionStatus: 'incomplete', errorCode: 'ANALYSIS_INPUT_REQUIRED', message: 'Explicit cover required' });
  expect(nativeDesignReview({ ...state, modelRevision: 4 }, ['run_code_check']).acceptedRecords).toEqual([]);
  expect(savedNativeDesignRecord({ ...accepted, modelSnapshot: { ...model, nodes: [] } })).toBeNull();
  expect(savedNativeDesignRecord({ ...accepted, meta: { ...meta, engineId: 'builtin-pkpm' }, data: { nativeDesignResults: accepted.data.nativeDesignResults } })).toBeNull();
});

test('native design shares the conversation lock, saved scope and budget; stale or injected historical models do not execute', async () => {
  const { id, service, graph, graphConfig } = await setup();
  const calls = [];
  service.engineClient = { post: async (_url, payload) => { calls.push(payload); return { data: designRun('designed', payload.requestBinding, payload.parameters.design) }; } };
  const before = await service.getResultReview(id);
  expect(before.nativeDesign.available).toBe(true);
  await expect(service.invokeResultReviewTool(id, { revisionToken: before.revisionToken, tool: 'run_code_check', args: { provider: 'native', runId: 'someone-else' } })).rejects.toThrow('ARGUMENTS_REQUIRED');
  const release = await service.sessionLock.acquire(id);
  let settled = false;
  const task = service.invokeResultReviewTool(id, { revisionToken: before.revisionToken, tool: 'run_code_check',
    args: { designCode: request.code, provider: 'native', design: { mode: request.mode, adoptedNativeDefaults: true, parameters: { beamCoverMm: 25 } } } }).then(value => { settled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 20)); expect(settled).toBe(false); expect(calls).toHaveLength(0); release();
  const response = await task;
  expect(response.success).toBe(true); expect(calls).toHaveLength(1);
  expect(calls[0].model).toEqual(model); expect(calls[0].engineId).toBe('builtin-pkpm');
  expect(response.review.nativeDesign.acceptedRecords[0].complianceStatus).toBe('not_evaluated');
  const state = (await graph.getState(graphConfig)).values;
  expect(state.runUsage).toMatchObject({ toolCalls: 1, llmCalls: 0, recoveries: 0 });
  expect(state.messages).toEqual([]); expect(state.model).toEqual(model);
  await expect(service.invokeResultReviewTool(id, { revisionToken: before.revisionToken, tool: 'run_code_check', args: { provider: 'native' } })).rejects.toThrow('REVISION_CONFLICT');
  await graph.updateState(graphConfig, { toolAccessPolicy: { enabledToolIds: [], disabledToolIds: [], fileAccessAllowlist: null } });
  await expect(service.invokeResultReviewTool(id, { revisionToken: (await service.getResultReview(id)).revisionToken, tool: 'run_code_check', args: { provider: 'native' } })).rejects.toThrow('TOOL_NOT_ALLOWED');
  expect(calls).toHaveLength(1);
});

test.each(['en', 'zh'])('historical design report binds to its saved run after a later failed attempt (%s)', async locale => {
  const { id, service, graph, graphConfig } = await setup(['generate_report']);
  const binding = { modelHash: modelHash(model), modelRevision: 3, requestSequence: 2, settingsHash: 'native' };
  const accepted = designRun('accepted', binding);
  const failed = { ...designRun('failed', { ...binding, requestSequence: 3 }), success: false, data: {}, error_code: 'ANALYSIS_INPUT_REQUIRED' };
  await graph.updateState(graphConfig, { analysisRuns: { accepted, failed }, analysisResult: failed, analysisRequest: { ...binding, requestSequence: 3 },
    codeCheckResult: { completionStatus: 'incomplete', meta: { runId: 'failed' } } });
  const before = await service.getResultReview(id);
  const response = await service.invokeResultReviewTool(id, { revisionToken: before.revisionToken, tool: 'generate_report',
    args: { message: 'Design report', analysisType: 'static', locale, selection: { runId: 'accepted' }, narrative: 'structured' } });
  expect(response.success).toBe(true);
  expect(response.result.report.json.meta.runId).toBe('accepted');
  expect(response.result.report.markdown).toContain('550');
  expect(response.result.report.markdown).toContain(locale === 'en' ? 'installed reinforcement' : '已有配筋');
  const after = (await graph.getState(graphConfig)).values;
  expect(after.analysisResult.runId).toBe('failed'); expect(after.codeCheckResult.meta.runId).toBe('failed');
  expect(after.runUsage).toMatchObject({ toolCalls: 1, llmCalls: 0 });
});

test.each(['ANALYSIS_INPUT_REQUIRED', 'ANALYSIS_UNSUPPORTED', 'ANALYSIS_EXECUTION_FAILED'])(
  'native design %s retains current analysis and allows a complete retry without re-analysis', async errorCode => {
    const { id, service, graph, graphConfig } = await setup();
    await graph.updateState(graphConfig, { codeCheckResult: { meta: { runId: 'initial' }, completionStatus: 'complete' }, report: { markdown: 'old design report' } });
    service.engineClient = { post: async (_url, payload) => ({ data: {
      ...designRun('failed-design', payload.requestBinding, payload.parameters.design), success: false, data: {},
      error_code: errorCode, message: 'Native design did not complete',
    } }) };
    const before = await service.getResultReview(id);
    const args = { designCode: request.code, provider: 'native', design: { mode: request.mode, adoptedNativeDefaults: true } };
    const failure = await service.invokeResultReviewTool(id, { revisionToken: before.revisionToken, tool: 'run_code_check', args });
    expect(failure.success).toBe(false);
    const state = (await graph.getState(graphConfig)).values;
    expect(state.analysisResult.runId).toBe('initial');
    expect(currentAnalysisError(state)).toBeUndefined();
    expect(state.analysisRequest.requestSequence).toBe(1); expect(state.analysisRequestSequence).toBe(2);
    expect(state.analysisRuns['failed-design'].error_code).toBe(errorCode);
    expect(state.codeCheckResult).toBeNull(); expect(state.report).toBeNull();
    expect(failure.review.nativeDesign.available).toBe(true);
    expect(failure.review.nativeDesign.latestAttempt.errorCode).toBe(errorCode);
    const query = await createQueryResultsTool().invoke({ field: 'displacements', nodeId: 'A', component: 'ux', unit: 'mm', quantityId: 'retained' },
      { toolCall: { id: 'query' }, configurable: { agentState: state } });
    expect(query.update.resultQuantities['initial:retained'].value).toBe(1);
    for (const locale of ['en', 'zh']) {
      const report = await createGenerateReportTool({}).invoke({ message: 'Analysis only', analysisType: 'static', narrative: 'structured', locale },
        { toolCall: { id: 'report' }, configurable: { agentState: state } });
      expect(report.update.report.json.meta.runId).toBe('initial');
      expect(report.update.report.json.codeCheck).toBeNull();
    }
    service.engineClient = { post: async (_url, payload) => {
      const run = designRun('complete-design', payload.requestBinding, payload.parameters.design);
      run.data.nativeDesignResults.checks = [{ status: 'fail', source: { method: 'SDK' }, nativeCombination: 12 }];
      return { data: run };
    } };
    const retry = await service.invokeResultReviewTool(id, { revisionToken: failure.review.revisionToken, tool: 'run_code_check', args });
    expect(retry.success).toBe(true);
    const updated = (await graph.getState(graphConfig)).values;
    expect(updated.analysisResult.runId).toBe('complete-design');
    expect(updated.analysisRequest.requestSequence).toBe(3); expect(currentAnalysisError(updated)).toBeUndefined();
    expect(updated.codeCheckResult).toMatchObject({ completionStatus: 'complete', complianceStatus: 'fail', meta: { runId: 'complete-design' } });
  });

test.each(['connection lost', 'cancelled by owner'])('native design transport error keeps solved physics and clears obsolete design (%s)', async message => {
  const { id, service, graph, graphConfig } = await setup();
  await graph.updateState(graphConfig, { codeCheckResult: { meta: { runId: 'initial' }, completionStatus: 'complete' }, report: { markdown: 'old design report' } });
  service.engineClient = { post: async () => { throw new Error(message); } };
  const before = await service.getResultReview(id);
  const response = await service.invokeResultReviewTool(id, { revisionToken: before.revisionToken, tool: 'run_code_check',
    args: { designCode: request.code, provider: 'native' } });
  expect(response.success).toBe(false);
  const state = (await graph.getState(graphConfig)).values;
  expect(state.analysisResult.runId).toBe('initial'); expect(currentAnalysisError(state)).toBeUndefined();
  expect(state.analysisRequestSequence).toBe(2); expect(state.codeCheckResult).toBeNull(); expect(state.report).toBeNull();
  expect(response.review.nativeDesign.available).toBe(true);
});

test('aborting native design preserves the completed analysis and clears prior design artifacts', async () => {
  const { id, service, graph, graphConfig } = await setup();
  await graph.updateState(graphConfig, { codeCheckResult: { meta: { runId: 'initial' }, completionStatus: 'complete' }, report: { markdown: 'old design report' } });
  const controller = new AbortController();
  service.engineClient = { post: async () => {
    controller.abort(new Error('Design cancelled'));
    throw controller.signal.reason;
  } };
  const before = await service.getResultReview(id);
  await service.invokeResultReviewTool(id, { revisionToken: before.revisionToken, tool: 'run_code_check', signal: controller.signal,
    args: { designCode: request.code, provider: 'native' } }).catch(error => { expect(error.message).toMatch(/cancel|abort/i); });
  const state = (await graph.getState(graphConfig)).values;
  expect(state.analysisResult.runId).toBe('initial'); expect(currentAnalysisError(state)).toBeUndefined();
  expect(state.analysisRequestSequence).toBe(2); expect(state.codeCheckResult).toBeNull(); expect(state.report).toBeNull();
});

test('a placeholder-stiffness run reports native design unavailable with its reason', () => {
  const placeholderModel = { ...model, metadata: { stiffnessPlaceholder: { material: true, section: true } } };
  const run = { ...designRun('placeholder', { modelHash: modelHash(placeholderModel), modelRevision: 1 }), modelSnapshot: placeholderModel };
  const view = nativeDesignReview({ model: placeholderModel, modelRevision: 1, analysisResult: run }, ['run_code_check']);
  expect(view).toMatchObject({ available: false, reason: 'STIFFNESS_PLACEHOLDER_MODEL' });
});
