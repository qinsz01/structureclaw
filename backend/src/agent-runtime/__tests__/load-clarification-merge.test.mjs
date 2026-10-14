import { expect, test } from '@jest/globals';
import { mergeEngineeringDraft } from '../../../dist/agent-runtime/engineering-draft.js';
const first = { structureType: 'beam', geometry: { lengthM: 10 }, loads: [{ kind: 'point', magnitude: 1, unit: 'kN', target: 'beam', location: { xM: 5, spanIndex: 1 } }] };
test('clarification refines load direction without doubling the force', () => {
  const next = mergeEngineeringDraft(first, { loads: [{ kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'midspan', location: { xM: 5 } }] });
  expect(next.loads).toHaveLength(1);
  expect(next.loads[0]).toMatchObject({ magnitude: 1, direction: 'gravity', location: { xM: 5 } });
  expect(first.loads[0].direction).toBeUndefined();
  expect(mergeEngineeringDraft(next, first).loads).toHaveLength(1);
  expect(mergeEngineeringDraft(next, first).loads[0].direction).toBe('gravity');
});
test.each([
  [{ direction: 'gravity' }, { direction: 'globalX' }],
  [{ caseId: 'D' }, { caseId: 'L' }],
  [{ id: 'one' }, { id: 'two' }],
  [{ location: { xM: 2 } }, { location: { xM: 5 } }],
])('preserves explicitly distinct loads %j versus %j', (before, after) => {
  const load = { kind: 'point', magnitude: 1, unit: 'kN', location: { xM: 5 } };
  const next = mergeEngineeringDraft({ structureType: 'beam', geometry: { lengthM: 10 }, loads: [{ ...load, ...before }] }, { loads: [{ ...load, ...after }] });
  expect(next.loads).toHaveLength(2);
});
