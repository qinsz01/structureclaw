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
  test.each([[{}, false], [{ shape: 'user', properties: 'geometry' }, false],
    [{}, true], [{ shape: 'user', properties: 'geometry' }, true]])('a verified property-only edit supersedes derived source %j (mark user=%s) and survives a later resize', async (provenance, markUser) => {
    const userInput = '矩形100×200mm';
    const original = await normalizeEngineeringModel({ ...initial.model, sections: [{ id: 'section', name: '100x200',
      type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 },
      extra: { provenance } }] }, protocol, undefined, [userInput]);
    const application = graph(), options = config('verified-property-only-then-resize-' + JSON.stringify(provenance));
    const first = await application.invoke({ ...commitModel({}, original, 'user-geometry'),
      lastUserMessage: userInput + '; J=9e-8 m4', messages: [message([call('user-J', [{ operation: 'update',
        collection: 'sections', id: 'section', values: { properties: { J: 9e-8 },
          ...(markUser ? { extra: { provenance: { properties: 'user' } } } : {}) } }])])] }, options);
    expect(receipt(toolMessages(first).at(-1)).success).toBe(true);
    expect(first.model.sections[0].properties.J).toBe(9e-8);
    const sources = first.model.sections[0].extra.provenance;
    expect(sources.propertyFields).toMatchObject({ A: 'geometry', Iy: 'geometry', Iz: 'geometry' });
    expect(sources.propertyFields.J ?? sources.properties).toBe('user');
    const resized = await application.invoke({ lastUserMessage: userInput + '; J=9e-8 m4; 高度改为300mm',
      messages: [message([call('resize-after-user-J', [{ operation: 'update', collection: 'sections', id: 'section',
        values: { shape: { H: 300 }, extra: { provenance: { shape: 'user' } } } }], first.modelRevision)])] }, options);
    expect(receipt(toolMessages(resized).at(-1)).success).toBe(true);
    expect(resized.model.sections[0].properties).toMatchObject({ A: .03, Iy: .000225, Iz: .000025, J: 9e-8 });
  }, 30000);

  test('a discarded property-only edit cannot report success or invalidate the saved analysis', async () => {
    const original = await normalizeEngineeringModel({ ...initial.model, sections: [{ id: 'section', name: '100x200',
      type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 },
      extra: { provenance: { shape: 'user', properties: 'geometry' } } }] }, protocol, undefined, ['100×200mm']);
    const state = await graph().invoke({ ...commitModel({}, original, 'user-geometry'), lastUserMessage: '100×200mm',
      analysisResult: { runId: 'saved' }, messages: [message([call('unverified-J', [{ operation: 'update',
        collection: 'sections', id: 'section', values: { properties: { J: 9e-8 } } }])])] }, config('discarded-property-only'));
    expect(toolMessages(state).at(-1).status).toBe('error');
    expect(state.model).toEqual(original);
    expect(state.modelRevision).toBe(1);
    expect(state.analysisResult).toEqual({ runId: 'saved' });
  }, 30000);

  test('a property override relinquishes only its own derived source before a later geometry edit', async () => {
    const original = await normalizeEngineeringModel({ ...initial.model, sections: [{ id: 'section', name: '100x200',
      type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 } }] }, protocol);
    const overridden = await normalizeEngineeringModel(applyModelEdits(original, [{ operation: 'update', collection: 'sections',
      id: 'section', values: { properties: { J: 9e-8 } } }]), protocol);
    expect(overridden.sections[0].extra.derived_properties.fields).toEqual(['A', 'Iy', 'Iz']);
    const resized = await normalizeEngineeringModel(applyModelEdits(overridden, [{ operation: 'update', collection: 'sections',
      id: 'section', values: { shape: { H: 300 } } }]), protocol);
    expect(resized.sections[0].properties).toMatchObject({ A: .03, Iy: .000225, Iz: .000025, J: 9e-8 });
    expect(original.sections[0].shape.H).toBe(200);
  }, 30000);

  test('removing the shape preserves the existing numerical section', async () => {
    const original = await normalizeEngineeringModel({ ...initial.model, sections: [{ id: 'section', name: '100x200',
      type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 } }] }, protocol);
    const state = await graph().invoke({ ...commitModel({}, original, 'geometry-to-numerical'),
      messages: [message([call('remove-shape', [{ operation: 'update', collection: 'sections', id: 'section',
        values: { shape: null } }])])] }, config('remove-shape-keep-properties'));
    expect(receipt(toolMessages(state)[0]).success).toBe(true);
    expect(state.model.sections[0].shape).toBeFalsy();
    expect(state.model.sections[0].properties).toEqual(original.sections[0].properties);
  }, 30000);

  test('a shape-only edit refreshes converter-derived stiffness before committing the new revision', async () => {
    // Reproduces the real-LLM 100x200 -> 100x300 edit, including absent source labels.
    const original = await normalizeEngineeringModel({ ...initial.model, sections: [{ id: 'section', name: '100x200',
      type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 } }] }, protocol);
    const saved = structuredClone(original);
    const state = await graph().invoke({ ...commitModel({}, original, 'derived-geometry'),
      analysisResult: { runId: 'old-geometry' }, messages: [message([call('height-only', [{
        operation: 'update', collection: 'sections', id: 'section', values: { 'shape.H': 300 },
      }])])] }, config('height-only-derived'));
    expect(receipt(toolMessages(state)[0])).toMatchObject({ success: true, revision: 2, analysisCurrent: false });
    expect(state.model.sections[0].properties).toMatchObject({ A: .03, Iy: .000225, Iz: .000025 });
    expect(state.model.sections[0].extra.derived_properties.shape).toEqual({ kind: 'rectangular', H: 300, B: 100 });
    expect(state.model.sections[0].extra.section_diagnostics ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SECTION_PROVENANCE_CONFLICT' }),
    ]));
    expect(state.analysisResult).toBeNull();
    expect(original).toEqual(saved);
    expect(state.modelHistory.at(-1).beforeModel).toEqual(saved);
  }, 30000);

  test('a geometry refresh preserves explicit properties and numerical overrides in the same edit', async () => {
    const original = await normalizeEngineeringModel({ ...initial.model, sections: [{ id: 'section', name: '100x200',
      type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 }, properties: { Iy: .00008 } }] }, protocol);
    const state = await graph().invoke({ ...commitModel({}, original, 'mixed-geometry'),
      messages: [message([call('height-and-torsion', [{ operation: 'update', collection: 'sections', id: 'section',
        values: { shape: { H: 300 }, properties: { J: 9e-8 } },
      }])])] }, config('height-and-explicit-properties'));
    expect(receipt(toolMessages(state)[0]).success).toBe(true);
    expect(state.model.sections[0].properties).toMatchObject({ A: .03, Iy: .00008, Iz: .000025, J: 9e-8 });
    expect(state.model.sections[0].extra.derived_properties.fields).toEqual(['A', 'Iz']);
    expect(original.sections[0].shape.H).toBe(200);
  }, 30000);

  test('unverified stale provenance never authorizes discarding supplied numerical values', async () => {
    const original = await normalizeEngineeringModel({ ...initial.model, sections: [{ id: 'section', name: '100x200',
      type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 } }] }, protocol);
    original.sections[0].properties.Iy = .00008;
    const conflicting = await normalizeEngineeringModel(original, protocol);
    expect(conflicting.sections[0].extra.section_diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SECTION_PROVENANCE_CONFLICT' }),
    ]));
    const state = await graph().invoke({ ...commitModel({}, conflicting, 'explicit-conflict'),
      messages: [message([call('height-with-explicit-values', [{ operation: 'update', collection: 'sections', id: 'section',
        values: { shape: { H: 300 } },
      }])])] }, config('height-conflicting-provenance'));
    expect(receipt(toolMessages(state)[0]).success).toBe(true);
    expect(state.model.sections[0].properties).toEqual(conflicting.sections[0].properties);
  }, 30000);

  test('converter-derived properties retain their source beside explicit user properties across edits', async () => {
    const userInput = '200×100×7×11.4 mm, Iy=2.4e-5 m4';
    const model = { ...initial.model, sections: [{ id: 'section', name: 'I20a', type: 'I',
      shape: { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 }, properties: { Iy: 2.4e-5 },
      extra: { provenance: { shape: 'user', properties: 'user' } } }] };
    const normalized = await normalizeEngineeringModel(model, protocol, undefined, [userInput]);
    expect(normalized.sections[0].properties.Iy).toBe(2.4e-5);
    expect(normalized.sections[0].extra.provenance.propertyFields).toEqual({ A: 'geometry', Iz: 'geometry', J: 'geometry' });
    const again = await normalizeEngineeringModel(normalized, protocol, undefined, [userInput]);
    expect(again).toEqual(normalized);
    const forged = structuredClone(normalized);
    forged.sections[0].properties.A = 1;
    const repaired = await normalizeEngineeringModel(forged, protocol, undefined, [userInput]);
    expect(repaired.sections[0].properties.A).toBe(normalized.sections[0].properties.A);
    const suppliedLater = structuredClone(normalized);
    suppliedLater.sections[0].properties.J = 9e-8;
    const explicit = await normalizeEngineeringModel(suppliedLater, protocol, undefined, [userInput, 'J=9e-8 m4']);
    expect(explicit.sections[0].properties.J).toBe(9e-8);
    expect(explicit.sections[0].extra.provenance.propertyFields.J).toBe('user');
  }, 30000);

  test.each(['shape', 'properties'])('unconfirmed recalled %s cannot commit an edit', async field => {
    const values = field === 'shape' ? { shape: { kind: 'I', H: 200, B: 100, tw: 5.2, tf: 8.4 } }
      : { properties: { Iy: 1.809e-5 } };
    const state = await graph().invoke({ ...structuredClone(initial), analysisResult: { runId: 'saved' },
      messages: [message([call('unconfirmed-edit', [{ operation: 'update', collection: 'sections', id: 'section',
        values: { ...values, extra: { provenance: { [field]: 'llm-table' } } } }])])] }, config(`unconfirmed-${field}`));
    expect(receipt(toolMessages(state)[0])).toMatchObject({ success: false, errorCode: 'SECTION_CONFIRMATION_REQUIRED',
      recoverable: true, nextAction: 'ask_user_clarification', candidates: [expect.objectContaining({ id: 'section' })] });
    expect(state.model).toEqual(initial.model);
    expect(state.modelRevision).toBe(initial.modelRevision);
    expect(state.analysisResult).toEqual({ runId: 'saved' });
  }, 30000);

  test.each([undefined, 'llm-table', 'user'])('user dimensions normalize properties from source %s at the edit boundary', async propertySource => {
    const supplied = propertySource === 'user' ? 2.4e-5 : 2.35453e-5;
    const userInput = `200×100×7×11.4 mm${propertySource === 'user' ? `, A=.003555m2, Iy=${supplied}m4, Iz=.00000158m4, J=1m4` : ''}`;
    const state = await graph().invoke({ ...structuredClone(initial), lastUserMessage: userInput, messages: [message([call('geometry-source', [{
      operation: 'update', collection: 'sections', id: 'section', values: {
        type: 'I', shape: { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 },
        properties: { Iy: supplied, J: 1 },
        extra: { source: 'LLM: unverified', provenance: { shape: 'user', ...(propertySource ? { properties: propertySource } : {}) } },
      },
    }])])] }, config(`geometry-source-${propertySource}`));
    expect(receipt(toolMessages(state)[0]).success).toBe(true);
    const section = state.model.sections[0];
    expect(section.properties.Iy).toBeCloseTo(propertySource === 'user' ? supplied : 2.35452664e-5, 13);
    if (propertySource !== 'user') {
      expect(section.properties.J).toBeLessThan(1e-6);
      expect(section.extra.provenance.properties).toBe('geometry');
      expect(section.extra.derived_properties.fields).toContain('Iy');
      expect(section.extra.discarded_nonuser_properties.Iy).toBe(supplied);
      expect(section.extra.source).toBeUndefined();
    } else expect(section.properties.J).toBe(1);
    const again = await normalizeEngineeringModel(state.model, protocol, undefined, [userInput]);
    expect(again).toEqual(state.model);
    expect(initial.model.sections[0].properties.Iy).toBe(.0000237);
  }, 30000);

  test('one edit atomically applies section and member parameters in one revision', async () => {
    const state = await graph().invoke({ ...structuredClone(initial),
      analysisResult: { runId: 'saved' }, report: { runId: 'saved' },
      messages: [message([call('combined', [sectionEdit, memberEdit])])] }, config('combined'));
    expect(state.modelRevision).toBe(2);
    expect(state.modelHistory).toHaveLength(2);
    expect(state.model.sections[0].properties.Wnx).toBe(.000237);
    expect(state.model.elements[0].design).toMatchObject({ l0: 4000, beta1: 1.1 });
    expect(receipt(toolMessages(state)[0])).toMatchObject({ success: true, changed: true, revision: 2,
      analysisCurrent: false, analysisReason: 'ANALYSIS_REQUIRED' });
    expect(receipt(toolMessages(state)[0]).instruction).toContain('run_analysis');
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
    expect(receipt(messages[1])).toMatchObject({ revision: 2, analysisCurrent: false, analysisReason: 'ANALYSIS_REQUIRED' });
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
    expect(receipt(toolMessages(undone).at(-1))).toMatchObject({ analysisCurrent: false, analysisReason: 'ANALYSIS_REQUIRED' });
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
