import { describe, expect, test } from '@jest/globals';
import { handler as frame } from '../../../dist/agent-skills/structure-type/frame/handler.js';
import { handler as concrete } from '../../../dist/agent-skills/structure-type/concrete-frame/handler.js';

const floorLoad = (caseId, caseType, magnitude, target = 'all-stories', direction = 'gravity') => ({
  id: `${caseId ?? 'anonymous'}-${caseType}-${target}-${direction}`,
  kind: 'nodal', unit: 'kN', magnitude, target, direction, caseId, caseType,
});
const draft = (skillId, dimension, loads) => ({ engineeringDraft: {
  structureType: skillId, coordinateSystem: { dimension },
  geometry: { storyHeightsM: [3, 3.6], ...(dimension === '3d' ? { bayWidthsXM: [4], bayWidthsYM: [5] } : { bayWidthsM: [6] }) },
  material: skillId === 'frame' ? { family: 'steel', grade: 'Q235' } : { family: 'concrete', grade: 'C40', rebarGrade: 'HRB500' },
  sections: { beam: '300X600', column: '500X500' }, boundary: { frameBaseSupportType: 'fixed' },
  analysisControl: { self_weight: false }, loads,
  analysis: { loadCombinations: [{ id: 'ULS', factors: { DL: 1.3, LL: 1.5 } }] },
} });
const build = (handler, input) => {
  const state = handler.mergeState(undefined, handler.extractDraft({ llmDraftPatch: input }));
  return { state, model: handler.buildModel(state) };
};

describe.each([['frame', frame], ['concrete-frame', concrete]])('%s confirmed floor case identities', (skillId, handler) => {
  test.each(['2d', '3d'])('retains named dead/live totals, story scope and factors in %s', dimension => {
    const input = draft(skillId, dimension, [floorLoad('DL', 'dead', 100), floorLoad('LL', 'live', 50, 'top-story')]);
    const original = structuredClone(input);
    const { state, model } = build(handler, input);
    expect(state.floorLoads.map(load => [load.story, load.verticalKN, load.liveLoadKN])).toEqual([[1, 100, undefined], [2, 100, 50]]);
    expect(model.load_cases.map(load => [load.id, load.type])).toEqual([['DL', 'dead'], ['LL', 'live']]);
    expect(model.load_combinations).toEqual(input.engineeringDraft.analysis.loadCombinations);
    const area = dimension === '3d' ? 20 : 6;
    expect(model.stories.map(story => [story.dead_load, story.live_load])).toEqual([[100 / area, undefined], [100 / area, 50 / area]]);
    if (skillId === 'concrete-frame') {
      expect(model.load_cases.map(item => item.loads.reduce((sum, load) => sum + load.fz, 0))).toEqual([-200, -50]);
    }
    expect(input).toEqual(original);
  });

  test('preserves live area-load conversion and named lateral case', () => {
    const input = draft(skillId, '3d', [{ ...floorLoad('LL', 'live', 2.5), kind: 'area', unit: 'kN/m2' },
      floorLoad('WX+', 'wind', 20, 'all-stories', 'globalX')]);
    input.engineeringDraft.analysis.loadCombinations = [];
    const { state, model } = build(handler, input);
    expect(state.floorLoads.map(item => item.liveLoadKN)).toEqual([50, 50]);
    expect(model.load_cases.map(item => [item.id, item.type])).toEqual([['LL', 'live'], ['WX+', 'wind']]);
    expect(model.load_cases.find(item => item.id === 'WX+').loads.reduce((sum, item) => sum + item.fx, 0)).toBe(40);
  });

  test('analysis-only requests preserve named floor cases through the elastic handler path', () => {
    const input = draft(skillId, '3d', [floorLoad('DL', 'dead', 100), floorLoad('LL', 'live', 50, 'top-story')]);
    input.requestScope = { responses: ['forces'], design: false, report: false, outputs: [] };
    expect(build(handler, input).model.load_cases.map(item => [item.id, item.type])).toEqual([['DL', 'dead'], ['LL', 'live']]);
  });

  test('blank optional node roles do not discard named floor identities', () => {
    const input = draft(skillId, '3d', [floorLoad('DL', 'dead', 100),
      { ...floorLoad('LL', 'live', 50, 'top-story'), location: { nodeRole: ' ' } }]);
    expect(build(handler, input).model.load_cases.map(item => item.id)).toEqual(['DL', 'LL']);
  });

  test('a separate beam action cannot erase confirmed floor totals', () => {
    const input = draft(skillId, '2d', [floorLoad('DL', 'dead', 100), floorLoad('LL', 'live', 50, 'top-story'),
      { ...floorLoad('SDL', 'dead', 5), target: undefined, kind: 'line', unit: 'kN/m', location: { story: 2, spanIndex: 1 } }]);
    input.requestScope = { responses: ['forces'], design: false, report: false, outputs: [] };
    const { state, model } = build(handler, input);
    expect(state.floorLoads.map(item => item.verticalKN)).toEqual([100, 100]);
    expect(model.load_cases.map(item => [item.id, item.type])).toEqual([['DL', 'dead'], ['LL', 'live'], ['SDL', 'dead']]);
    expect(model.stories.map(item => item.dead_load)).toEqual([100 / 6, 100 / 6]);
  });

  test.each([
    [floorLoad('DL', 'dead', 100), floorLoad('SDL', 'dead', 20)],
    [floorLoad('DL', 'dead', 100), floorLoad(undefined, 'dead', 20)],
    [floorLoad('WX', 'wind', 10, 'all-stories', 'globalX'), floorLoad('WY', 'wind', 20, 'all-stories', 'globalY')],
    [floorLoad('TEMP', 'other', 10)],
    [{ ...floorLoad('DL', 'dead', 100), location: { spanIndex: 1 } }],
  ])('rejects a lossy floor-channel projection %# without changing confirmed input', (...loads) => {
    const input = draft(skillId, '3d', loads);
    input.engineeringDraft.analysis.loadCombinations = [];
    const original = structuredClone(input);
    expect(() => build(handler, input)).toThrow('FRAME_FLOOR_CASE_UNSUPPORTED');
    expect(input).toEqual(original);
  });

  test('rejects the same case ID with contradictory dead/live types', () => {
    const input = draft(skillId, '3d', [floorLoad('SAME', 'dead', 100), floorLoad('SAME', 'live', 50)]);
    expect(() => build(handler, input)).toThrow('FRAME_CASE_TYPE_CONFLICT');
  });
});

test('steel frame refuses mixed floor/explicit loads instead of dropping the floor load', () => {
  const input = draft('frame', '3d', [floorLoad('DL', 'dead', 100), floorLoad('DL', 'dead', 5, 'N2_1_1')]);
  expect(() => build(frame, input)).toThrow('FRAME_FLOOR_CASE_UNSUPPORTED');
});

test('concrete beam line loads retain separate source cases and combination references', () => {
  const input = draft('concrete-frame', '2d', [
    { ...floorLoad('DL', 'dead', 8), target: undefined, location: { story: 1, spanIndex: 1 }, kind: 'line', unit: 'kN/m' },
    { ...floorLoad('LL', 'live', 3), target: undefined, location: { story: 2, spanIndex: 1 }, kind: 'line', unit: 'kN/m' },
  ]);
  const { model } = build(concrete, input);
  expect(model.load_cases.map(item => [item.id, item.type, item.loads.length])).toEqual([['DL', 'dead', 1], ['LL', 'live', 1]]);
  expect(model.load_combinations).toEqual(input.engineeringDraft.analysis.loadCombinations);
  expect(model.load_cases.map(item => item.loads[0].wz)).toEqual([-8, -3]);
});
