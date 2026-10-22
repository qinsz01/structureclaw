import { describe, expect, test } from '@jest/globals';
import { build2dBeamLineLoads, build3dBeamLineLoads } from '../../../dist/agent-skills/structure-type/frame/model/loads.js';
import { build2dConcreteBeamLineLoads, build3dConcreteBeamLineLoads } from '../../../dist/agent-skills/structure-type/concrete-frame/model/loads.js';

const elements = [
  { id: 'C1', type: 'column', story: 'F1' },
  ...[1, 2].flatMap(story => [1, 2].map(span => ({ id: `B${story}${span}`, type: 'beam', story: `F${story}` }))),
];
const spatial = [1, 2].flatMap(story => ['X', 'Y'].map(axis => ({ id: `B${axis}${story}`, type: 'beam', story: `F${story}` })));
const load = extra => ({ kind: 'line', magnitude: 8, unit: 'kN/m', direction: 'gravity', ...extra });
const implementations = [
  ['steel', (loads, beams, dimension) => (dimension === '3d' ? build3dBeamLineLoads : build2dBeamLineLoads)(
    { engineeringDraft: { loads } }, 2, beams).map(item => item.record)],
  ['concrete', (loads, beams, dimension) => (dimension === '3d' ? build3dConcreteBeamLineLoads : build2dConcreteBeamLineLoads)(
    { loads }, 2, beams)],
];

describe.each(implementations)('%s frame line targets use structured selectors', (_name, build) => {
  test.each([undefined, 'not-roof', '除了屋顶', '第二层梁', 'the beam at floor 1', 'unknown-member', 'b11'])('rejects absent or ambiguous target %s instead of loading all or roof beams', target => {
    expect(() => build([load({ target })], elements, '2d')).toThrow('FRAME_LINE_TARGET_UNRESOLVED');
  });

  test('a story does not turn an unknown member description into all beams on that story', () => {
    expect(() => build([load({ target: 'not B11', location: { story: 1 } })], elements, '2d')).toThrow('FRAME_LINE_TARGET_UNRESOLVED');
  });

  test('applies exact member IDs and structured story/span once', () => {
    expect(build([load({ target: 'B11' }), load({ location: { story: 2, spanIndex: 2 } })], elements, '2d'))
      .toEqual([expect.objectContaining({ element: 'B11', wz: -8 }), expect.objectContaining({ element: 'B22', wz: -8 })]);
  });

  test('explicit story, roof and all-beam selectors retain their distinct scope', () => {
    expect(build([load({ location: { story: 1 } })], elements, '2d').map(item => item.element)).toEqual(['B11', 'B12']);
    expect(build([load({ target: 'roof' })], elements, '2d').map(item => item.element)).toEqual(['B21', 'B22']);
    expect(build([load({ target: 'all-beams' })], elements, '2d').map(item => item.element)).toEqual(['B11', 'B12', 'B21', 'B22']);
    expect(build([load({ target: 'all-stories' })], elements, '2d')).toHaveLength(4);
  });

  test.each([0, -1, 3, 1.5])('rejects invalid structured story %s rather than using a roof fallback', story => {
    expect(() => build([load({ target: 'roof', location: { story } })], elements, '2d')).toThrow('MODEL_EDIT_FIELD_INVALID');
  });

  test('rejects out-of-range spans, conflicting IDs, nonbeams and empty selections', () => {
    for (const extra of [{ location: { story: 1, spanIndex: 3 } }, { target: 'B11', location: { story: 2 } },
      { target: 'B11', location: { spanIndex: 2 } }, { target: 'C1' }]) {
      expect(() => build([load(extra)], elements, '2d')).toThrow('FRAME_LINE_TARGET_UNRESOLVED');
    }
    expect(() => build([load({ target: 'all-beams' })], elements.filter(item => item.story === 'F1'), '2d')).toThrow('FRAME_LINE_TARGET_UNRESOLVED');
  });

  test('3D axis selectors require an explicit story and cannot silently use span numbers', () => {
    expect(build([load({ target: 'x-beams', location: { story: 1 } }), load({ target: 'y-beams', location: { story: 2 } })], spatial, '3d')
      .map(item => item.element)).toEqual(['BX1', 'BY2']);
    for (const extra of [{ target: 'x-beams' }, { target: 'X轴梁', location: { story: 1 } },
      { location: { story: 1, spanIndex: 1 } }]) {
      expect(() => build([load(extra)], spatial, '3d')).toThrow('FRAME_LINE_TARGET_UNRESOLVED');
    }
  });
});
