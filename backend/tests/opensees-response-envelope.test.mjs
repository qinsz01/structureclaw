// Build backend first. These cases invoke the real OpenSees worker and the same
// immutable-run enrichment/public summary used by run_analysis. No LLM or solver mock.
import { describe, expect, test } from '@jest/globals';
import { AnalysisRuntimeRunner } from '../dist/agent-skills/analysis/runtime-runner.js';
import { executeAnalysisRun } from '../dist/engineering/analysis-runs.js';
import { withRecoveredStaticEnvelope } from '../dist/engineering/response-envelope.js';
import { buildAnalysisToolSummary } from '../dist/agent-langgraph/tools.js';

const E = 200000000, Iy = .1 * .2 ** 3 / 12, Iz = .2 * .1 ** 3 / 12;
const runner = new AnalysisRuntimeRunner();
const point = (span, fz, fy = 0) => ({ id: 'P', type: 'point', element: 'beam', position: span / 2, fz, fy });
const uniform = wz => ({ id: 'q', type: 'distributed', element: 'beam', wz });
function beam({ dimension = '2d', span = 4, loads = [], cantilever = false } = {}) {
  return { schema_version: '2.2.0', unit_system: 'SI',
    coordinate_system: { semantics: 'global-z-up', version: 1, dimension,
      plane: dimension === '2d' ? 'xz' : null, dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] },
    nodes: [
      { id: 'A', x: 0, y: 0, z: 0, restraints: cantilever ? [true, true, true, true, true, true]
        : [true, true, true, true, false, dimension === '2d'] },
      { id: 'B', x: span, y: 0, z: 0, restraints: cantilever ? [false, false, false, false, false, false]
        : [false, true, true, dimension === '2d', false, dimension === '2d'] },
    ],
    elements: [{ id: 'beam', type: 'beam', nodes: ['A', 'B'], material: 'steel', section: 's' }],
    materials: [{ id: 'steel', name: 'Elastic steel', E: E / 1000, nu: .3, rho: 7850 }],
    sections: [{ id: 's', name: 'Explicit numerical section', type: 'custom', properties: { A: .02, Iy, Iz, J: .00005 } }],
    load_cases: [{ id: 'D', type: 'dead', loads }], load_combinations: [],
    analysis_control: { self_weight: false, rigid_floor: false, rigid_offsets: false, p_delta: false, construction_stage: false },
  };
}
async function solve(model, parameters = {}) {
  const before = structuredClone(model), raw = [];
  const run = await executeAnalysisRun({ model, type: 'static', engineId: 'builtin-opensees', parameters }, async input => {
    const result = await runner.invoke({ action: 'analyze', input });
    raw.push(structuredClone(result));
    return result;
  }, async () => {});
  expect(run.success).toBe(true);
  for (const result of Object.values(run.results)) {
    expect(result.data.execution.executed).toBe(true);
    expect(result.data.execution.solverVersion).toBeTruthy();
    expect(result.data.execution.solverConfiguration.analysis).toBe('Static');
    expect(result.data.memberResponses[0].state).toBe('recovered');
  }
  expect(model).toEqual(before);
  return { run, raw, summary: buildAnalysisToolSummary({ result: run, model }) };
}
function near(actual, expected) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-10 + Math.abs(expected) * 1e-8);
}
function interior(data, quantity, span, resultKey = 'case:D') {
  expect(data.envelope.controlLocations[quantity]).toMatchObject({
    kind: 'member', elementId: 'beam', positionM: span / 2, resultKey, provenance: 'mechanics-recovery',
  });
  expect(data.envelope.controlLocations[quantity].nodeId).toBeUndefined();
}

describe('real OpenSees static envelope includes recovered interior responses', () => {
  test.each(['2d', '3d'])('%s physical single member retains internal point-load peaks in public keyMetrics', async dimension => {
    const span = 4, P = 1;
    const { run, raw, summary } = await solve(beam({ dimension, span, loads: [point(span, -P)] }));
    const moment = P * span / 4, displacement = P * span ** 3 / (48 * E * Iy);
    expect(raw[0].data.solverMesh.physicalElements.beam).toHaveLength(2);
    near(raw[0].data.envelope.maxAbsMoment, 0);
    near(raw[0].data.envelope.maxAbsDisplacement, 0);
    near(run.data.envelope.maxAbsMoment, moment);
    near(run.data.envelope.maxAbsDisplacement, displacement);
    near(summary.keyMetrics.maxAbsMoment, moment);
    near(summary.keyMetrics.maxAbsDisplacement, displacement);
    near(run.data.summary.maxDisplacement, displacement);
    expect(run.data.summary.maxDisplacementNode).toBeNull();
    interior(run.data, 'moment', span); interior(run.data, 'displacement', span);
    expect(summary.controlling.locations).toEqual(run.data.envelope.controlLocations);
    expect(summary.controlling.controlElementDisplacement).toBe('beam');
    expect(summary.envelopeMethod).toBe('solver-direct-and-mechanics-recovery-sampled');
    // Raw signed physical ends and actual segment responses remain untouched.
    expect(run.data.forces).toEqual(raw[0].data.forces);
    expect(run.data.segmentResults).toEqual(raw[0].data.segmentResults);
  }, 60000);

  test('uniform loading has interior peaks even without an internal solver node', async () => {
    const span = 8, q = 2;
    const { run, raw } = await solve(beam({ span, loads: [uniform(-q)] }));
    expect(raw[0].data.solverMesh.physicalElements.beam).toHaveLength(1);
    near(run.data.envelope.maxAbsMoment, q * span ** 2 / 8);
    near(run.data.envelope.maxAbsDisplacement, 5 * q * span ** 4 / (384 * E * Iy));
    interior(run.data, 'moment', span); interior(run.data, 'displacement', span);
  }, 60000);

  test('3-D biaxial resultants combine components at the same physical station', async () => {
    const span = 6, Py = 3, Pz = 4;
    const { run } = await solve(beam({ dimension: '3d', span, loads: [point(span, -Pz, -Py)] }));
    near(run.data.envelope.maxAbsMoment, Math.hypot(Py, Pz) * span / 4);
    near(run.data.envelope.maxAbsDisplacement, Math.hypot(
      Py * span ** 3 / (48 * E * Iz), Pz * span ** 3 / (48 * E * Iy)));
    interior(run.data, 'moment', span); interior(run.data, 'displacement', span);
  }, 60000);

  test('each case and combination retains its own envelope and selected summary scope', async () => {
    const span = 6, P = 2, q = 3;
    const model = beam({ span });
    model.load_cases = [{ id: 'D', type: 'dead', loads: [point(span, -P)] },
      { id: 'L', type: 'live', loads: [uniform(-q)] }];
    model.load_combinations = [{ id: 'U', factors: { D: 1.2, L: .8 } }];
    const { run, summary } = await solve(model);
    const pointM = P * span / 4, uniformM = q * span ** 2 / 8;
    const pointU = P * span ** 3 / (48 * E * Iy), uniformU = 5 * q * span ** 4 / (384 * E * Iy);
    for (const [key, moment, displacement] of [
      ['case:D', pointM, pointU], ['case:L', uniformM, uniformU],
      ['combination:U', 1.2 * pointM + .8 * uniformM, 1.2 * pointU + .8 * uniformU],
    ]) {
      const data = run.results[key].data;
      near(data.envelope.maxAbsMoment, moment); near(data.envelope.maxAbsDisplacement, displacement);
      interior(data, 'moment', span, key); interior(data, 'displacement', span, key);
    }
    expect(run.selectedResultKey).toBe('case:D');
    near(summary.keyMetrics.maxAbsMoment, pointM);
    expect(summary.controlling.locations.moment.resultKey).toBe('case:D');
  }, 60000);

  test('cantilever direct end and actual node peaks remain represented', async () => {
    const span = 3, P = 2;
    const { run, raw } = await solve(beam({ dimension: '3d', span, cantilever: true,
      loads: [{ id: 'P', type: 'nodal', node: 'B', fz: -P }] }));
    near(run.data.envelope.maxAbsMoment, P * span);
    near(run.data.envelope.maxAbsDisplacement, P * span ** 3 / (3 * E * Iy));
    expect(run.data.envelope.maxAbsMoment).toBeGreaterThanOrEqual(raw[0].data.envelope.maxAbsMoment);
    expect(run.data.envelope.maxAbsDisplacement).toBeGreaterThanOrEqual(raw[0].data.envelope.maxAbsDisplacement);
    expect(run.data.envelope.controlLocations.displacement).toMatchObject({ nodeId: 'B' });
    expect(run.data.envelope.controlLocations.moment).toMatchObject({ elementId: 'beam' });
  }, 60000);
});

test('sampled envelope preserves legacy direct peaks, excludes display interpolation and never combines separate stations', () => {
  const model = beam(), data = { envelope: { maxAbsAxialForce: 20, controlElementAxialForce: 'legacy-axial' },
    forces: { 'legacy-axial': { axial: 20 } },
    displacements: { B: { ux: 0, uy: 0, uz: .003 } } };
  const sample = (x, M2, M3, displacement = [0, 0, 0]) => ({ x, M2, M3, V2: 0, V3: 0, N: 0, displacement });
  const members = [{ id: 'beam', length: 4, state: 'recovered', samples: [sample(1, 3, 0), sample(3, 0, 4)] },
    { id: 'unsupported', length: 4, state: 'interpolated', samples: [sample(2, 999, 999, [1, 1, 1])] }];
  const before = structuredClone({ data, members });
  const result = withRecoveredStaticEnvelope(model, data, members, { kind: 'case', id: 'D' });
  expect(result.envelope.maxAbsAxialForce).toBe(20);
  expect(result.envelope.controlLocations.axialForce).toEqual({ kind: 'member', elementId: 'legacy-axial',
    provenance: 'solver-direct-envelope', resultKey: 'case:D' });
  expect(result.envelope.maxAbsMoment).toBe(4);
  expect(result.envelope.controlLocations.moment.positionM).toBe(3);
  expect(result.envelope.maxAbsDisplacement).toBe(.003);
  expect(result.envelope.controlLocations.displacement).toMatchObject({ kind: 'node', nodeId: 'B', provenance: 'solver-direct' });
  expect({ data, members }).toEqual(before);
});
