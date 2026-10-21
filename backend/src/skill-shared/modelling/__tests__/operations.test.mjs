import { describe, expect, test } from '@jest/globals';
import { expandModellingOperations, assertUserTopologyIds } from '../../../../dist/skill-shared/modelling/operations.js';
import { checkModelPhysics, appliedLoadTotals } from '../../../../dist/engineering/model-physics.js';
import { tryBuildGenericModelWithLlm } from '../../../../dist/agent-skills/structure-type/generic/llm-model-builder.js';
import { createLocalStructureProtocolClient } from '../../../../dist/skill-shared/structure-protocol-execution.js';
import { normalizeEngineeringModel } from '../../../../dist/engineering/model-boundary.js';
import { createLocalAnalysisEngineClient } from '../../../../dist/services/analysis-execution.js';
import { ModellingOperationError } from '../../../../dist/skill-shared/modelling/contract.js';
import { resolveRunPolicy } from '../../../../dist/runtime/run-policy.js';
import { createRunContext, withRunContext } from '../../../../dist/runtime/run-context.js';
import { createBuildModelTool } from '../../../../dist/agent-langgraph/tools.js';

const fixed = [true, true, true, true, true, true];
const base = dimension => ({ schema_version: '2.2.0', unit_system: 'SI', coordinate_system: { dimension },
  materials: [{ id: 'M', name: 'Q235', E: 206000, nu: .3, rho: 7850 }],
  sections: [{ id: 'S', name: 'User 400mm square', type: 'rectangular', purpose: 'other', shape: { kind: 'rectangular', B: 400, H: 400 } }],
  analysis_control: { self_weight: false, rigid_floor: false },
});
const grid = dimension => ({ id: 'g', op: 'regular-frame', dimension, bayWidthsX: [5, 5], ...(dimension === '3d' ? { bayWidthsY: [5, 5] } : {}),
  storeyHeights: [3, 3], baseRestraint: 'fixed', material: 'M', columnSection: 'S', beamSection: 'S' });
const lateral = { id: 'P', op: 'nodal-load', selector: { coordinate: { axis: 'z', gt: 0 } }, caseId: 'LC1', vector: [10, 0, 0] };
describe('deterministic modelling operations', () => {
  test.each([['2d', 9, 10, 60], ['3d', 27, 42, 180]])('regular %s grid has correct topology, member roles, stories and every nodal force', async (dimension, nodes, members, fx) => {
    const model = await expandModellingOperations({ ...base(dimension), operations: [grid(dimension), lateral] });
    expect(model.nodes).toHaveLength(nodes); expect(model.elements).toHaveLength(members);
    expect(model.stories.map(story => story.height)).toEqual([3, 3]);
    expect(checkModelPhysics(model)).toMatchObject({ valid: true, stability: { freeModes: 0 }, loadTotals: { LC1: [fx, 0, 0] } });
    expect(model.elements.filter(member => member.type === 'column')).toHaveLength(dimension === '2d' ? 6 : 18);
  });
  test('partial user nodes and a member keep IDs, coordinates, restraints and assignments', async () => {
    const topology = { nodes: [{ id: 'A', x: 0, y: 0, z: 0, restraints: fixed }, { id: 'C', x: 0, y: 0, z: 3 }],
      members: [{ id: 'user-column', nodes: ['A', 'C'], type: 'column', material: 'M', section: 'S' }] };
    const input = { ...base('2d'), operations: [{ ...grid('2d'), nodeIds: { '0,0,0': 'A', '1,0,0': 'C' }, memberIds: { C1: 'user-column' } }, lateral] };
    const model = await expandModellingOperations(input, { nodes: topology.nodes, elements: topology.members });
    expect(() => assertUserTopologyIds(model, topology)).not.toThrow();
    expect(model.elements.filter(member => member.id === 'user-column')).toHaveLength(1);
    const altered = structuredClone(model); altered.nodes.find(node => node.id === 'C').z = 4;
    expect(() => assertUserTopologyIds(altered, topology)).toThrow('USER_TOPOLOGY_VALUE_CHANGED');
    expect(() => assertUserTopologyIds({ nodes: [], elements: [] }, topology)).toThrow('USER_TOPOLOGY_IDS_NOT_PRESERVED');
  });
  test('arc and polyline discretisation preserve user IDs and the crown position', async () => {
    const model = await expandModellingOperations({ ...base('2d'), operations: [
      { op: 'arc', id: 'a', center: [3, 0, 0], radius: 3, startDegrees: 180, endDegrees: 0, segments: 12, plane: 'xz', nodeIds: { 0: 'A', 6: 'C', 12: 'B' }, material: 'M', section: 'S' },
      { op: 'assign-restraints', id: 'supports', selector: { ids: ['A', 'B'] }, restraints: fixed },
      { op: 'nodal-load', id: 'crown', selector: { ids: ['C'] }, caseId: 'LC1', vector: [0, 0, -10] },
    ] });
    expect(model.nodes).toHaveLength(13); expect(model.elements).toHaveLength(12);
    expect(model.nodes.find(node => node.id === 'C')).toMatchObject({ x: 3, z: 3 });
    expect(checkModelPhysics(model).valid).toBe(true);
    const line = await expandModellingOperations({ ...base('2d'), operations: [{ op: 'polyline', id: 'p', points: [[0, 0, 0], [6, 0, 0]], segmentsPerEdge: 3, material: 'M', section: 'S' }] });
    expect(line.nodes.map(node => node.x)).toEqual([0, 2, 4, 6]);
  });
  test('truss panels reuse specialised IDs and honour the declared diagonal topology', async () => {
    const model = await expandModellingOperations({ ...base('2d'), operations: [{ op: 'truss-panels', id: 't', span: 12, height: 2, panels: 4, topology: 'pratt', material: 'M', section: 'S' }] });
    expect(model.nodes).toHaveLength(10); expect(model.elements).toHaveLength(17);
    expect(model.elements.find(member => member.id === 't:WD0').nodes).toEqual(['t:B1', 't:T0']);
    expect(checkModelPhysics(model).valid).toBe(true);
  });
  test('replication, geometric transforms and coincident merging preserve loads and identifiers', async () => {
    const model = await expandModellingOperations({ ...base('2d'), nodes: [{ id: 'A', x: 0, y: 0, z: 0, restraints: fixed }, { id: 'B', x: 2, y: 0, z: 0 }],
      elements: [{ id: 'AB', type: 'beam', nodes: ['A', 'B'], material: 'M', section: 'S' }], operations: [
        { op: 'nodal-load', id: 'tip', selector: { ids: ['B'] }, caseId: 'LC1', vector: [0, 0, -5] },
        { op: 'replicate', id: 'copy', selector: { ids: ['AB'] }, count: 1, vector: [2, 0, 0], copyLoads: true },
        { op: 'merge-coincident', id: 'join', preferredIds: ['A', 'B'] },
        { op: 'translate', id: 'move', selector: { ids: ['copy:1:B'] }, vector: [1, 0, 0] },
        { op: 'mirror', id: 'mirror', selector: { ids: ['copy:1:B'] }, axis: 'x', offset: 0 },
      ] });
    expect(model.nodes).toHaveLength(3); expect(model.elements).toHaveLength(2);
    expect(model.elements[1].nodes).toEqual(['B', 'copy:1:B']);
    expect(model.nodes.find(node => node.id === 'copy:1:B').x).toBe(-5);
    expect(appliedLoadTotals(model).LC1).toEqual([0, 0, -10]);
    expect(model.nodes.find(node => node.id === 'B').restraints).toEqual(fixed);
  });
  test('member load selectors preserve physical IDs, intervals and fractional point positions', async () => {
    const model = await expandModellingOperations({ ...base('2d'), operations: [
      { op: 'polyline', id: 'p', points: [[0, 0, 0], [4, 0, 0]], material: 'M', section: 'S' },
      { op: 'assign-properties', id: 'properties', selector: { ids: ['p:E1'] }, target: 'elements', values: { rotation_angle: 90 } },
      { op: 'member-udl', id: 'q', selector: { ids: ['p:E1'] }, caseId: 'LC1', vector: [0, 0, -5], start: { distanceM: 1 }, end: { fraction: .75 } },
      { op: 'member-point-load', id: 'p1', selector: { ids: ['p:E1'] }, caseId: 'LC1', vector: [0, 0, -10], position: { fraction: .5 } },
    ] });
    expect(model.elements[0]).toMatchObject({ id: 'p:E1', rotation_angle: 90 });
    expect(model.load_cases[0].loads).toEqual([expect.objectContaining({ element: 'p:E1', start: 1, end: 3 }), expect.objectContaining({ element: 'p:E1', position: 2 })]);
    expect(appliedLoadTotals(model).LC1).toEqual([0, 0, -20]);
  });
  test.each(['one-way-x', 'one-way-y', 'two-way'])('floor %s transfer conserves qA and reaches the real solver', async distribution => {
    const model = await expandModellingOperations({ ...base('3d'), operations: [
      { ...grid('3d'), bayWidthsX: [6], bayWidthsY: [8], storeyHeights: [3] },
      { op: 'floor-to-beam', id: 'floor', caseId: 'LC1', distribution, z: 3, bounds: { x: [0, 6], y: [0, 8] }, pressureKNM2: 5 },
    ] });
    expect(appliedLoadTotals(model).LC1[2]).toBeCloseTo(-240, 10);
    expect(model.nodes).toHaveLength(8);
    const normalized = await normalizeEngineeringModel(model, createLocalStructureProtocolClient());
    const { data } = await createLocalAnalysisEngineClient().post('/analyze', { type: 'static', engineId: 'builtin-opensees', model: normalized, parameters: {} });
    expect(data.success).toBe(true);
    const result = data.results['case:LC1'].data;
    expect(Object.values(result.reactions).reduce((sum, reaction) => sum + reaction.fz, 0)).toBeCloseTo(240, 6);
  }, 60000);
  test('missing floor supports and unmatched selectors fail, without changing the source model', async () => {
    const input = { ...base('3d'), operations: [{ ...grid('3d'), bayWidthsX: [6], bayWidthsY: [8], storeyHeights: [3] },
      { op: 'floor-to-beam', id: 'floor', caseId: 'LC1', distribution: 'two-way', z: 4, bounds: { x: [0, 6], y: [0, 8] }, pressureKNM2: 5 }] };
    const snapshot = structuredClone(input);
    await expect(expandModellingOperations(input)).rejects.toThrow('FLOOR_LOAD_EXPANSION_FAILED');
    expect(input).toEqual(snapshot);
    await expect(expandModellingOperations({ ...base('2d'), operations: [{ ...lateral, selector: { ids: ['missing'] } }] })).rejects.toThrow('OPERATION_SELECTOR_UNRESOLVED');
  });
  test('the LLM builder expands operations inside its ordinary validation and repair boundary', async () => {
    const input = { ...base('2d'), operations: [grid('2d'), lateral] };
    const model = await tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(input) }) }, 'Two-storey two-bay frame, each upper node +10kN.',
      { inferredType: 'unknown', updatedAt: 0, engineeringDraft: { materials: input.materials, sectionRecords: input.sections } }, 'en');
    expect(model.nodes).toHaveLength(9);
    expect(model.metadata.physicsCheck.loadTotals.LC1).toEqual([60, 0, 0]);
    expect(model.operations).toBeUndefined();
  });
  test('unresolved operations exhaust exactly the configured repair budget and preserve the cause', async () => {
    const policy = resolveRunPolicy({ availableSkillIds: ['generic'], structureTypeSkillIds: ['generic'], availableToolIds: [], requested: { repair: { enabled: true, maxRecoveriesPerTurn: 1 } } });
    const run = createRunContext(policy); let calls = 0;
    const input = { ...base('2d'), operations: [{ ...lateral, selector: { ids: ['missing'] } }] };
    await expect(withRunContext(run, () => tryBuildGenericModelWithLlm({ invoke: async () => { calls++; return { content: JSON.stringify(input) }; } }, 'Do not guess a target', {}, 'en')))
      .rejects.toMatchObject({ code: 'OPERATION_SELECTOR_UNRESOLVED' });
    expect(calls).toBe(2); expect(run.usage.recoveries).toBe(1);
  });
  test('the public build tool returns structured operation diagnostics without replacing a saved model', async () => {
    const saved = { nodes: [{ id: 'saved' }] };
    const state = { model: saved, modelRevision: 3, draftState: { skillId: 'generic' }, messages: [] };
    const result = await createBuildModelTool({ buildModel: async () => { throw new ModellingOperationError('USER_TOPOLOGY_IDS_NOT_PRESERVED', { missingNodes: ['A'] }); } }).invoke({},
      { toolCall: { id: 'failed-operation' }, configurable: { agentState: state } });
    expect(JSON.parse(result.update.messages[0].content)).toMatchObject({ success: false, errorCode: 'USER_TOPOLOGY_IDS_NOT_PRESERVED', details: { missingNodes: ['A'] } });
    expect(result.update.model).toBeUndefined();
    expect(state.model).toBe(saved); expect(state.modelRevision).toBe(3);
  });
});
