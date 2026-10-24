import { describe, expect, test } from '@jest/globals';
import { checkModelPhysics, compileConfirmedModelLoads } from '../../../dist/engineering/model-physics.js';

const sourceId = 'LD-BEAM-EDGE-DL-FLOOR';
function fixture() {
  const model = {
    coordinate_system: { dimension: '3d' },
    nodes: [
      { id: 'N0', x: 0, y: 0, z: 0, restraints: [true, true, true, true, true, true] },
      { id: 'N1', x: 0, y: 0, z: 3 }, { id: 'N2', x: 4, y: 0, z: 3 }, { id: 'N3', x: 8, y: 0, z: 3 },
    ],
    elements: [
      { id: 'C1', type: 'column', nodes: ['N0', 'N1'] },
      { id: 'B1', type: 'beam', nodes: ['N1', 'N2'] }, { id: 'B2', type: 'beam', nodes: ['N2', 'N3'] },
    ],
    load_cases: [{ id: 'D-explicit', type: 'dead', loads: ['B1', 'B2'].map(element => ({ type: 'distributed', element, wz: -2 })) },
      { id: 'L-explicit', type: 'live', loads: [] }],
    metadata: { loadMappings: [{ loadId: sourceId, selector: { ids: ['B1', 'B2'] } }] },
  };
  const draft = { geometry: { storyHeightsM: [3] }, loads: [
    { id: sourceId, kind: 'distributed', magnitude: 2, unit: 'kN/m', direction: 'gravity',
      target: 'confirmed-edge-beams', location: { story: 1 }, caseId: 'D-explicit' },
  ] };
  return { model, draft };
}

describe('generated load identities stay bound to the confirmed draft', () => {
  test('formal node roles compile directly and mappings must preserve the complete group', () => {
    const {model}=fixture();model.load_cases.forEach(row=>{row.loads=[];});model.metadata={};
    const draft={geometry:{storyHeightsM:[3]},loads:[{id:'all-top',kind:'nodal',unit:'kN',magnitude:10,direction:'gravity',
      location:{nodeRole:'all-top-nodes',story:1},caseId:'D-explicit'}]};
    const compiled=compileConfirmedModelLoads(model,draft);
    expect(compiled.load_cases[0].loads).toEqual(['N1','N2','N3'].map(node=>({type:'nodal',node,fz:-10})));
    expect(checkModelPhysics(compiled,draft).valid).toBe(true);
    const wrong=structuredClone(compiled);wrong.load_cases[0].loads[0].fz=-20;wrong.load_cases[0].loads[1].fz=0;
    expect(checkModelPhysics(wrong,draft).diagnostics).toContainEqual(expect.objectContaining({code:'LOAD_TARGET_MISMATCH'}));
    model.metadata.loadMappings=[{loadId:'all-top',selector:{ids:['N1','N2','N3']}}];
    expect(compileConfirmedModelLoads(model,draft).load_cases).toEqual(compiled.load_cases);
    model.metadata.loadMappings[0].selector.ids=['N1','N2'];
    expect(()=>compileConfirmedModelLoads(model,draft)).toThrow('LOAD_MAPPING_POSITION_CONFLICT');
  });
  test('point-source identity binds its exact generated node without losing the confirmed position', () => {
    const { model } = fixture();
    model.load_cases.forEach(row => { row.loads = []; });
    model.metadata.loadMappings = [{ loadId: 'point', selector: { ids: ['N2'] }, caseId: 'D-explicit' }];
    const draft = { geometry: { lengthM: 8 }, loads: [{ id: 'point', kind: 'point', unit: 'kN', magnitude: 10,
      direction: 'gravity', target: 'beam', location: { xM: 4, spanIndex: 1 }, caseId: 'D-explicit' }] };
    const before = structuredClone({ model, draft });
    const compiled = compileConfirmedModelLoads(model, draft);
    expect(compiled.load_cases[0].loads).toEqual([{ type: 'nodal', node: 'N2', fz: -10 }]);
    expect(checkModelPhysics(compiled, draft).valid).toBe(true);
    expect({ model, draft }).toEqual(before);
    for (const selector of [{ ids: ['N1'] }, { ids: ['N2','N3'] }, { ids: ['B1'] }]) {
      const invalid = structuredClone(model); invalid.metadata.loadMappings[0].selector = selector;
      expect(() => compileConfirmedModelLoads(invalid, draft)).toThrow(/LOAD_MAPPING_POSITION_CONFLICT|LOAD_MAPPING_UNRESOLVED/);
    }
    const outside = structuredClone(draft); outside.loads[0].location.spanIndex = 2;
    expect(() => compileConfirmedModelLoads(model, outside)).toThrow('LOAD_MAPPING_POSITION_CONFLICT');
  });
  test('explicit source compilation preserves exact scope, case identity and source values', () => {
    const { model, draft } = fixture();
    for (const row of model.load_cases) row.loads = [];
    const before = structuredClone({ model, draft });
    const compiled = compileConfirmedModelLoads(model, draft);
    expect(compiled.load_cases[0].loads).toEqual(['B1', 'B2'].map(element => ({ type: 'distributed', element, wz: -2 })));
    expect(checkModelPhysics(compiled, draft)).toMatchObject({ valid: true, loadTotals: { 'D-explicit': [0, 0, -16] } });
    expect({ model, draft }).toEqual(before);
  });

  test('source compilation refuses conflicting loads instead of replacing an invalid candidate', () => {
    const { model, draft } = fixture();
    model.load_cases[0].loads[0].wz = -3;
    const before = structuredClone({ model, draft });
    expect(() => compileConfirmedModelLoads(model, draft)).toThrow('DRAFT_LOAD_COMPILATION_CONFLICT');
    expect({ model, draft }).toEqual(before);
  });

  test('source compilation rejects duplicate story pressure shorthand before the solver', () => {
    const { model, draft } = fixture();
    for (const row of model.load_cases) row.loads = [];
    model.stories = [{ id: 'F1', dead_load: 5 }];
    const before = structuredClone(model);
    expect(() => compileConfirmedModelLoads(model, draft)).toThrow('DRAFT_LOAD_COMPILATION_CONFLICT');
    expect(model).toEqual(before);
  });
  test('one original load can select multiple members without inventing source IDs', () => {
    const { model, draft } = fixture();
    const saved = structuredClone({ model, draft });
    expect(checkModelPhysics(model, draft)).toMatchObject({ valid: true, loadTotals: { 'D-explicit': [0, 0, -16] } });
    expect({ model, draft }).toEqual(saved);
  });

  test('all invented IDs and duplicate bindings are returned with authoritative alternatives', () => {
    const { model, draft } = fixture();
    const invented = [`${sourceId}-S1-E2`, `${sourceId}-S1-E3`];
    model.metadata.loadMappings = [...invented, sourceId, sourceId].map(loadId => ({ loadId, selector: { ids: ['B1'] } }));
    const saved = structuredClone({ model, draft });
    const check = checkModelPhysics(model, draft);
    expect(check.valid).toBe(false);
    expect(check.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOAD_TARGET_INVALID', details: expect.objectContaining({
      reasonCode: 'LOAD_MAPPING_ID_INVALID', invalidLoadIds: invented, duplicateLoadIds: [sourceId], availableLoadIds: [sourceId],
    }) }));
    expect({ model, draft }).toEqual(saved);
  });

  test('the LLM can explicitly bind an unassigned load to an existing case without changing the draft', () => {
    const { model, draft } = fixture();
    delete draft.loads[0].caseId;
    model.metadata.loadMappings[0].caseId = 'D-explicit';
    const saved = structuredClone({ model, draft });
    expect(checkModelPhysics(model, draft)).toMatchObject({ valid: true, loadTotals: { 'D-explicit': [0, 0, -16] } });
    expect({ model, draft }).toEqual(saved);
  });

  test.each([false, true])('repeating a confirmed selector is idempotent, while changing it is rejected (changed=%s)', changed => {
    const { model, draft } = fixture();
    delete draft.loads[0].target;
    delete draft.loads[0].location;
    draft.loads[0].selector = { ids: ['B1', 'B2'] };
    if (changed) model.metadata.loadMappings[0].selector = { ids: ['B1'] };
    const saved = structuredClone({ model, draft });
    const check = checkModelPhysics(model, draft);
    expect(check.valid).toBe(!changed);
    if (changed) expect(check.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOAD_TARGET_INVALID',
      details: expect.objectContaining({ error: expect.stringContaining('LOAD_MAPPING_SCOPE_CONFLICT') }) }));
    expect({ model, draft }).toEqual(saved);
  });

  test('equivalent explicit identities verify the same scope without overwriting its confirmed selector', () => {
    const { model, draft } = fixture();
    delete draft.loads[0].target;
    delete draft.loads[0].location;
    draft.loads[0].selector = { type: 'beam', prefix: 'B' };
    const before = structuredClone(draft);
    expect(checkModelPhysics(model, draft).valid).toBe(true);
    expect(draft).toEqual(before);
  });

  test.each(['missing', 'unknown', 'changed-confirmed'])('case binding rejects %s instead of guessing from IDs', kind => {
    const { model, draft } = fixture();
    if (kind !== 'changed-confirmed') delete draft.loads[0].caseId;
    if (kind !== 'missing') model.metadata.loadMappings[0].caseId = kind === 'unknown' ? 'guessed-DL' : 'L-explicit';
    const check = checkModelPhysics(model, draft);
    expect(check.valid).toBe(false);
    expect(check.diagnostics).toContainEqual(expect.objectContaining({ details: expect.objectContaining({
      reasonCode: kind === 'missing' ? 'LOAD_MAPPING_CASE_REQUIRED' : kind === 'unknown' ? 'LOAD_MAPPING_CASE_INVALID' : 'LOAD_MAPPING_CASE_CONFLICT',
      loadId: sourceId, availableCaseIds: ['D-explicit', 'L-explicit'],
    }) }));
  });
});
