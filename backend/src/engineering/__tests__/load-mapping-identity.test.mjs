import { describe, expect, test } from '@jest/globals';
import { checkModelPhysics } from '../../../dist/engineering/model-physics.js';

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
