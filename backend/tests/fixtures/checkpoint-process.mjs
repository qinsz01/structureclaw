// A real process boundary, without a model/provider call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { z } from 'zod';
import { AgentStateAnnotation } from '../../dist/agent-langgraph/state.js';
import { FileCheckpointer } from '../../dist/agent-langgraph/file-checkpointer.js';
import { executeToolsSequentially, pendingToolCalls } from '../../dist/agent-langgraph/sequential-tools.js';

const [phase, root] = process.argv.slice(2);
const countFile = path.join(root, 'committed-writes.json');
const count = () => fs.existsSync(countFile) ? JSON.parse(fs.readFileSync(countFile, 'utf8')) : 0;
const write = tool(async () => {
  fs.writeFileSync(countFile, JSON.stringify(count() + 1));
  return new Command({ update: { modelRevision: 4 } });
}, { name: 'write_model', description: 'commit model', schema: z.object({}) });
const ask = tool(async () => String(interrupt({ question: 'Confirm the support?' })), {
  name: 'ask_user_clarification', description: 'clarify support', schema: z.object({}),
});
const read = tool(async (_, config) => {
  assert.equal(config.configurable.agentState.modelRevision, 4);
  return 'revision 4';
}, { name: 'read_model', description: 'read model', schema: z.object({}) });
const saver = new FileCheckpointer(root);
const graph = new StateGraph(AgentStateAnnotation)
  .addNode('tools', (state, config) => executeToolsSequentially([write, ask, read], state, config))
  .addEdge(START, 'tools')
  .addConditionalEdges('tools', state => pendingToolCalls(state).length ? 'tools' : END, ['tools', END])
  .compile({ checkpointer: saver });
const config = { configurable: { thread_id: 'restart-after-write' } };
if (phase === 'pause') {
  const result = await graph.invoke({ modelRevision: 3, messages: [new AIMessage({ content: '', tool_calls: [
    { name: 'write_model', id: 'write', args: {} }, { name: 'ask_user_clarification', id: 'ask', args: {} },
    { name: 'read_model', id: 'read', args: {} },
  ] })] }, config);
  assert.equal(result.__interrupt__.length, 1);
} else if (phase === 'resume') {
  const snapshot = await graph.getState(config);
  assert.equal(snapshot.values.modelRevision, 4);
  assert.equal(snapshot.tasks.flatMap(task => task.interrupts ?? []).length, 1);
  const result = await graph.invoke(new Command({ resume: 'confirmed' }), config);
  assert.deepEqual(result.messages.filter(message => message.getType() === 'tool').map(message => message.tool_call_id), ['write', 'ask', 'read']);
  assert.deepEqual(pendingToolCalls(result), []);
  assert.equal(result.messages.find(message => message.tool_call_id === 'ask').content, 'confirmed');
} else if (phase === 'inspect') {
  const snapshot = await graph.getState(config);
  assert.deepEqual(snapshot.next, []);
  assert.equal(snapshot.values.modelRevision, 4);
  assert.equal(snapshot.values.messages.filter(message => message.getType() === 'tool').length, 3);
} else throw new Error('Unknown phase');
assert.equal(count(), 1, 'a previously committed tool must not execute again');
console.log(JSON.stringify({ phase, status: 'passed', committedWrites: count() }));
