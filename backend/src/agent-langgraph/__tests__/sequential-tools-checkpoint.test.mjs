import { describe, expect, test } from '@jest/globals';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';
import { z } from 'zod';
import { AgentStateAnnotation } from '../../../dist/agent-langgraph/state.js';
import { executeToolsSequentially, pendingToolCalls } from '../../../dist/agent-langgraph/sequential-tools.js';

describe('sequential tool checkpoints', () => {
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
