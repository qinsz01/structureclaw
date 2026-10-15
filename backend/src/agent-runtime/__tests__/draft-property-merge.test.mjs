import { describe, expect, test } from '@jest/globals';
import { mergeEngineeringDraft } from '../../../dist/agent-runtime/engineering-draft.js';

describe('draft material and section clarification patches', () => {
  test('updates the identified record and preserves other records and nested properties', () => {
    const before = { materials: [{ id: 'M1', E: 206000, nu: 0.3, name: 'Steel' }, { id: 'M2', E: 30000 }],
      sectionRecords: [{ id: 'S1', name: 'Section', type: 'custom', properties: { A: 0.02, Iy: 1e-4, Iz: 2e-5, J: 3e-5 } }] };
    const after = mergeEngineeringDraft(before, { materials: [{ id: 'M1', rho: 7850 }],
      sectionRecords: [{ id: 'S1', properties: { Iy: 2e-4 } }] });
    expect(after.materials).toEqual([{ ...before.materials[0], rho: 7850 }, before.materials[1]]);
    expect(after.sectionRecords[0].properties).toEqual({ A: 0.02, Iy: 2e-4, Iz: 2e-5, J: 3e-5 });
    expect(before.materials[0].rho).toBeUndefined();
    expect(before.sectionRecords[0].properties.Iy).toBe(1e-4);
    expect(mergeEngineeringDraft(before, { materials: [], sectionRecords: [] })).toMatchObject({ materials: [], sectionRecords: [] });
  });
  test('a changed kind alone does not silently erase supplied properties or geometry', () => {
    const before = { sectionRecords: [{ id: 'S', name: 'Section', purpose: 'beam', type: 'rectangular',
      shape: { kind: 'rectangular', B: 100, H: 200 }, width: 100, height: 200, properties: { A: 0.02, Iy: 1e-4 } }] };
    const after = mergeEngineeringDraft(before, { sectionRecords: [{ id: 'S', shape: { kind: 'circular', D: 120 } }] });
    expect(after.sectionRecords[0]).toEqual({ ...before.sectionRecords[0], shape: { ...before.sectionRecords[0].shape, kind: 'circular', D: 120 } });
    expect(before.sectionRecords[0].shape.H).toBe(200);
  });
  test('an ambiguous ID is rejected instead of overwriting an arbitrary record', () => {
    expect(() => mergeEngineeringDraft({ materials: [{ id: 'M', E: 1 }, { id: 'M', E: 2 }] },
      { materials: [{ id: 'M', rho: 7850 }] })).toThrow('AMBIGUOUS_DRAFT_RECORD_ID');
    expect(() => mergeEngineeringDraft({ materials: [{ id: 'M', E: 1 }] },
      { materials: [{ id: 'M', rho: 7850 }, { id: 'M', rho: 7800 }] })).toThrow('DUPLICATE_DRAFT_RECORD_ID');
  });
});
