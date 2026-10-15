import { beforeAll, describe, expect, test } from '@jest/globals';
import { AIMessage } from '@langchain/core/messages';
import { END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { AgentStateAnnotation } from '../../../dist/agent-langgraph/state.js';
import { createEditModelTool, createQueryModelTool, createUndoModelTool } from '../../../dist/agent-langgraph/model-tools.js';
import { executeToolsSequentially, pendingToolCalls } from '../../../dist/agent-langgraph/sequential-tools.js';
import { normalizeEngineeringModel } from '../../../dist/engineering/model-boundary.js';
import { applyModelEdits, commitModel } from '../../../dist/engineering/model-state.js';
import { createLocalStructureProtocolClient } from '../../../dist/services/structure-protocol-execution.js';

// Real edit tools and Python schema/normalization. No LLM or model-edit mock.
const protocol = createLocalStructureProtocolClient();
const tools = [createEditModelTool(), createUndoModelTool(), createQueryModelTool()];
const sectionEdit = { operation: 'update', collection: 'sections', id: 'section', values: { 'properties.Wnx': .000237 } };
const memberEdit = { operation: 'update', collection: 'elements', id: 'beam', values: { 'design.l0': 4000, 'design.beta1': 1.1 } };
const call = (id, edits, baseRevision = 1) => ({ id, name: 'edit_model', args: { baseRevision, edits } });
const message = calls => new AIMessage({ content: '', tool_calls: calls });
const receipt = value => JSON.parse(value.content);
let initial;
beforeAll(async () => {
  const model = await normalizeEngineeringModel({
    schema_version: '2.2.0', unit_system: 'SI',
    coordinate_system: { semantics: 'global-z-up', version: 1, dimension: '2d', plane: 'xz',
      dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] },
    nodes: [{ id: 'A', x: 0, y: 0, z: 0 }, { id: 'B', x: 4, y: 0, z: 0 }],
    elements: [{ id: 'beam', type: 'beam', nodes: ['A', 'B'], material: 'steel', section: 'section' }],
    materials: [{ id: 'steel', name: 'Numerical steel', E: 206000, nu: .3, rho: 7850 }],
    sections: [{ id: 'section', name: 'Numerical section', type: 'custom',
      properties: { A: .003555, Iy: .0000237, Iz: .00000158, J: .0000001 } }],
    load_cases: [{ id: 'LC1', type: 'other', loads: [] }], load_combinations: [],
  }, protocol);
  initial = commitModel({}, model, 'revision-protocol-fixture');
}, 30000);

function graph() {
  return new StateGraph(AgentStateAnnotation)
    .addNode('tools', (state, config) => executeToolsSequentially(tools, state, config))
    .addEdge(START, 'tools')
    .addConditionalEdges('tools', state => pendingToolCalls(state).length ? 'tools' : END, ['tools', END])
    .compile({ checkpointer: new MemorySaver() });
}
const config = thread => ({ configurable: { thread_id: thread, structureProtocolClient: protocol } });
const toolMessages = state => state.messages.filter(item => item.getType() === 'tool');

describe('model writes use observed revisions without automatic rebasing', () => {
  test('one edit atomically applies section and member parameters in one revision', async () => {
    const state = await graph().invoke({ ...structuredClone(initial),
      analysisResult: { runId: 'saved' }, report: { runId: 'saved' },
      messages: [message([call('combined', [sectionEdit, memberEdit])])] }, config('combined'));
    expect(state.modelRevision).toBe(2);
    expect(state.modelHistory).toHaveLength(2);
    expect(state.model.sections[0].properties.Wnx).toBe(.000237);
    expect(state.model.elements[0].design).toMatchObject({ l0: 4000, beta1: 1.1 });
    expect(receipt(toolMessages(state)[0])).toMatchObject({ success: true, changed: true, revision: 2 });
    expect(state.analysisResult).toBeNull();
    expect(state.report).toBeNull();
    expect(initial.modelRevision).toBe(1);
    expect(initial.model.sections[0].properties.Wnx).toBeUndefined();
  }, 30000);

  test('two writes from one assistant snapshot remain sequential and reject the stale second revision', async () => {
    const state = await graph().invoke({ ...structuredClone(initial), messages: [message([
      call('section', [sectionEdit]), { id: 'inspect', name: 'query_model', args: {} }, call('member-stale', [memberEdit]),
    ])] }, config('stale-batch'));
    const messages = toolMessages(state);
    expect(messages.map(item => item.tool_call_id)).toEqual(['section', 'inspect', 'member-stale']);
    expect(receipt(messages[0])).toMatchObject({ success: true, revision: 2 });
    expect(receipt(messages[1])).toMatchObject({ revision: 2 });
    expect(messages[2].status).toBe('error');
    expect(messages[2].content).toContain('MODEL_VERSION_CONFLICT: expected 2');
    expect(state.modelRevision).toBe(2);
    expect(state.modelHistory).toHaveLength(2);
    expect(state.model.sections[0].properties.Wnx).toBe(.000237);
    expect(state.model.elements[0].design?.l0).toBeUndefined();
    expect(pendingToolCalls(state)).toEqual([]);
  }, 30000);

  test('a later assistant message can edit and undo with the actual returned revision', async () => {
    const application = graph(), options = config('observed-revision');
    const first = await application.invoke({ ...structuredClone(initial), messages: [message([call('first', [sectionEdit])])] }, options);
    const nextRevision = receipt(toolMessages(first).at(-1)).revision;
    const second = await application.invoke({ messages: [message([call('next', [memberEdit], nextRevision)])] }, options);
    expect(second.modelRevision).toBe(3);
    expect(second.model.sections[0].properties.Wnx).toBe(.000237);
    expect(second.model.elements[0].design.l0).toBe(4000);
    const undone = await application.invoke({ messages: [message([{ id: 'undo', name: 'undo_model',
      args: { baseRevision: receipt(toolMessages(second).at(-1)).revision } }])] }, options);
    expect(undone.modelRevision).toBe(4);
    expect(undone.model.sections[0].properties.Wnx).toBe(.000237);
    expect(undone.model.elements[0].design?.l0).toBeUndefined();
    expect(toolMessages(undone).every(item => item.status !== 'error')).toBe(true);
  }, 30000);

  test.each(['edit_model', 'undo_model'])('an external edit cannot be overwritten by a queued stale %s', async name => {
    const queued = message([{ id: 'queued', name,
      args: { baseRevision: 1, ...(name === 'edit_model' ? { edits: [memberEdit] } : {}) } }]);
    const changed = applyModelEdits(initial.model, [{ operation: 'update', collection: 'nodes', id: 'B', values: { x: 5 } }]);
    const external = commitModel(initial, changed, 'external-user-edit');
    const state = { ...external, messages: [queued], analysisResult: { runId: 'external-result' }, report: { runId: 'external-result' } };
    const before = structuredClone(state.model);
    const result = await executeToolsSequentially(tools, state, config(`external-${name}`));
    expect(result.update.messages[0].status).toBe('error');
    expect(result.update.messages[0].content).toContain('MODEL_VERSION_CONFLICT: expected 2');
    for (const key of ['model', 'modelRevision', 'modelHistory', 'analysisResult', 'report']) expect(result.update).not.toHaveProperty(key);
    expect(state.model).toEqual(before);
    expect(state.model.nodes.find(item => item.id === 'B').x).toBe(5);
  });
});
