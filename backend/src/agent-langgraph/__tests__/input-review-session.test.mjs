import { afterAll, describe, expect, test } from '@jest/globals';
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
const { createRunContext, snapshotRunUsage, withRunContext } = await import('../../../dist/runtime/run-context.js');
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
