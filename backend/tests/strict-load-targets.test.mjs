import { expect, test } from '@jest/globals';
import { buildBeamLoads, buildColumnModel, buildSemanticBeamModel } from '../dist/agent-runtime/model-builder/beam.js';
import { buildContinuousBeamModel, buildPortalFrameModel } from '../dist/agent-runtime/model-builder/continuous.js';
import { buildTrussModel } from '../dist/agent-runtime/model-builder/truss.js';
import { buildFrame2dModel, buildFrame3dModel } from '../dist/agent-runtime/model-builder/frame.js';
import { buildModel } from '../dist/agent-runtime/model-builder.js';
import { withDeclaredProperties } from './fixtures/declared-template-properties.mjs';

const point = { kind: 'point', unit: 'kN', magnitude: 5, direction: 'gravity' };
const line = { kind: 'line', unit: 'kN/m', magnitude: 2, direction: 'gravity' };
const beam = { inferredType: 'beam', lengthM: 10, supportType: 'simply-supported', updatedAt: 0 };
const withLoads = (state, loads) => ({ ...state, engineeringDraft: { ...state.engineeringDraft, loads } });
const targets = model => model.load_cases[0].loads;
const buildBeam = load => buildSemanticBeamModel({ ...beam, loadPositionM: 5 }, {}, [load]);

test.each([undefined, 'not the free end', '不是端部', 'maybe midspan', 'beam'])('beam point load never guesses a location from %j', target => {
  expect(() => buildBeam({ ...point, target })).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test.each([-1, 11, Number.NaN])('beam rejects out-of-range/invalid coordinate %s without snapping to a node', xM => {
  expect(() => buildBeam({ ...point, location: { xM } })).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test.each([undefined, 'not all beams', 'some beam', '屋面梁'])('beam line load never expands an unknown target %j to the whole beam', target => {
  expect(() => buildBeam({ ...line, target })).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test('explicit beam coordinates and canonical selectors preserve physical targets', () => {
  const model = buildSemanticBeamModel(beam, {}, [{ ...point, location: { xM: 3 } }, { ...point, location: { nodeRole: 'end' } }, { ...line, target: 'full-span' }]);
  for (const x of [3, 10]) {
    const node = model.nodes.find(node => node.x === x);
    expect(targets(model)).toContainEqual({ node: node.id, fz: -5 });
  }
  expect(targets(model).filter(load => load.type === 'distributed')).toHaveLength(model.elements.length);
});
test('legacy beam loads require the recorded position instead of treating missing position as midspan', () => {
  expect(() => buildBeamLoads(5, 'point', undefined, '2', '3')).toThrow('MODEL_EDIT_FIELD_INVALID');
  expect(() => buildBeamLoads(5, 'distributed', undefined, '2', '3')).toThrow('MODEL_EDIT_FIELD_INVALID');
  expect(buildBeamLoads(5, 'point', undefined, '2', '3', 3)).toEqual([{ node: '2', fz: -5 }]);
});
test('canonical beam loads cannot be bypassed by a stale valid legacy mirror', () => {
  const state = withLoads({ ...beam, loadType: 'point', loadKN: 5, loadPosition: 'midspan',
    skillState: { beamLoads: [{ ...point, location: { xM: 5 } }] } }, [{ ...point, target: 'unresolved' }]);
  expect(() => buildModel(state)).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test('direct semantic beam building cannot assume missing or unknown supports', () => {
  for (const supportType of [undefined, 'unresolved']) {
    expect(() => buildSemanticBeamModel({ ...beam, supportType }, {}, [{ ...point, location: { xM: 5 } }]))
      .toThrow('MODEL_EDIT_FIELD_INVALID');
  }
});
test.each([0, 3, 5, 6.5])('legacy overhang preserves an explicit point at x=%s and the actual support locations', xM => {
  const state = withDeclaredProperties({ ...beam, lengthM: 6.5, loadType: 'point', loadKN: 5, loadPositionM: xM,
    skillState: { simpleSpanM: 5, overhangLengthM: 1.5 } });
  const model = buildModel(state);
  const force = targets(model)[0];
  expect(model.nodes.find(node => node.id === force.node).x).toBe(xM);
  expect(force.fz).toBe(-5);
  expect(model.nodes.filter(node => node.restraints).map(node => node.x)).toEqual([0, 5]);
});

const continuous = { inferredType: 'double-span-beam', spanLengthM: 4, updatedAt: 0, skillState: { spanLengthsM: [4, 7] } };
test('continuous beams require a point coordinate or selector within a selected span', () => {
  expect(() => buildContinuousBeamModel(withLoads(continuous, [{ ...point, location: { spanIndex: 2 } }]), {})).toThrow('MODEL_EDIT_FIELD_INVALID');
  const model = buildContinuousBeamModel(withLoads(continuous, [
    { ...point, location: { spanIndex: 2, nodeRole: 'midspan' } }, { ...point, direction: 'globalX', location: { xM: 2 } },
  ]), {});
  const middle = model.nodes.find(node => node.x === 7.5);
  const horizontal = model.nodes.find(node => node.x === 2);
  expect(targets(model)).toEqual([{ node: middle.id, fz: -5 }, { node: horizontal.id, fx: 5 }]);
});
test('continuous beams never default an unlocated point to the longest span', () => {
  expect(() => buildContinuousBeamModel({ ...continuous, skillState: { ...continuous.skillState, pointLoadKN: 5 } }, {})).toThrow('MODEL_EDIT_FIELD_INVALID');
});

const portal = { inferredType: 'portal-frame', spanLengthM: 5, heightM: 3, updatedAt: 0, skillState: { portalBaySpansM: [5, 5] } };
test.each(['not the right column', '无须施加在右柱', 'unknown'])('portal frames reject unrecognized load target %s', target => {
  expect(() => buildPortalFrameModel(withLoads(portal, [{ ...point, target }]), {})).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test('portal loads use exact IDs, canonical node roles and roof selectors', () => {
  const model = buildPortalFrameModel(withLoads(portal, [{ ...point, target: 'T0' },
    { ...point, direction: 'globalX', location: { nodeRole: 'middle-column-top' } }, { ...line, target: 'roof' }]), {});
  expect(targets(model)).toEqual([{ node: 'T0', fz: -5 }, { node: 'T1', fx: 5 },
    { type: 'distributed', element: 'R0', wz: -2 }, { type: 'distributed', element: 'R1', wz: -2 }]);
});
test('a portal span index cannot override an unrecognized or contradictory target', () => {
  expect(() => buildPortalFrameModel(withLoads(portal, [{ ...line, target: 'not roof', location: { spanIndex: 1 } }]), {}))
    .toThrow('MODEL_EDIT_FIELD_INVALID');
  expect(() => buildPortalFrameModel(withLoads(portal, [{ ...line, target: 'mezzanine', location: { spanIndex: 1 } }]), {}))
    .toThrow('MODEL_EDIT_FIELD_INVALID');
});
test('legacy portal crane magnitude cannot choose an arbitrary column top', () => {
  expect(() => buildPortalFrameModel({ ...portal, skillState: { ...portal.skillState, roofLoadKNM: 2, craneLoadKN: 5 } }, {})).toThrow('MODEL_EDIT_FIELD_INVALID');
});

const truss = { inferredType: 'truss', lengthM: 12, heightM: 3, bayCount: 4, loadKN: 5, loadPosition: 'top-nodes', updatedAt: 0 };
test.each(['not the upper chord', '不要加载上弦', 'unknown'])('truss target %s cannot fall back to all chord nodes', target => {
  expect(() => buildTrussModel(withLoads(truss, [{ ...point, target }]), {})).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test('truss explicit out-of-range coordinates cannot fall back to the whole chord', () => {
  expect(() => buildTrussModel(withLoads(truss, [{ ...point, location: { xM: 99, nodeRole: 'top' } }]), {})).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test('truss exact node and canonical chord selectors remain executable', () => {
  expect(targets(buildTrussModel(withLoads(truss, [{ ...point, target: 'T1' }]), {}))).toEqual([{ node: 'T1', fz: -5 }]);
  expect(targets(buildTrussModel(withLoads(truss, [{ ...point, location: { nodeRole: 'top' } }]), {}))).toHaveLength(3);
});
test('a legacy truss needs a recorded position instead of defaulting to every upper node', () => {
  expect(() => buildTrussModel({ ...truss, loadPosition: undefined }, {})).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test.each([
  { nodes: [{ id: 'A', x: 0, y: 0, z: 0 }] },
  { nodes: [{ id: 'A', x: 0, y: 0, z: 0 }, { id: 'A', x: 1, y: 0, z: 1 }], members: [{ id: 'E1', nodes: ['A', 'B'] }] },
  { nodes: [{ id: 'A', x: 0, y: 0, z: 0 }, { id: 'B', x: 1, y: 0, z: 1 }], members: [{ id: 'E1', nodes: ['A', 'C'] }] },
])('an invalid authored truss topology cannot be replaced with a generated template', topology => {
  expect(() => buildTrussModel({ ...truss, engineeringDraft: { topology } }, {})).toThrow('MODEL_EDIT_FIELD_INVALID');
});

test.each([undefined, -1, 0, 0.5, 2, Number.NaN])('frame builders reject invalid story %s instead of discarding the load', story => {
  const state = { inferredType: 'frame', bayWidthsM: [4], bayWidthsXM: [4], bayWidthsYM: [5], storyHeightsM: [3], floorLoads: [{ story, verticalKN: 5 }], updatedAt: 0 };
  for (const builder of [buildFrame2dModel, buildFrame3dModel]) expect(() => builder(state, {})).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test('column builders independently reject missing targets and preserve explicitly targeted lateral loads', () => {
  const column = { inferredType: 'column', heightM: 3, loadKN: 5, loadPosition: 'top-nodes', updatedAt: 0 };
  expect(() => buildColumnModel(withLoads(column, [{ ...point, target: 'not the top' }]), {})).toThrow('MODEL_EDIT_FIELD_INVALID');
  expect(() => buildColumnModel(withLoads(column, [point]), {})).toThrow('MODEL_EDIT_FIELD_INVALID');
  expect(targets(buildColumnModel(withLoads(column, [{ ...point, target: 'column-top', direction: 'globalX' }]), {})))
    .toEqual([{ node: '2', fx: 5 }]);
});
test.each([undefined, 'distributed'])('legacy column load type %s cannot become a top point load', loadType => {
  const state = { inferredType: 'column', heightM: 3, loadKN: 5, loadPosition: 'top-nodes', loadType, updatedAt: 0 };
  expect(() => buildColumnModel(state, {})).toThrow('MODEL_EDIT_FIELD_INVALID');
  expect(targets(buildColumnModel({ ...state, loadType: 'point' }, {}))).toEqual([{ node: '2', fz: -5 }]);
});
