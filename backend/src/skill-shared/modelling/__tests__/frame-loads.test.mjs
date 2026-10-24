import { expect, test } from '@jest/globals';
import { handler as concrete } from '../../../../dist/agent-skills/structure-type/concrete-frame/handler.js';
import { handler as frame } from '../../../../dist/agent-skills/structure-type/frame/handler.js';
import { appliedLoadTotals } from '../../../../dist/engineering/model-physics.js';

const state = loads => ({ inferredType: 'frame', updatedAt: 0, frameDimension: '3d', storyCount: 2, storyHeightsM: [3, 3],
  bayCountX: 2, bayCountY: 2, bayWidthsXM: [5, 5], bayWidthsYM: [5, 5], frameBaseSupportType: 'fixed',
  frameConcreteGrade: 'C30', frameMaterial: 'Q235', frameColumnSection: '400X400', frameBeamSection: '300X500',
  requestScope: { responses: ['forces', 'reactions'], design: false, report: false, outputs: [] },
  engineeringDraft: { loads, material: { family: 'concrete', grade: 'C30' }, sections: { beam: '300X500', column: '400X400' }, analysisControl: { self_weight: false } } });

test.each([['concrete',concrete],['frame',frame]])('%s node coordinate selectors retain floor scope without floor-total placeholders',(_name,handler)=>{
  const selected=state([{kind:'nodal',magnitude:10,unit:'kN',direction:'gravity',caseId:'nodes',location:{story:2},
    selector:{coordinate:{axis:'x',lte:5}}}]);
  expect(handler.computeMissing(selected,'execution').critical).toEqual([]);
  const model=handler.buildModel(selected),loadCase=model.load_cases.find(c=>c.id==='nodes');
  expect(loadCase.loads).toHaveLength(6);
  expect(loadCase.loads.every(l=>model.nodes.find(n=>n.id===l.node).z===6)).toBe(true);
  expect(appliedLoadTotals(model).nodes).toEqual([0,0,-60]);
  selected.engineeringDraft.loads[0]={kind:'nodal',magnitude:10,unit:'kN',direction:'gravity',caseId:'nodes',location:{story:1,nodeRole:'all-non-base-nodes'}};
  const scoped=handler.buildModel(selected);
  expect(scoped.load_cases[0].loads).toHaveLength(9);
  expect(scoped.load_cases[0].loads.every(l=>scoped.nodes.find(n=>n.id===l.node).z===3)).toBe(true);
});
test.each([['concrete', concrete], ['frame', frame]])('%s accepts every upper node at 100N without requiring a floor-load placeholder', (_name, handler) => {
  const draft = state([{ kind: 'nodal', magnitude: .1, unit: 'kN', direction: 'globalX', location: { nodeRole: 'all-non-base-nodes' }, caseId: 'PER_NODE' }]);
  expect(handler.computeMissing(draft, 'execution').critical).toEqual([]);
  const model = handler.buildModel(draft);
  const loads = model.load_cases.find(loadCase => loadCase.id === 'PER_NODE').loads;
  expect(loads).toHaveLength(18);
  expect(new Set(loads.map(load => load.node)).size).toBe(18);
  expect(appliedLoadTotals(model).PER_NODE[0]).toBeCloseTo(1.8, 12);
});
test.each([['concrete', concrete], ['frame', frame]])('%s preserves four named corner loads and rejects an unknown role', (_name, handler) => {
  const loads = ['x0y0', 'x0y2', 'x2y0', 'x2y2'].map(nodeRole => ({ kind: 'nodal', magnitude: 10, unit: 'kN', direction: 'globalX', location: { story: 2, nodeRole: `corner-${nodeRole}` }, caseId: 'CORNERS' }));
  expect(appliedLoadTotals(handler.buildModel(state(loads))).CORNERS).toEqual([40, 0, 0]);
  expect(() => handler.buildModel(state([{ ...loads[0], location: { story: 2, nodeRole: 'unspecified-joint' } }]))).toThrow('FRAME_NODAL_TARGET_UNRESOLVED');
  expect(() => handler.buildModel(state([...loads, { kind: 'nodal', magnitude: 4, unit: 'kN', direction: 'globalX', target: 'missing-user-node' }]))).toThrow('FRAME_NODAL_TARGET_UNRESOLVED');
});
