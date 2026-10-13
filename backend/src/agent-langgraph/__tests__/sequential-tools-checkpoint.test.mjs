import { describe, expect, test } from '@jest/globals';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';
import { z } from 'zod';
import { AgentStateAnnotation } from '../../../dist/agent-langgraph/state.js';
import { executeToolsSequentially, pendingToolCalls } from '../../../dist/agent-langgraph/sequential-tools.js';

describe('sequential tool checkpoints', () => {
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
