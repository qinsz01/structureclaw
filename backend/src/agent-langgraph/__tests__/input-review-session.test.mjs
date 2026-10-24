import { afterAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { Command, END, START, StateGraph } from '@langchain/langgraph';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-input-review-'));
process.env.SCLAW_DATA_DIR = temporary;
const { LangGraphAgentService } = await import('../../../dist/agent-langgraph/agent-service.js');
const { AgentStateAnnotation } = await import('../../../dist/agent-langgraph/state.js');
const { FileCheckpointer } = await import('../../../dist/agent-langgraph/file-checkpointer.js');
const { createAskUserClarificationTool } = await import('../../../dist/agent-langgraph/tools.js');
const { executeToolsSequentially } = await import('../../../dist/agent-langgraph/sequential-tools.js');
const { resolveApplicationRunPolicy } = await import('../../../dist/runtime/policy-settings.js');
const { createRunContext, snapshotRunUsage, withRunContext, recordRunEvent, reserveToolCall } = await import('../../../dist/runtime/run-context.js');
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));
const source = { id: 's1', field: 'file:appendix.csv:fields', required: true, status: 'unread', requirement: 'field-mapping',
  source: { file: 'appendix.csv', parser: 'csv-parse', complete: true, sha256: 'source-hash' } };

function setup(enabled = ['review_input', 'query_model', 'ask_user_clarification']) {
  const policy = resolveApplicationRunPolicy({ availableSkillIds: ['generic'], requested: { skillIds: ['generic'], tools: { enabledIds: enabled } } });
  const runtime = createRunContext(policy, { journalDir: path.join(temporary, 'run-records') });
  const ask = createAskUserClarificationTool();
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('agent', () => ({ messages: [new AIMessage({ content: '', tool_calls: [{ id: 'question', name: 'ask_user_clarification', args: { question: 'Support?' } }] })] }))
    .addNode('tools', (state, config) => withRunContext(config.configurable?.runContext ?? runtime, () => executeToolsSequentially([ask], state, config)))
    .addEdge(START, 'agent').addEdge('agent', 'tools').addEdge('tools', END).compile({ checkpointer: new FileCheckpointer(path.join(temporary, 'checkpoints')) });
  const service = new LangGraphAgentService({ listSkillManifests: async () => [{ id: 'generic' }] });
  service.getGraph = async () => graph;
  const initial = { runPolicy: policy, runUsage: snapshotRunUsage(runtime), selectedSkillIds: ['generic'], inputEvidence: [source] };
  return { service, graph, initial, runtime };
}
describe('same-conversation input review', () => {
  test.each(['json', 'malformed', 'array'])('pending clarification optionsJson is readable without modifying its checkpoint (%s)', async format => {
    const { service, graph, initial } = setup();
    const id = `historical-choice-objects-${format}`;
    const choices = [{ label: 'Q235, 100×200 mm', value: 'different text' }, { label: 'C30, 250×500 mm' }];
    const optionsJson = format === 'array' ? choices : JSON.stringify(choices) + (format === 'malformed' ? '}' : '');
    await graph.updateState({ configurable: { thread_id: id } }, { ...initial, messages: [new AIMessage({ content: '',
      tool_calls: [{ id: 'old-ask', name: 'ask_user_clarification', args: { question: 'Material?', optionsJson } }] })] }, 'agent');
    const view = (await service.getConversationSessionSnapshot(id, 'en')).snapshot.runtime;
    expect(view).toMatchObject({ waitingForReply: true, question: 'Material?', options: ['Q235, 100×200 mm', 'C30, 250×500 mm'] });
    const saved = (await graph.getState({ configurable: { thread_id: id } })).values;
    expect(saved.messages.at(-1).tool_calls[0].args.optionsJson).toEqual(optionsJson);
  });

  test('result actions share the persisted ledger, keep the pending question and reject another conversation run', async () => {
    const {service,graph,initial,runtime}=setup(['query_results','ask_user_clarification']);
    const saved={runId:'owned',success:true,selectedResultKey:'case:D',data:{displacements:{A:{uz:-.001}}},
      modelSnapshot:{nodes:[{id:'A'}],elements:[]}};
    const id='result-paused'; const config={configurable:{thread_id:id,runContext:runtime}};
    await graph.invoke({...initial,analysisRuns:{owned:saved},resultQuantities:{previous:{value:42,unit:'kN'}}},config);
    const before=await service.getResultReview(id);
    const read=jest.spyOn(graph,'getState');
    const persist=graph.updateState.bind(graph);
    let release, entered;
    const gate=new Promise(resolve=>{release=resolve;});
    const pending=new Promise(resolve=>{entered=resolve;});
    const write=jest.spyOn(graph,'updateState').mockImplementation(async(...args)=>{
      entered(); await gate; return persist(...args);
    });
    const request=service.invokeResultReviewTool(id,{revisionToken:before.revisionToken,tool:'query_results',
      args:{runId:'owned',resultKey:'case:D',nodeId:'A',field:'displacements',component:'uz',unit:'mm',quantityId:'selected'}});
    await pending;
    const during=(await service.getConversationSessionSnapshot(id,'en')).snapshot.runtime;
    expect(during).toMatchObject({busy:true,waitingForReply:true,question:'Support?'});
    expect(during.usage.toolCalls).toBe(2);
    expect(read).toHaveBeenCalledTimes(1);
    release();
    const action=await request;
    write.mockRestore();
    read.mockRestore();
    expect(action.success).toBe(true);expect(action.result.quantity.value).toBe(-1);
    const state=(await graph.getState(config)).values;
    expect(state.resultQuantities.previous).toEqual({value:42,unit:'kN'});
    expect(action.review.revisionToken).toBe((await service.getResultReview(id)).revisionToken);
    expect(service.resultQuerySnapshots.size).toBe(0);
    expect(state.runUsage.toolCalls).toBe(2);
    expect(state.messages.at(-1).tool_calls[0].id).toBe('question');
    await expect(service.invokeResultReviewTool(id,{revisionToken:before.revisionToken,tool:'query_results',args:{runId:'owned'}})).rejects.toThrow('REVISION_CONFLICT');
    await expect(service.invokeResultReviewTool(id,{revisionToken:action.review.revisionToken,tool:'query_results',args:{runId:'some-other-run'}})).rejects.toThrow('RUN_OUTSIDE_CONVERSATION');
    expect((await graph.getState(config)).values.runUsage.toolCalls).toBe(2);
  });

  test('runtime projection reads the saved policy, current ledger and real request receipt without rewriting them', async () => {
    const { service, graph, initial, runtime } = setup(['query_model']);
    const id = 'runtime-projection';
    await graph.updateState({ configurable: { thread_id: id } }, { ...initial, modelRevision: 7 }, 'tools');
    const requestId = '399a8274-ac80-4cb4-9a1e-2661399eb6cf';
    fs.mkdirSync(path.join(temporary, 'analysis-requests'), { recursive: true });
    fs.writeFileSync(path.join(temporary, 'analysis-requests', `${requestId}.json`), JSON.stringify({ status: 'completed', runId: 'native-design-run' }));
    withRunContext(runtime, () => { reserveToolCall('query_model', 'new-query'); recordRunEvent({ kind: 'analysis_request', requestId, operation: 'native-design' }); });
    const before = fs.readFileSync(runtime.journalPath, 'utf8');
    const snapshot = (await service.getConversationSessionSnapshot(id, 'en')).snapshot.runtime;
    expect(snapshot).toMatchObject({ conversationId: id, modelRevision: 7, waitingForReply: false, busy: false,
      usage: { toolCalls: 1, recoveries: 0 }, policy: { policyHash: runtime.policy.policyHash },
      jobs: [{ requestId, kind: 'native-design', status: 'completed', runId: 'native-design-run', cancellationAvailable: false }] });
    expect(snapshot.analysis.current).toBe(false);
    expect(fs.readFileSync(runtime.journalPath, 'utf8')).toBe(before);
    expect((await graph.getState({ configurable: { thread_id: id } })).values.runUsage.toolCalls).toBe(0);
    expect((await service.getConversationSessionSnapshot('brand-new', 'en')).snapshot.runtime).toMatchObject({ policy: null, usage: null, waitingForReply: false, jobs: [] });
    await graph.updateState({ configurable: { thread_id: id } }, { runUsage: { ...initial.runUsage, toolCalls: 2 } }, 'tools');
    expect(await service.getConversationSessionSnapshot(id, 'en')).toBeUndefined(); // Do not display a rolled-back budget as usable.
    expect(fs.readFileSync(runtime.journalPath, 'utf8')).toBe(before);
  });

  test('a paused checkpoint cannot start a new turn and another conversation cannot resume it', async () => {
    const { service, graph, initial, runtime } = setup();
    await graph.invoke(initial, { configurable: { thread_id: 'awaiting', runContext: runtime } });
    const view = (await service.getConversationSessionSnapshot('awaiting', 'en')).snapshot.runtime;
    expect(view).toMatchObject({ waitingForReply: true, question: 'Support?', busy: false });
    await expect(service.runStream({ conversationId: 'awaiting', message: 'new turn' }).next()).rejects.toThrow('CONVERSATION_WAITING_FOR_REPLY');
    await expect(service.resumeStream('another', 'wrong reply').next()).rejects.toThrow('CONVERSATION_NOT_WAITING_FOR_REPLY');
    expect((await service.getConversationSessionSnapshot('awaiting', 'en')).snapshot.runtime.policy.policyHash).toBe(runtime.policy.policyHash);
    const release = await service.sessionLock.acquire('awaiting');
    expect((await service.getConversationSessionSnapshot('awaiting', 'en')).snapshot.runtime.busy).toBe(true);
    release();
  });
  test('proposes converted canonical values without silently editing the model', async () => {
    const { service, graph, initial } = setup(['review_input']);
    const id = 'review-units';
    await graph.updateState({ configurable: { thread_id: id } }, { ...initial, inputEvidence: [], model: { nodes: [{ id: 'A', x: 0 }] } }, 'tools');
    const view = await service.getInputReview(id);
    const reviewed = await service.invokeInputReviewTool(id, { revisionToken: view.revisionToken, tool: 'review_input',
      args: { resolutions: [{ field: 'nodes.A.x', value: 5000, unit: 'mm', reason: 'Drawing dimension' }] } });
    expect(reviewed.result.modelValues).toEqual([{ field: 'nodes.A.x', value: 5, unit: 'm' }]);
    expect(reviewed.review.model.nodes[0].x).toBe(0);
    expect(reviewed.review.modelPending).toBe(false);
    expect(reviewed.review.inputIssues).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('VALUE_MISMATCH') })]));
  });
  test('a newly supplied drawing/table can join this chat, while another chat file cannot', async () => {
    const { service, graph, initial } = setup(['analyze_file']);
    const id = 'supplement';
    const own = path.join(temporary, '.uploads', id);
    const other = path.join(temporary, '.uploads', 'other');
    fs.mkdirSync(own, { recursive: true }); fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(own, 'new.csv'), 'node,x\nA,6\n');
    fs.writeFileSync(path.join(other, 'private.csv'), 'node,x\nA,8\n');
    await graph.updateState({ configurable: { thread_id: id } }, { ...initial,
      toolAccessPolicy: { enabledToolIds: ['analyze_file'], disabledToolIds: [], fileAccessAllowlist: [] } }, 'tools');
    const view = await service.getInputReview(id);
    const next = await service.invokeInputReviewTool(id, { revisionToken: view.revisionToken, tool: 'analyze_file',
      args: { filePath: '.uploads/supplement/new.csv', mode: 'full' },
      initialContext: { attachments: [{ fileId: 'new', originalName: 'new.csv', relPath: '.uploads/supplement/new.csv' }] } });
    expect(next.success).toBe(true);
    expect(next.review.inputEvidence.some(item => item.source?.file === '.uploads/supplement/new.csv')).toBe(true);
    expect(next.review.runUsage.toolCalls).toBe(1);
    await expect(service.invokeInputReviewTool(id, { revisionToken: next.review.revisionToken, tool: 'analyze_file',
      args: { filePath: '.uploads/other/private.csv' },
      initialContext: { attachments: [{ fileId: 'private', originalName: 'private.csv', relPath: '.uploads/other/private.csv' }] } }))
      .rejects.toThrow('INPUT_ATTACHMENT_OUTSIDE_CONVERSATION');
    expect((await service.getInputReview(id)).runUsage.toolCalls).toBe(1);
  });
  test('writes shared evidence, keeps the ledger, rejects stale views and cannot expand tools', async () => {
    const { service, graph, initial } = setup(['review_input']);
    const id = 'review-budget';
    await graph.updateState({ configurable: { thread_id: id } }, initial, 'tools');
    const view = await service.getInputReview(id);
    expect(view.allowedTools).toEqual(['review_input']);
    const action = await service.invokeInputReviewTool(id, { revisionToken: view.revisionToken, tool: 'review_input',
      args: { excludeSources: [{ sourceFile: 'appendix.csv', reason: 'A bibliography, unrelated to this model' }] } });
    expect(action.success).toBe(true);
    expect(action.review.inputIssues).toEqual([]);
    expect(action.review.runUsage.toolCalls).toBe(1);
    expect(action.review.runUsage.llmCalls).toBe(0);
    expect((await graph.getState({ configurable: { thread_id: id } })).values.messages).toEqual([]);
    await expect(service.invokeInputReviewTool(id, { revisionToken: view.revisionToken, tool: 'review_input', args: {} }))
      .rejects.toThrow('INPUT_REVIEW_REVISION_CONFLICT');
    await expect(service.invokeInputReviewTool(id, { revisionToken: action.review.revisionToken, tool: 'query_model', args: {},
      initialContext: { enabledToolIds: ['query_model'] } })).rejects.toThrow('TOOL_NOT_ALLOWED');
    expect((await service.getInputReview(id)).runUsage.toolCalls).toBe(1);
  });
  test('review during a clarification preserves the pending question and resume consumes the revised state', async () => {
    const { service, graph, initial, runtime } = setup();
    const config = { configurable: { thread_id: 'paused-review', runContext: runtime } };
    const paused = await graph.invoke(initial, config);
    expect(paused.__interrupt__).toHaveLength(1);
    const before = await service.getInputReview('paused-review');
    expect(before.waitingForReply).toBe(true);
    const reviewed = await service.invokeInputReviewTool('paused-review', { revisionToken: before.revisionToken, tool: 'review_input',
      args: { excludeSources: [{ sourceFile: 'appendix.csv', reason: 'Unrelated notes' }] } });
    expect(reviewed.review.inputIssues).toEqual([]);
    expect(reviewed.review.waitingForReply).toBe(true);
    expect(reviewed.review.runUsage.toolCalls).toBe(2);
    const state = (await graph.getState(config)).values;
    expect(state.messages.at(-1).tool_calls[0].id).toBe('question');
    const resumedRuntime = createRunContext(runtime.policy, { runId: reviewed.review.runUsage.runId, usage: reviewed.review.runUsage,
      journalDir: path.join(temporary, 'run-records'), resume: true });
    const resumed = await graph.invoke(new Command({ resume: 'Pinned at A' }), { configurable: { ...config.configurable, runContext: resumedRuntime } });
    expect(resumed.messages.at(-1).content).toContain('Pinned at A');
    expect(resumed.inputEvidence.some(item => item.status === 'excluded')).toBe(true);
    expect(resumed.messages.filter(item => item.getType() === 'tool')).toHaveLength(1);
    expect(resumed.runUsage.toolCalls).toBe(2);
  });
});
