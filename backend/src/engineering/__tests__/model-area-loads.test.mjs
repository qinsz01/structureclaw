import { beforeAll, describe, expect, test } from '@jest/globals';
import { expandModellingOperations } from '../../../dist/skill-shared/modelling/operations.js';
import { checkModelPhysicsWithAreaLoads, compileDeclaredModelLoads } from '../../../dist/engineering/model-area-loads.js';
import { checkModelPhysics } from '../../../dist/engineering/model-physics.js';

const draft = (distribution = 'two-way') => ({ geometry: { storyHeightsM: [3.6] }, loads: [
  { id: 'floor-pressure', kind: 'area', magnitude: 5, unit: 'kN/m2', direction: 'gravity',
    target: 'floor', location: { story: 1 }, caseId: 'D', floorTransfer: { distribution, bounds: { x: [0, 6], y: [0, 4] } } },
] });
const models = {};
beforeAll(async () => {
  for (const distribution of ['one-way-x', 'one-way-y', 'two-way']) {
    models[distribution] = await expandModellingOperations({ schema_version: '2.2.0', coordinate_system: { dimension: '3d' },
      materials: [{ id: 'M', name: 'C35', E: 31500, nu: 0.2, rho: 2500 }],
      sections: [{ id: 'S', name: '400mm square', type: 'rectangular', shape: { kind: 'rectangular', B: 400, H: 400 } }],
      operations: [{ id: 'grid', op: 'regular-frame', dimension: '3d', bayWidthsX: [6], bayWidthsY: [4],
        storeyHeights: [3.6], baseRestraint: 'fixed', material: 'M', columnSection: 'S', beamSection: 'S' },
      { id: 'area-transfer', op: 'floor-to-beam', caseId: 'D', caseType: 'dead', z: 3.6,
        bounds: { x: [0, 6], y: [0, 4] }, pressureKNM2: 5, distribution }],
      metadata: { loadMappings: [{ loadId: 'floor-pressure', caseId: 'D', transferId: 'area-transfer',
        selector: { type: 'beam', story: 'grid:F1' } }] },
    });
  }
}, 60000);

describe('independent source pressure verification', () => {
  test('the explicit compiler expands confirmed pressure with the same physical verification', async () => {
    const model = structuredClone(models['two-way']);
    for (const row of model.load_cases) row.loads = [];
    const before = structuredClone(model);
    const compiled = await compileDeclaredModelLoads(model, draft());
    const check = await checkModelPhysicsWithAreaLoads(compiled, draft());
    expect(check.valid).toBe(true);
    expect(check.loadTotals.D[2]).toBeCloseTo(-120, 10);
    expect(model).toEqual(before);
  });
  test.each(['one-way-x', 'one-way-y', 'two-way'])('verifies source pressure times actual area and target loads (%s)', async distribution => {
    const model = models[distribution], before = structuredClone(model), source = draft(distribution);
    const checked = await checkModelPhysicsWithAreaLoads(model, source);
    expect(checked.diagnostics).toEqual([]);
    expect(checked.valid).toBe(true);
    expect(checked.loadTotals.D.slice(0, 2)).toEqual([0, 0]);
    expect(checked.loadTotals.D[2]).toBeCloseTo(-120, 10);
    expect(model).toEqual(before);
    expect(source).toEqual(draft(distribution));
    expect(checkModelPhysics(model, source).valid).toBe(false); // No trust in model-authored totals.
  });

  test.each(['missing-binding', 'wrong-case', 'wrong-pressure', 'wrong-floor', 'partial-floor'])('rejects %s without a replacement scheme', async failure => {
    const model = structuredClone(models['two-way']);
    const transfer = model.metadata.modellingOperations.find(op => op.op === 'floor-to-beam');
    if (failure === 'missing-binding') delete model.metadata.loadMappings[0].transferId;
    if (failure === 'wrong-case') model.metadata.loadMappings[0].caseId = 'changed-case';
    if (failure === 'wrong-pressure') transfer.pressureKNM2 = 4;
    if (failure === 'wrong-floor') transfer.z = 7.2;
    if (failure === 'partial-floor') transfer.bounds.x = [0, 3];
    model.metadata.floorLoadTransfers = [{ totalKN: 120 }];
    const checked = await checkModelPhysicsWithAreaLoads(model, draft());
    expect(checked.valid).toBe(false);
    expect(checked.diagnostics).toContainEqual(expect.objectContaining({ code: 'AREA_LOAD_BINDING_INVALID' }));
  });

  test('equal case resultant on the wrong member still fails the target check', async () => {
    const model = structuredClone(models['one-way-x']);
    const loads = model.load_cases[0].loads;
    const wrong = model.elements.find(row => row.type === 'beam' && !loads.some(load => load.element === row.id));
    loads[0].element = wrong.id;
    const checked = await checkModelPhysicsWithAreaLoads(model, draft('one-way-x'));
    expect(checked.valid).toBe(false);
    expect(checked.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOAD_TARGET_MISMATCH' }));
  });

  test.each(['unconfirmed', 'changed-direction'])('does not invent a source transfer method (%s)', async failure => {
    const source = draft();
    if (failure === 'unconfirmed') delete source.loads[0].floorTransfer;
    else source.loads[0].floorTransfer.distribution = 'one-way-x';
    const checked = await checkModelPhysicsWithAreaLoads(models['two-way'], source);
    expect(checked.valid).toBe(false);
    expect(checked.diagnostics).toContainEqual(expect.objectContaining({ code: 'AREA_LOAD_BINDING_INVALID' }));
  });

  test('checks a mixed area and line load case without losing either source', async () => {
    const model = structuredClone(models['two-way']), source = draft();
    const beam = model.elements.find(row => row.type === 'beam');
    model.load_cases[0].loads.push({ type: 'distributed', element: beam.id, wz: -2, reference_frame: 'global' });
    source.loads.push({ id: 'wall', kind: 'line', magnitude: 2, unit: 'kN/m', direction: 'gravity', target: beam.id, caseId: 'D' });
    expect((await checkModelPhysicsWithAreaLoads(model, source)).valid).toBe(true);
    model.load_cases[0].loads.pop();
    expect((await checkModelPhysicsWithAreaLoads(model, source)).diagnostics).toContainEqual(expect.objectContaining({ code: 'LOAD_TOTAL_MISMATCH' }));
  });
});
