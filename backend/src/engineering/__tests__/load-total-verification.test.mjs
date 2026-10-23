import { describe, expect, test } from '@jest/globals';
import { checkModelPhysics } from '../../../dist/engineering/model-physics.js';
import { genericFixtures } from '../../../tests/characterization/fixtures/generic-physics.mjs';

const frame = () => {
  const model = structuredClone(genericFixtures[0].model);
  model.load_cases = [{ id: 'DL', type: 'dead', loads: [] }, { id: 'LL', type: 'live', loads: [] }];
  return model;
};
const declaredLoads = [
  { id: 'LD-DL-F', kind: 'distributed', magnitude: 27, unit: 'kN/m', direction: 'gravity', target: 'all-beams', caseId: 'DL' },
  { id: 'LD-DL-R', kind: 'distributed', magnitude: 30, unit: 'kN/m', direction: 'gravity', target: 'roof-beams', caseId: 'DL' },
  { id: 'LD-LL-F', kind: 'distributed', magnitude: 12, unit: 'kN/m', direction: 'gravity', target: 'all-beams', caseId: 'LL' },
  { id: 'LD-LL-R', kind: 'distributed', magnitude: 3, unit: 'kN/m', direction: 'gravity', target: 'roof-beams', caseId: 'LL' },
];

describe('declared loads require independently verifiable totals', () => {
  test('unresolved floor/roof selectors cannot accept a stable frame with empty DL/LL cases', () => {
    const model = frame(), draft = { loads: structuredClone(declaredLoads) };
    const before = structuredClone({ model, draft });
    const checked = checkModelPhysics(model, draft);
    expect(checked.stability.freeModes).toBe(0);
    expect(checked.loadTotals).toEqual({ DL: [0, 0, 0], LL: [0, 0, 0] });
    expect(checked.valid).toBe(false);
    expect(checked.diagnostics).toEqual([expect.objectContaining({ code: 'LOAD_TOTAL_UNVERIFIABLE', severity: 'error' })]);
    expect({ model, draft }).toEqual(before);
  });

  test('inventing a nonempty candidate load does not resolve an unverified selector', () => {
    const model = frame();
    model.load_cases[0].loads.push({ type: 'distributed', element: 'B21', wz: -30 });
    const checked = checkModelPhysics(model, { loads: declaredLoads });
    expect(checked.valid).toBe(false);
    expect(checked.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOAD_TOTAL_UNVERIFIABLE', severity: 'error' }));
  });

  test('exact member and node IDs preserve independently verifiable multi-case loads', () => {
    const model = frame();
    const loads = declaredLoads.map(load => ({ ...load, target: load.id.endsWith('-F') ? 'B11' : 'B21' }));
    loads.push({ id: 'P1', kind: 'nodal', magnitude: 10, unit: 'kN', direction: 'globalX', target: 'F10', caseId: 'DL' });
    model.load_cases[0].loads = [
      { type: 'distributed', element: 'B11', wz: -27 }, { type: 'distributed', element: 'B21', wz: -30 },
      { type: 'nodal', node: 'F10', fx: 10 },
    ];
    model.load_cases[1].loads = [{ type: 'distributed', element: 'B11', wz: -12 }, { type: 'distributed', element: 'B21', wz: -3 }];
    expect(checkModelPhysics(model, { loads })).toMatchObject({ valid: true, diagnostics: [],
      loadTotals: { DL: [10, 0, -285], LL: [0, 0, -75] } });
    model.load_cases[0].loads = model.load_cases[0].loads.filter(load => load.element !== 'B21');
    expect(checkModelPhysics(model, { loads })).toMatchObject({ valid: false,
      diagnostics: [expect.objectContaining({ code: 'LOAD_TOTAL_MISMATCH', severity: 'error' })] });
  });

  test('explicit loadCases retain their existing independent check', () => {
    const model = frame();
    model.load_cases[0].loads = [{ type: 'distributed', element: 'B11', wz: -27 }];
    model.load_cases[1].loads = [{ type: 'nodal', node: 'F20', fz: -3 }];
    const draft = { loadCases: structuredClone(model.load_cases) };
    expect(checkModelPhysics(model, draft)).toMatchObject({ valid: true, diagnostics: [],
      loadTotals: { DL: [0, 0, -135], LL: [0, 0, -3] } });
    model.load_cases[1].loads = [];
    expect(checkModelPhysics(model, draft)).toMatchObject({ valid: false,
      diagnostics: [expect.objectContaining({ code: 'LOAD_TOTAL_MISMATCH', severity: 'error' })] });
  });

  test('an explicitly unloaded draft may still have empty load cases', () => {
    expect(checkModelPhysics(frame(), { metadata: { zeroLoads: true } }))
      .toMatchObject({ valid: true, diagnostics: [], loadTotals: { DL: [0, 0, 0], LL: [0, 0, 0] } });
  });

  test('a zero-load declaration cannot override nonzero declared loads', () => {
    const model = frame(), draft = { metadata: { zeroLoads: true }, loads: structuredClone(declaredLoads) };
    const before = structuredClone({ model, draft });
    const checked = checkModelPhysics(model, draft);
    expect(checked.valid).toBe(false);
    expect(checked.diagnostics).toEqual([expect.objectContaining({ code: 'ZERO_LOADS_CONFLICT', severity: 'error' })]);
    expect({ model, draft }).toEqual(before);
  });
});
