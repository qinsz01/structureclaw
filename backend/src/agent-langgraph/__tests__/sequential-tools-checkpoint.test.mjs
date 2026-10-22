import { describe, expect, test } from '@jest/globals';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';
import { z } from 'zod';
import { AgentStateAnnotation } from '../../../dist/agent-langgraph/state.js';
import { executeToolsSequentially, pendingToolCalls } from '../../../dist/agent-langgraph/sequential-tools.js';
import { createRunContext, withRunContext } from '../../../dist/runtime/run-context.js';
import { resolveRunPolicy } from '../../../dist/runtime/run-policy.js';
import { createBuildModelTool } from '../../../dist/agent-langgraph/tools/build-model.js';
import { ModelInputRequiredError } from '../../../dist/agent-skills/structure-type/generic/llm-model-builder.js';

describe('sequential tool checkpoints', () => {
  test('the real builder input_required outcome blocks stale-model analysis and permits clarification without charging recovery', async () => {
    let analyses = 0, clarifications = 0;
    const build = createBuildModelTool({ buildModel: async () => { throw new ModelInputRequiredError(['loads.target']); } });
    const analyze = tool(async () => { analyses++; return 'should not execute'; },
      { name: 'run_analysis', description: 'analyze', schema: z.object({}) });
    const ask = tool(async () => { clarifications++; return 'Please specify the load target.'; },
      { name: 'ask_user_clarification', description: 'clarify', schema: z.object({}) });
    const graph = new StateGraph(AgentStateAnnotation)
      .addNode('tools', (state, config) => executeToolsSequentially([build, analyze, ask], state, config))
      .addEdge(START, 'tools')
      .addConditionalEdges('tools', state => pendingToolCalls(state).length ? 'tools' : END, ['tools', END]).compile();
    const runtime = createRunContext(resolveRunPolicy({ availableSkillIds: [],
      availableToolIds: ['build_model', 'run_analysis', 'ask_user_clarification'],
      defaultToolIds: ['build_model', 'run_analysis', 'ask_user_clarification'] }));
    const saved = { model: { retained: true }, modelPending: false, analysisResult: { runId: 'old-result' },
      draftState: { inferredType: 'unknown', updatedAt: 1, engineeringDraft: { structureType: 'beam' } } };
    const result = await withRunContext(runtime, () => graph.invoke({ ...saved, messages: [
      new HumanMessage('Change the load and calculate'), new AIMessage({ content: '', tool_calls: [
        { id: 'incomplete-build', name: 'build_model', args: {} }, { id: 'blocked-analysis', name: 'run_analysis', args: {} },
        { id: 'clarify-input', name: 'ask_user_clarification', args: {} },
      ] }),
    ] }));
    expect(JSON.parse(result.messages.find(message => message.tool_call_id === 'incomplete-build').content))
      .toMatchObject({ status: 'input_required', modelBuilt: false, missingFields: ['loads.target'] });
    expect(JSON.parse(result.messages.find(message => message.tool_call_id === 'blocked-analysis').content))
      .toMatchObject({ success: false, errorCode: 'MODEL_REBUILD_REQUIRED' });
    expect(analyses).toBe(0);
    expect(clarifications).toBe(1);
    expect(runtime.usage.recoveries).toBe(0);
    expect(runtime.usage.pendingFailures).toEqual({});
    for (const [key, value] of Object.entries(saved)) expect(result[key]).toEqual(value);
  });

  test('a failed physical build blocks old-model execution but permits clarification and a successful rebuild', async () => {
    let builds = 0;
    const executed = [];
    const build = tool(async () => {
      builds++;
      executed.push('build');
      if (builds === 1) throw new Error('MODEL_PHYSICS_INVALID: resolve the load location / 请明确荷载位置');
      return JSON.stringify({ success: true, modelBuilt: true });
    }, { name: 'build_model', description: 'build', schema: z.object({}) });
    const analyze = tool(async () => { executed.push('analysis'); return JSON.stringify({ success: true }); },
      { name: 'run_analysis', description: 'analyze', schema: z.object({}) });
    const ask = tool(async () => { executed.push('clarify'); return 'location supplied'; },
      { name: 'ask_user_clarification', description: 'clarify', schema: z.object({}) });
    const graph = new StateGraph(AgentStateAnnotation)
      .addNode('tools', (state, config) => executeToolsSequentially([build, analyze, ask], state, config))
      .addEdge(START, 'tools')
      .addConditionalEdges('tools', state => pendingToolCalls(state).length ? 'tools' : END, ['tools', END])
      .compile();
    const runtime = createRunContext(resolveRunPolicy({ availableSkillIds: [],
      availableToolIds: ['build_model', 'run_analysis', 'ask_user_clarification'],
      defaultToolIds: ['build_model', 'run_analysis', 'ask_user_clarification'] }));
    const result = await withRunContext(runtime, () => graph.invoke({ model: { retained: true }, analysisResult: { runId: 'old-result' }, messages: [
      new HumanMessage('Change the load and calculate'), new AIMessage({ content: '', tool_calls: [
        { id: 'failed-build', name: 'build_model', args: {} }, { id: 'blocked-analysis', name: 'run_analysis', args: {} },
        { id: 'second-blocked-analysis', name: 'run_analysis', args: {} },
        { id: 'clarify', name: 'ask_user_clarification', args: {} }, { id: 'new-build', name: 'build_model', args: {} },
        { id: 'new-analysis', name: 'run_analysis', args: {} },
      ] }),
    ] }));
    expect(executed).toEqual(['build', 'clarify', 'build', 'analysis']);
    const blocked = result.messages.find(message => message.tool_call_id === 'blocked-analysis');
    expect(JSON.parse(blocked.content)).toMatchObject({ success: false, errorCode: 'MODEL_REBUILD_REQUIRED', guard: 'failed-model-build' });
    expect(result.model).toEqual({ retained: true });
    expect(result.analysisResult).toEqual({ runId: 'old-result' });
    const newTurn = { ...result, messages: [...result.messages.slice(0, 3), new HumanMessage('Use the retained model'),
      new AIMessage({ content: '', tool_calls: [{ id: 'new-turn-analysis', name: 'run_analysis', args: {} }] })] };
    await executeToolsSequentially([analyze], newTurn, {});
    expect(executed.at(-1)).toBe('analysis');
    expect(executed.filter(name => name === 'analysis')).toHaveLength(2);
  });

  test.each(['run_analysis', 'build_model', 'extract_draft_params'])('a rejected %s cannot clear a valid result or report', async name => {
    let invoked = false;
    const operation = tool(async () => { invoked = true; throw new Error('candidate rejected'); }, {
      name, description: 'reject a candidate', schema: z.object({ revision: z.number().int() }),
    });
    for (const args of [{ revision: 'invalid' }, { revision: 1 }]) {
      const state = { messages: [new AIMessage({ content: '', tool_calls: [{ name, id: 'rejected', args }] })],
        modelRevision: 2, analysisResult: { runId: 'valid-run', success: true }, report: { runId: 'valid-run' },
        codeCheckResult: { completionStatus: 'complete' }, analysisRequest: { requestSequence: 2 } };
      const events = [];
      const result = await executeToolsSequentially([operation], state, { writer: item => events.push(item) });
      expect(result.update.messages[0].content).toMatch(/invalid|rejected/i);
      for (const key of ['analysisResult', 'report', 'codeCheckResult', 'analysisRequest']) expect(result.update).not.toHaveProperty(key);
      expect(events).toEqual([]);
      expect(state.analysisResult.runId).toBe('valid-run');
    }
    expect(invoked).toBe(true);
  });

  test('a reserved solver request still invalidates and archives results if execution throws', async () => {
    const { beginAnalysisRequest } = await import('../../../dist/engineering/model-state.js');
    const operation = tool(async (_, config) => {
      config.configurable.onAnalysisRequest(beginAnalysisRequest(config.configurable.agentState, 'new-settings'));
      throw new Error('SOLVER_OUTCOME_UNKNOWN');
    }, { name: 'run_analysis', description: 'reserve then fail', schema: z.object({}) });
    const state = { messages: [new AIMessage({ content: '', tool_calls: [{ name: 'run_analysis', id: 'reserved', args: {} }] })],
      model: { nodes: [], elements: [] }, modelRevision: 2, analysisRequestSequence: 2,
      analysisResult: { runId: 'previous-run' }, report: { runId: 'previous-run' } };
    const events = [];
    const result = await executeToolsSequentially([operation], state, { writer: item => events.push(item) });
    expect(result.update.analysisResult).toBeNull();
    expect(result.update.report).toBeNull();
    expect(result.update.analysisRequest.requestSequence).toBe(3);
    expect(result.update.analysisRuns['previous-run']).toEqual(state.analysisResult);
    expect(events).toContainEqual({ type: 'artifact_payload_sync', artifact: 'analysis', invalidated: true });
  });

  test('a clarification resume never replays an earlier committed write', async () => {
    let writes = 0;
    const observed = [];
    const write = tool(async () => {
      writes++;
      return new Command({ update: { modelRevision: 4 } });
    }, { name: 'write_model', description: 'write', schema: z.object({}) });
    const ask = tool(async () => String(interrupt({ question: 'Continue?' })), {
      name: 'ask_user_clarification', description: 'ask', schema: z.object({}),
    });
    const read = tool(async (_, config) => {
      observed.push(config.configurable.agentState.modelRevision);
      return 'read';
    }, { name: 'read_model', description: 'read', schema: z.object({}) });
    const graph = new StateGraph(AgentStateAnnotation)
      .addNode('tools', (state, config) => executeToolsSequentially([write, ask, read], state, config))
      .addEdge(START, 'tools')
      .addConditionalEdges('tools', state => pendingToolCalls(state).length ? 'tools' : END, ['tools', END])
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: 'pause-after-model-write' } };
    const paused = await graph.invoke({ modelRevision: 3, messages: [new AIMessage({ content: '', tool_calls: [
      { name: 'write_model', id: 'write', args: {} },
      { name: 'ask_user_clarification', id: 'ask', args: {} },
      { name: 'read_model', id: 'read', args: {} },
    ] })] }, config);
    expect(paused.__interrupt__).toHaveLength(1);
    expect(writes).toBe(1);
    expect(observed).toEqual([]);
    const snapshot = await graph.getState(config);
    expect(snapshot.values.modelRevision).toBe(4);
    expect(snapshot.values.messages.filter(m => m.getType() === 'tool').map(m => m.tool_call_id)).toEqual(['write']);
    const resumed = await graph.invoke(new Command({ resume: 'confirmed' }), config);
    expect(writes).toBe(1);
    expect(observed).toEqual([4]);
    expect(resumed.messages.filter(m => m.getType() === 'tool').map(m => m.tool_call_id)).toEqual(['write', 'ask', 'read']);
    expect(pendingToolCalls(resumed)).toEqual([]);
  });

  test('an earlier assistant message cannot acknowledge a later reused call id', () => {
    const call = { name: 'read_model', id: 'same-id', args: {} };
    const state = { messages: [new AIMessage({ content: '', tool_calls: [call] }),
      new ToolMessage({ content: 'old', tool_call_id: call.id }), new AIMessage({ content: '', tool_calls: [call] })] };
    expect(pendingToolCalls(state)).toEqual([call]);
  });
});
