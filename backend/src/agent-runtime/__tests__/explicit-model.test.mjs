import { describe, expect, test } from '@jest/globals';
import { buildExplicitDraftModel, validateExplicitModel } from '../../../dist/agent-runtime/explicit-model.js';
import { normalizeEngineeringDraft, mergeEngineeringDraft, projectEngineeringDraftToLegacyPatch } from '../../../dist/agent-runtime/engineering-draft.js';
import { buildModel } from '../../../dist/agent-runtime/model-builder.js';

function draft() {
  return { inferredType: 'frame', frameDimension: '2d', updatedAt: 0, engineeringDraft: {
    topology: { nodes: [{id:'A',x:0,y:0,z:0,restraints:[true,true,true,true,true,true]}, {id:'B',x:4,y:0,z:0}, {id:'C',x:4,y:0,z:3}],
      members: [{id:'AB',type:'beam',nodes:['A','B'],material:'steel',section:'beam'}, {id:'BC',type:'truss',nodes:['B','C'],material:'alloy',section:'rod'}] },
    materials: [{id:'steel',E:206000,nu:0.3,rho:7850},{id:'alloy',E:70000,nu:0.3,rho:2700}],
    sectionRecords: [{id:'beam',properties:{A:0.01,Iy:1e-4,Iz:2e-4,J:1e-5}},{id:'rod',properties:{A:0.002}}],
    loadCases: [{id:'P',type:'other',loads:[{type:'point',element:'AB',position:1.5,fz:0.5},{type:'distributed',element:'AB',start:2,end:4,wz:-2}]}],
    inputEvidence: [{file:'sketch.pdf',pageNumber:2,field:'topology'}],
  }};
}
describe('explicit physical model boundary', () => {
  test.each(['2d', '3d'])('the generated draft contract carries %s through extraction, merge and construction', dimension => {
    const state = draft(); delete state.frameDimension;
    state.engineeringDraft = normalizeEngineeringDraft({ ...state.engineeringDraft, coordinateSystem: { dimension, plane: dimension === '2d' ? 'xz' : null } });
    state.engineeringDraft = mergeEngineeringDraft(state.engineeringDraft, { analysisControl: { self_weight: false } });
    const model = buildExplicitDraftModel(state);
    expect(model.coordinate_system).toMatchObject({ dimension, plane: dimension === '2d' ? 'xz' : null });
    expect(model.nodes).toEqual(state.engineeringDraft.topology.nodes);
    expect(projectEngineeringDraftToLegacyPatch(state, 'frame').frameDimension).toBe(dimension);
    expect(model.load_combinations).toEqual([]);
  });
  test('analysis dimension must be explicit and cannot contradict coordinate semantics or legacy input', () => {
    const state = draft(); delete state.frameDimension;
    expect(() => buildExplicitDraftModel(state)).toThrow('coordinateSystem.dimension required');
    state.engineeringDraft.coordinateSystem = { dimension: '2d', plane: 'xy' };
    expect(() => buildExplicitDraftModel(state)).toThrow('canonical');
    state.engineeringDraft.coordinateSystem.plane = 'xz'; state.frameDimension = '3d';
    expect(() => buildExplicitDraftModel(state)).toThrow('conflicts');
  });
  test('preserves mixed elements, per-member properties and internal loads without template remeshing', () => {
    const state=draft(), original=structuredClone(state);
    const model=buildExplicitDraftModel(state);
    expect(model.elements[1]).toMatchObject({type:'truss',material:'alloy',section:'rod'});
    expect(model.nodes).toHaveLength(3);
    expect(model.load_cases[0].loads[0]).toMatchObject({element:'AB',position:1.5,fz:0.5});
    expect(model.metadata.inputEvidence[0].pageNumber).toBe(2);
    expect(buildModel(state)).toEqual(model);
    expect(state).toEqual(original);
  });
  test('rejects dangling property references and out-of-member positions rather than falling back', () => {
    const state=draft(); state.engineeringDraft.topology.members[1].section='unknown';
    expect(()=>buildExplicitDraftModel(state)).toThrow(/unknown section/);
    const model=buildExplicitDraftModel(draft()); model.load_cases[0].loads[0].position=5;
    expect(()=>validateExplicitModel(model)).toThrow(/outside/);
  });
  test('preserves confirmed fields during partial updates and replaces load by explicit ID', () => {
    const prior=normalizeEngineeringDraft({geometry:{lengthM:8,heightM:2},material:{family:'steel',grade:'Q355'},loads:[{id:'p',kind:'point',unit:'kN',magnitude:10,direction:'globalZ'}]});
    const next=normalizeEngineeringDraft({geometry:{heightM:3},material:{grade:'Q235'},loads:[{id:'p',kind:'point',unit:'N',magnitude:-500,direction:'globalZ'}]});
    const merged=mergeEngineeringDraft(prior,next);
    expect(merged.geometry).toMatchObject({lengthM:8,heightM:3});
    expect(merged.material).toMatchObject({family:'steel',grade:'Q235'});
    expect(merged.loads).toHaveLength(1);
    expect(merged.loads[0].magnitude).toBe(-0.5);
  });
  test('a partial case description preserves its applied loads; missing explicit loads never disappear into a template field', () => {
    const state = draft();
    const merged = mergeEngineeringDraft(state.engineeringDraft, { loadCases: [{ id: 'P', description: 'Confirmed service case' }] });
    expect(merged.loadCases[0].loads).toEqual(state.engineeringDraft.loadCases[0].loads);
    state.engineeringDraft.loadCases = [{ id: 'P', type: 'other' }];
    state.engineeringDraft.loads = [{ kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'B' }];
    expect(() => buildExplicitDraftModel(state)).toThrow('loadCases[].loads');
  });
  test('does not guess units or discard malformed topology rows', () => {
    expect(()=>normalizeEngineeringDraft({loads:[{kind:'point',magnitude:3}]})).toThrow(/LOAD_UNIT_REQUIRED/);
    expect(()=>normalizeEngineeringDraft({topology:{nodes:[{id:'A',x:0,y:0,z:0},{id:'B',x:'?',y:0,z:0}]}})).toThrow(/INVALID_EXPLICIT_TOPOLOGY/);
  });
});
