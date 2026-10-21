import { describe, expect, test } from '@jest/globals';
import { appliedLoadTotals, checkModelPhysics } from '../../../dist/engineering/model-physics.js';
import { genericFixtures } from '../../../tests/characterization/fixtures/generic-physics.mjs';

const copy = index => structuredClone(genericFixtures[index].model);
const codes = model => checkModelPhysics(model).diagnostics.filter(item => item.severity === 'error').map(item => item.code);
describe('deterministic model physics', () => {
  test.each(genericFixtures)('$id has full supported kinematic rank and the declared load total', ({ model, total }) => {
    const checked = checkModelPhysics(model);
    expect(checked.diagnostics).toEqual([]);
    expect(checked.valid).toBe(true);
    expect(checked.stability.freeModes).toBe(0);
    expect(checked.loadTotals.LC1).toEqual(total);
  });
  test('detects an internal truss mechanism despite having supports and a connected graph', () => {
    const model = copy(3); model.elements = model.elements.filter(element => element.id !== 'AB');
    expect(codes(model)).toContain('KINEMATIC_MECHANISM');
  });
  test('detects a rigid-body mode when the frame has no supports', () => {
    const model = copy(0); for (const node of model.nodes) delete node.restraints;
    expect(codes(model)).toEqual(expect.arrayContaining(['SUPPORTS_MISSING', 'KINEMATIC_MECHANISM']));
  });
  test('rejects orphan nodes, zero-length and duplicate members', () => {
    const model = copy(0); model.nodes.push({ id: 'orphan', x: 20, y: 0, z: 0 });
    model.elements.push({ ...model.elements[0], id: 'copy' }, { ...model.elements[0], id: 'zero', nodes: ['F00', 'F00'] });
    expect(codes(model)).toEqual(expect.arrayContaining(['DUPLICATE_MEMBER', 'ZERO_LENGTH_MEMBER', 'ORPHAN_NODES']));
  });
  test('vertical beam roles need an explicit physical reason; truss chords do not', () => {
    const model = copy(0); model.elements[0].type = 'beam';
    expect(codes(model)).toContain('VERTICAL_BEAM_ROLE');
    model.elements[0].metadata = { roleReason: 'User explicitly models this vertical hanger as a beam.' };
    expect(codes(model)).not.toContain('VERTICAL_BEAM_ROLE');
  });
  test('independently supported disconnected structures are reported without a false mechanism', () => {
    const model = copy(0), second = copy(0);
    for (const node of second.nodes) { node.id += '-2'; node.x += 20; }
    for (const element of second.elements) { element.id += '-2'; element.nodes = element.nodes.map(id => id + '-2'); }
    model.nodes.push(...second.nodes); model.elements.push(...second.elements);
    const checked = checkModelPhysics(model);
    expect(checked.valid).toBe(true);
    expect(checked.diagnostics).toEqual([expect.objectContaining({ code: 'DISCONNECTED_COMPONENTS', severity: 'warning' })]);
  });
  test('hinged end rotations are gauges, while loss of the roller translation is a real mode', () => {
    const model = copy(3); model.elements = [{ id: 'AB', type: 'beam', nodes: ['A', 'B'], material: 'Q235', section: 'R', releases: { i: { ry: true }, j: { ry: true } } }];
    model.nodes = [{ id: 'A', x: 0, y: 0, z: 0, restraints: [true, true, true, false, false, false] }, { id: 'B', x: 6, y: 0, z: 0, restraints: [false, true, true, false, false, false] }];
    model.load_cases = [];
    expect(codes(model)).toEqual([]);
    model.nodes[0].restraints[0] = false;
    expect(codes(model)).toContain('KINEMATIC_MECHANISM');
  });
  test('compares all load cases to confirmed loads, including member-local UDL', () => {
    const model = copy(0); const original = structuredClone(model.load_cases);
    model.load_cases[0].loads[0].fx = 20;
    expect(checkModelPhysics(model, { loadCases: original }).diagnostics).toContainEqual(expect.objectContaining({ code: 'LOAD_TOTAL_MISMATCH', details: { expected: [60, 0, 0], actual: [70, 0, 0] } }));
    const beam = model.elements.find(element => element.type === 'beam');
    model.load_cases = [{ id: 'L', loads: [{ type: 'distributed', element: beam.id, reference_frame: 'element-local', wz: -2, start: 1, end: 4 }] }];
    // Planar local Z is vertical for a horizontal member.
    expect(appliedLoadTotals(model).L).toEqual([0, 0, -6]);
  });
});
