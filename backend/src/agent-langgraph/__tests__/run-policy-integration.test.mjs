import { describe, expect, test } from '@jest/globals';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { AgentStateAnnotation, emptySessionState } from '../../../dist/agent-langgraph/state.js';
import { executeToolsSequentially } from '../../../dist/agent-langgraph/sequential-tools.js';
import { applyToolsNodeSessionContext } from '../../../dist/agent-langgraph/graph.js';
import { buildParamExtractorPrompt } from '../../../dist/agent-langgraph/param-extractor.js';
import { buildSystemMessages } from '../../../dist/agent-langgraph/system-prompt.js';
import { createSetSessionConfigTool, createAskUserClarificationTool } from '../../../dist/agent-langgraph/tools.js';
import { resolveRunPolicy } from '../../../dist/runtime/run-policy.js';
import { createRunContext, withRunContext } from '../../../dist/runtime/run-context.js';
import { wrapWithLlmLogging } from '../../../dist/utils/llm.js';
import { Command, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
const available = { availableSkillIds: ['beam', 'generic'], availableToolIds: ['build_model', 'edit_model', 'run_analysis', 'query_results', 'query_model', 'ask_user_clarification', 'set_session_config'], defaultToolIds: ['build_model', 'edit_model', 'run_analysis', 'query_results', 'query_model', 'ask_user_clarification', 'set_session_config'] };
const policy = (requested = {}) => resolveRunPolicy({ ...available, requested });
const plugin = { id: 'beam', structureType: 'beam', stages: ['draft'], name: { zh: '梁', en: 'Beam' }, description: { zh: 'GUIDANCE_SENTINEL', en: 'GUIDANCE_SENTINEL' }, markdownByStage: { draft: 'STAGE_SENTINEL' }, domain: 'structure-type' };

describe('run policy at real orchestration boundaries', () => {
  test('knowledge removal preserves input, schema and scope while removing skill prose', () => {
    const runtime = createRunContext(policy({ knowledge: 'disabled' }));
    withRunContext(runtime, () => {
      const prompt = buildParamExtractorPrompt('en', { lengthM: 6 }, plugin, 'A beam with 12 kN');
      expect(prompt).not.toContain('GUIDANCE_SENTINEL'); expect(prompt).not.toContain('STAGE_SENTINEL');
      expect(prompt).toContain('12 kN'); expect(prompt).toContain('engineeringDraft');
      const system = buildSystemMessages({ state: { ...emptySessionState(), selectedSkillIds: ['beam'], runPolicy: runtime.policy }, skillManifests: [plugin] })[0].content;
      expect(system).not.toContain('GUIDANCE_SENTINEL'); expect(system).toContain('beam');
    });
  });
  test('an empty selected scope stays empty and set_session_config cannot widen its immutable ceiling', async () => {
    const runtime = createRunContext(policy({ skillIds: ['generic'] }));
    const state = { ...emptySessionState(), runPolicy: runtime.policy, selectedSkillIds: [], messages: [] };
    const configurable = { runContext: runtime };
    applyToolsNodeSessionContext(configurable, state);
    expect(configurable.skillScope).toEqual([]);
    const output = await withRunContext(runtime, () => createSetSessionConfigTool().invoke({ skillIdsJson: '["beam"]' }, { toolCall: { id: 'scope' }, configurable: { ...configurable, agentState: state } }));
    expect(JSON.parse(output.update.messages[0].content).error_code).toBe('SKILL_SCOPE_IMMUTABLE');
    expect(output.update.selectedSkillIds).toBeUndefined();
  });
  test('a failed model cannot be corrected by switching to another modeling tool when repair is disabled', async () => {
    const runtime = createRunContext(policy({ repair: { enabled: false } }));
    let edits = 0;
    const tools = [tool(async () => JSON.stringify({ success: false, error: 'wrong support' }), { name: 'build_model', description: 'build', schema: z.object({}) }),
      tool(async () => { edits++; return 'edited'; }, { name: 'edit_model', description: 'edit', schema: z.object({}) })];
    let state = { ...emptySessionState(), messages: [new AIMessage({ content: '', tool_calls: [{ id: 'same-id', name: 'build_model', args: {} }] })], model: null, analysisRuns: {} };
    await withRunContext(runtime, async () => {
      const first = await executeToolsSequentially(tools, state, { configurable: { runContext: runtime } });
      state = { ...state, ...first.update, messages: [...state.messages, ...first.update.messages, new AIMessage({ content: '', tool_calls: [{ id: 'same-id', name: 'edit_model', args: {} }] })] };
      const second = await executeToolsSequentially(tools, state, { configurable: { runContext: runtime } });
      expect(second.update.messages[0].content).toContain('RECOVERY_BUDGET_EXHAUSTED');
    });
    expect(edits).toBe(0);
    expect(runtime.usage.toolCalls).toBe(1);
  });
  test.each(['run_analysis', 'query_results'])('repair off blocks %s failure from being bypassed by editing; inspection and new user turns remain usable', async failedTool => {
    const value = policy({ repair: { enabled: false } });
    const runtime = createRunContext(value);
    let edits = 0, inspections = 0;
    const tools = [
      tool(async () => JSON.stringify({ success: false, error: 'deliberate failure' }), { name: failedTool, description: 'fail', schema: z.object({}) }),
      tool(async () => { edits++; return 'edited'; }, { name: 'edit_model', description: 'edit', schema: z.object({}) }),
      tool(async () => { inspections++; return 'existing model'; }, { name: 'query_model', description: 'inspect', schema: z.object({}) }),
    ];
    let state = { ...emptySessionState(), model: { retained: true }, analysisRuns: {}, messages: [] };
    let sequence = 0;
    const invoke = async (context, name) => {
      state.messages.push(new AIMessage({ content: '', tool_calls: [{ id: `call-${++sequence}`, name, args: {} }] }));
      const result = await withRunContext(context, () => executeToolsSequentially(tools, state, { configurable: { runContext: context } }));
      state = { ...state, ...result.update, messages: [...state.messages, ...result.update.messages] };
      return result;
    };
    await invoke(runtime, failedTool);
    expect((await invoke(runtime, 'edit_model')).update.messages[0].content).toContain('RECOVERY_BUDGET_EXHAUSTED');
    await invoke(runtime, 'query_model');
    expect(inspections).toBe(1);
    expect(edits).toBe(0);
    const resumed = createRunContext(value, { runId: runtime.usage.runId, usage: runtime.usage, resume: true });
    expect((await invoke(resumed, 'edit_model')).update.messages[0].content).toContain('RECOVERY_BUDGET_EXHAUSTED');
    expect(resumed.usage.recoveries).toBe(0);
    expect(edits).toBe(0);
    const newUserTurn = createRunContext(value);
    await invoke(newUserTurn, 'edit_model');
    expect(edits).toBe(1);
    expect(newUserTurn.usage.recoveries).toBe(0);
  });
  test('a graph interrupt resumes the same ledger without recounting its clarification', async () => {
    const runtime = createRunContext(policy());
    const ask = createAskUserClarificationTool();
    const graph = new StateGraph(AgentStateAnnotation).addNode('tools', (state, config) => withRunContext(runtime, () => executeToolsSequentially([ask], state, config)))
      .addEdge(START, 'tools').addEdge('tools', END).compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: 'policy-interrupt', runContext: runtime } };
    const paused = await graph.invoke({ messages: [new AIMessage({ content: '', tool_calls: [{ id: 'ask', name: 'ask_user_clarification', args: { question: 'Span?' } }] })] }, config);
    expect(paused.__interrupt__).toHaveLength(1); expect(runtime.usage.toolCalls).toBe(1);
    const resumed = await graph.invoke(new Command({ resume: '6 m' }), config);
    expect(runtime.usage.toolCalls).toBe(1);
    expect(resumed.messages.at(-1).content).toContain('6 m');
  });
  test('external clarification returns a host-owned request, never starts an unresumable local interrupt', async () => {
    const value = resolveRunPolicy({ ...available, executionOwner: 'external' });
    const output = await withRunContext(createRunContext(value), () => createAskUserClarificationTool().invoke({ question: 'Span?' }));
    expect(JSON.parse(output)).toMatchObject({ type: 'clarification_needed', nextAction: 'await_user_input' });
  });
  test('nested model usage is collected without environment flags, including errors and unknown usage', async () => {
    const runtime = createRunContext(policy());
    let attempts = 0;
    const model = wrapWithLlmLogging({ invoke: async () => { if (++attempts === 2) throw new Error('transport'); return new AIMessage({ content: 'ok', usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }); } }, () => 'local-fixture');
    await withRunContext(runtime, async () => { await model.invoke('input'); await expect(model.invoke('input')).rejects.toThrow('transport'); });
    expect(runtime.usage.llmCalls).toBe(2);
    const finished = runtime.usage.events.filter(item => item.kind === 'llm_finished');
    expect(finished[0].usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(finished[1].success).toBe(false);
    expect(finished[0]).toMatchObject({ promptChars: 5, messageCount: 1 });
    expect(finished[1]).toMatchObject({ errorCode: 'INTERNAL_ERROR', promptChars: 5, messageCount: 1 });
    expect(finished[1]).not.toHaveProperty('prompt');
  });
  test('the main model bound to tools records exactly one call and no provider request is made', async () => {
    const model = new ChatOpenAI({ apiKey: 'local-fixture', model: 'fixture', maxRetries: 0, disableStreaming: true,
      configuration: { fetch: async () => { throw new Error('network forbidden in this fixture'); } } });
    model.completions._generate = async () => ({ generations: [{ text: 'ok', message: new AIMessage('ok') }] });
    model.fields.completions = model.completions;
    const tracked = wrapWithLlmLogging(model, () => 'fixture');
    const bound = tracked.bindTools([tool(async () => 'ok', { name: 'fixture', description: 'fixture', schema: z.object({}) })]);
    const context = createRunContext(policy());
    await withRunContext(context, () => bound.invoke('input'));
    expect(context.usage.llmCalls).toBe(1);
    expect(context.usage.events.filter(item => item.kind === 'llm_finished')).toHaveLength(1);
  });
});
