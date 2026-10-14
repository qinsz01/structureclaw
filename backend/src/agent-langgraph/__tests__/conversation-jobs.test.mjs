import { afterAll, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { END, START, StateGraph } from '@langchain/langgraph';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-conversation-jobs-'));
process.env.SCLAW_DATA_DIR = directory;
const { LangGraphAgentService } = await import('../../../dist/agent-langgraph/agent-service.js');
const { AgentStateAnnotation } = await import('../../../dist/agent-langgraph/state.js');
const { FileCheckpointer } = await import('../../../dist/agent-langgraph/file-checkpointer.js');
const { AnalysisExecutionService } = await import('../../../dist/services/analysis-execution.js');
const { resolveApplicationRunPolicy } = await import('../../../dist/runtime/policy-settings.js');
const { createRunContext, snapshotRunUsage, withRunContext, recordRunEvent, reserveToolCall } = await import('../../../dist/runtime/run-context.js');
afterAll(() => { if (path.dirname(directory) !== os.tmpdir()) throw new Error('Unsafe test cleanup'); fs.rmSync(directory, { recursive: true, force: true }); });

async function setup(tools = ['run_analysis', 'query_results']) {
  const id = randomUUID();
  const policy = resolveApplicationRunPolicy({ availableSkillIds: ['generic'], requested: { skillIds: ['generic'], tools: { enabledIds: tools } } });
  const runtime = createRunContext(policy, { journalDir: path.join(directory, 'run-records') });
  const graph = new StateGraph(AgentStateAnnotation).addNode('agent', () => ({})).addEdge(START, 'agent').addEdge('agent', END)
    .compile({ checkpointer: new FileCheckpointer(path.join(directory, 'checkpoints')) });
  const service = new LangGraphAgentService({ listSkillManifests: async () => [{ id: 'generic' }] });
  service.getGraph = async () => graph;
  const config = { configurable: { thread_id: id } };
  await graph.updateState(config, { runPolicy: policy, runUsage: snapshotRunUsage(runtime), selectedSkillIds: ['generic'],
    model: { name: 'current model' }, modelRevision: 8, analysisResult: { runId: 'current-run' }, report: { markdown: 'current report' } }, 'agent');
  return { id, config, graph, service, runtime };
}
function track(runtime, requestId) {
  withRunContext(runtime, () => { reserveToolCall('run_analysis', requestId); recordRunEvent({ kind: 'analysis_request', requestId, operation: 'analysis' }); });
}
const payload = requestId => ({ requestId, type: 'static', engineId: 'builtin-opensees',
  model: { nodes: [], elements: [], materials: [], sections: [], load_cases: [] }, parameters: {} });

test('cancel reaches the owned controller while chat holds its lock, rejects cross-session/stale scope, and keeps the ledger', async () => {
  const { id, config, graph, service, runtime } = await setup();
  const requestId = randomUUID(); track(runtime, requestId);
  let start; const started = new Promise(resolve => { start = resolve; });
  let aborted = false;
  const execution = new AnalysisExecutionService({ invoke: async (_request, options) => {
    start(); await new Promise((_, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true }));
  } });
  const running = execution.analyze(payload(requestId));
  await started;
  const release = await service.sessionLock.acquire(id);
  const originalLedger = fs.readFileSync(runtime.journalPath, 'utf8');
  try {
    const view = (await service.getConversationSessionSnapshot(id, 'en')).snapshot.runtime;
    expect(view.jobs[0]).toMatchObject({ status: 'running', cancellationAvailable: true });
    await expect(service.manageConversationJob('other', { requestId, action: 'cancel', expectedStateHash: view.jobs[0].stateHash })).rejects.toThrow('OUTSIDE_CONVERSATION');
    await expect(service.manageConversationJob(id, { requestId, action: 'cancel', expectedStateHash: '0'.repeat(64) })).rejects.toThrow('STATE_CHANGED');
    await graph.updateState(config, { toolAccessPolicy: { enabledToolIds: [], disabledToolIds: [], fileAccessAllowlist: null } });
    await expect(service.manageConversationJob(id, { requestId, action: 'cancel', expectedStateHash: view.jobs[0].stateHash })).rejects.toThrow('PERMISSION_DENIED');
    expect(aborted).toBe(false);
    await graph.updateState(config, { toolAccessPolicy: { enabledToolIds: null, disabledToolIds: [], fileAccessAllowlist: null } });
    expect(await service.manageConversationJob(id, { requestId, action: 'cancel', expectedStateHash: view.jobs[0].stateHash }))
      .toEqual({ requestId, status: 'cancellation_requested' });
    expect(aborted).toBe(true);
    expect(service.sessionLock.isBusy(id)).toBe(true);
    expect(fs.readFileSync(runtime.journalPath, 'utf8')).toBe(originalLedger);
  } finally { release(); await running; }
  expect((await execution.getRequest(requestId)).status).toBe('cancelled');
}, 15000);

test('unknown jobs require verified archives; restore holds the lock and only appends history, including retry after receipt publication', async () => {
  const { id, config, graph, service, runtime } = await setup();
  const requestId = randomUUID(); track(runtime, requestId);
  const input = path.join(directory, `${requestId}.json`); fs.writeFileSync(input, JSON.stringify(payload(requestId)));
  const host = fileURLToPath(new URL('../../../tests/fixtures/analysis-request-host.mjs', import.meta.url));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [host, input, 'after-compressed-archive'], { env: { ...process.env, SCLAW_DATA_DIR: directory }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', data => { error += data; }); child.on('error', reject);
    child.on('exit', code => code === 76 ? resolve() : reject(new Error(`${code}: ${error}`)));
  });
  const execution = new AnalysisExecutionService();
  const receipt = await execution.getRequest(requestId);
  expect(receipt).toMatchObject({ status: 'outcome_unknown', ownerAlive: false });
  const originalLedger = fs.readFileSync(runtime.journalPath, 'utf8');
  const nextTurn = await service.prepareRunContext({ conversationId: id, message: 'Inspect previous work' }, id);
  expect(nextTurn.usage.runId).not.toBe(runtime.usage.runId);
  expect(nextTurn.usage).toMatchObject({ toolCalls: 0, llmCalls: 0, recoveries: 0 });
  expect(nextTurn.usage.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'analysis_request', requestId,
    originRunId: runtime.usage.runId, originPolicyHash: runtime.policy.policyHash })]));
  expect(fs.readFileSync(runtime.journalPath, 'utf8')).toBe(originalLedger);
  expect((await service.getConversationSessionSnapshot(id, 'en')).snapshot.runtime.jobs[0]).toMatchObject({ requestId, status: 'outcome_unknown', recoveryAvailable: true });
  await expect(service.manageConversationJob(id, { requestId, action: 'cancel', expectedStateHash: receipt.stateHash })).rejects.toThrow('NOT_OWNED');
  const before = (await graph.getState(config)).values;
  const ledger = fs.readFileSync(nextTurn.journalPath, 'utf8');
  // Emulate a prior recovery process ending between receipt commit and graph history commit.
  const completed = await execution.recoverRequest(requestId, receipt.stateHash);
  expect((await service.getConversationSessionSnapshot(id, 'en')).snapshot.runtime.jobs[0].recoveryAvailable).toBe(true);
  const release = await service.sessionLock.acquire(id);
  let settled = false;
  const action = service.manageConversationJob(id, { requestId, action: 'recover', expectedStateHash: completed.stateHash }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(settled).toBe(false); release();
  expect(await action).toMatchObject({ status: 'history_restored', runId: receipt.runId });
  const after = (await graph.getState(config)).values;
  for (const field of ['model', 'modelRevision', 'analysisResult', 'report', 'runPolicy', 'runUsage', 'messages']) expect(after[field]).toEqual(before[field]);
  expect(after.analysisRuns[receipt.runId].data.marker).toBe('completed-once');
  expect(fs.readFileSync(nextTurn.journalPath, 'utf8')).toBe(ledger);
  // A new turn changes its ledger, but completed job ownership remains in the existing analysis history.
  const next = createRunContext(runtime.policy, { journalDir: path.join(directory, 'run-records') });
  await graph.updateState(config, { runUsage: snapshotRunUsage(next) });
  expect((await service.getConversationSessionSnapshot(id, 'en')).snapshot.runtime.jobs[0]).toMatchObject({ requestId, inHistory: true, recoveryAvailable: false });
}, 45000);

test('missing archives remain unresolved and native design jobs require their own tool permission', async () => {
  const { id, config, graph, service, runtime } = await setup();
  const requestId = randomUUID(), runId = randomUUID();
  withRunContext(runtime, () => recordRunEvent({ kind: 'analysis_request', requestId, operation: 'native-design' }));
  const requestFile = path.join(directory, 'analysis-requests', `${requestId}.json`);
  fs.mkdirSync(path.dirname(requestFile), { recursive: true });
  // This test process owns a completed receipt but no archive; no solver is invoked by either path.
  fs.writeFileSync(requestFile, JSON.stringify({ requestId, runId, status: 'completed', requestHash: 'missing', ownerPid: process.pid }));
  const receipt = await new AnalysisExecutionService().getRequest(requestId);
  await expect(service.manageConversationJob(id, { requestId, action: 'recover', expectedStateHash: receipt.stateHash })).rejects.toThrow('PERMISSION_DENIED');
  const policy = resolveApplicationRunPolicy({ availableSkillIds: ['generic'], requested: { skillIds: ['generic'], tools: { enabledIds: ['run_code_check', 'query_results'] } } });
  const next = createRunContext(policy, { journalDir: path.join(directory, 'run-records') });
  withRunContext(next, () => recordRunEvent({ kind: 'analysis_request', requestId, operation: 'native-design' }));
  await graph.updateState(config, { runPolicy: policy, runUsage: snapshotRunUsage(next) });
  await expect(service.manageConversationJob(id, { requestId, action: 'recover', expectedStateHash: receipt.stateHash })).rejects.toThrow('RUN_NOT_FOUND');
  expect((await graph.getState(config)).values.analysisRuns).toEqual({});
  expect(JSON.parse(fs.readFileSync(requestFile, 'utf8')).status).toBe('completed');
});
