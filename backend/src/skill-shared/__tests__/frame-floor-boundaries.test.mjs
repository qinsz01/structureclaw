import { handler as frame } from '../../../dist/agent-skills/structure-type/frame/handler.js';
import { handler as concrete } from '../../../dist/agent-skills/structure-type/concrete-frame/handler.js';

const input = (skillId, dimension, geometry, loads) => ({
  engineeringDraft: {
    structureType: skillId, coordinateSystem: { dimension },
    geometry: { storyHeightsM: [3], ...geometry },
    material: skillId === 'frame' ? { family: 'steel', grade: 'Q235' } : { family: 'concrete', grade: 'C40', rebarGrade: 'HRB500' },
    sections: { beam: '300X600', column: '500X500' },
    boundary: { frameBaseSupportType: 'fixed' }, analysisControl: { self_weight: false },
    loads, analysis: { loadCombinations: [] },
  },
  requestScope: { design: false, report: false, responses: ['reactions'], outputs: [] },
});
const area = { id: 'floor', kind: 'area', unit: 'kN/m2', magnitude: 10, direction: 'gravity', target: 'all-stories', caseId: 'DL', caseType: 'dead' };
const total = { ...area, kind: 'nodal', unit: 'kN', magnitude: 100 };
const stateFor = (handler, patch) => handler.mergeState(undefined, handler.extractDraft({ llmDraftPatch: patch }));

describe.each([['frame', frame], ['concrete-frame', concrete]])('%s floor geometry boundaries', (skillId, handler) => {
  test.each([false, true])('retains unconvertible area facts and blocks execution, extra node load=%s', extraNode => {
    const loads = [area, ...(extraNode ? [{ ...total, id: 'node', target: 'N1_1', caseId: 'POINT', magnitude: 2 }] : [])];
    const patch = input(skillId, '2d', { bayWidthsM: [6] }, loads);
    const before = structuredClone(patch);
    const state = stateFor(handler, patch);
    expect(state.floorLoads?.some(load => load.verticalKN !== undefined)).not.toBe(true);
    expect(state.engineeringDraft.loads).toEqual(loads);
    expect(handler.computeMissing(state, 'execution').critical).toContain('frameFloorArea');
    expect(handler.buildModel(state)).toBeUndefined();
    for (const locale of ['en', 'zh']) {
      const [question] = handler.buildQuestions(['frameFloorArea'], ['frameFloorArea'], state, locale);
      expect(question).toMatchObject({ paramKey: 'frameFloorArea', critical: true });
      expect(question.question).toContain('kN');
      expect(question.suggestedValue).toBeUndefined();
    }
    expect(patch).toEqual(before);
  });

  test('does not invent both plan axes from a directionless 3-D bay array', () => {
    const state = stateFor(handler, input(skillId, '3d', { bayWidthsM: [6] }, [area]));
    expect(state.bayWidthsXM).toBeUndefined();
    expect(state.bayWidthsYM).toBeUndefined();
    expect(handler.computeMissing(state, 'execution').critical).toContain('frameFloorArea');
    expect(handler.buildModel(state)).toBeUndefined();
  });

  test('converts confirmed unequal X/Y floor dimensions without assuming a square', () => {
    const state = stateFor(handler, input(skillId, '3d', { bayWidthsXM: [4], bayWidthsYM: [5] }, [area]));
    expect(state.floorLoads).toEqual([{ story: 1, verticalKN: 200 }]);
    expect(handler.computeMissing(state, 'execution').critical).not.toContain('frameFloorArea');
    expect(handler.buildModel(state).stories[0].dead_load).toBe(10);
  });

  test.each(['magnitude', 'geometry', 'scope', 'caseType'])('recomputes floor totals after a partial %s edit', edit => {
    const patch = input(skillId, '3d', { bayWidthsXM: [4], bayWidthsYM: [5] }, [area]);
    patch.engineeringDraft.geometry.storyHeightsM = [3, 3];
    const old = stateFor(handler, patch);
    const before = structuredClone(old);
    const update = edit === 'geometry' ? { geometry: { bayWidthsXM: [8] } }
      : { loads: [{ ...area, ...(edit === 'magnitude' ? { magnitude: 12 }
        : edit === 'scope' ? { target: 'top-story' } : { caseType: 'live' }) }] };
    const next = handler.mergeState(old, handler.extractDraft({ currentState: old, llmDraftPatch: { engineeringDraft: update } }));
    const model = handler.buildModel(next);
    if (edit === 'scope') {
      expect(model.stories.map(story => story.dead_load)).toEqual([undefined, 10]);
      expect(next.floorLoads).toEqual([{ story: 2, verticalKN: 200 }]);
    } else if (edit === 'caseType') {
      expect(model.stories.map(story => [story.dead_load, story.live_load])).toEqual([[undefined, 10], [undefined, 10]]);
      expect(model.load_cases.map(item => [item.id, item.type])).toEqual([['DL', 'live']]);
    } else {
      expect(model.stories.map(story => story.dead_load)).toEqual([edit === 'magnitude' ? 12 : 10, edit === 'magnitude' ? 12 : 10]);
      expect(next.floorLoads.map(load => load.verticalKN)).toEqual(edit === 'magnitude' ? [240, 240] : [400, 400]);
    }
    expect(old).toEqual(before);
  });

  test('converts retained area facts when the missing Y geometry arrives in a later turn', () => {
    const old = stateFor(handler, input(skillId, '3d', { bayWidthsXM: [4] }, [area]));
    expect(handler.buildModel(old)).toBeUndefined();
    const next = handler.mergeState(old, handler.extractDraft({ currentState: old,
      llmDraftPatch: { engineeringDraft: { geometry: { bayWidthsYM: [5] } } } }));
    expect(next.floorLoads).toEqual([{ story: 1, verticalKN: 200 }]);
    expect(handler.computeMissing(next, 'execution').critical).not.toContain('frameFloorArea');
    expect(handler.buildModel(next).stories[0].dead_load).toBe(10);
  });

  test.each([
    ['2d', { bayWidthsM: [0.5] }, 0.5],
    ['3d', { bayWidthsXM: [0.5], bayWidthsYM: [0.4] }, 0.2],
  ])('preserves total floor force below a one-metre span in %s', (dimension, geometry, areaM2) => {
    const state = stateFor(handler, input(skillId, dimension, geometry, [total]));
    const model = handler.buildModel(state);
    expect(model.stories[0].dead_load * areaM2).toBeCloseTo(100, 10);
  });

  test.each(['DL', 'L'])('explicit topology respects roof scope and the authored dead type for ID %s', caseId => {
    const patch = input(skillId, '3d', { bayWidthsXM: [4], bayWidthsYM: [5] }, [{ ...area, caseId, target: 'top-story' }]);
    patch.engineeringDraft.geometry.storyHeightsM = [3, 3];
    const nodes = [0, 1, 2].flatMap(story => [0, 1].flatMap(x => [0, 1].map(y => ({ id: `N${story}_${x}_${y}`, x: x * 4, y: y * 5, z: story * 3 }))));
    const members = [1, 2].flatMap(story => [0, 1].flatMap(x => [0, 1].map(y => ({
      id: `C${story}_${x}_${y}`, nodes: [`N${story - 1}_${x}_${y}`, `N${story}_${x}_${y}`],
    }))).concat([0, 1].map(y => ({ id: `B${story}_${y}`, nodes: [`N${story}_0_${y}`, `N${story}_1_${y}`] }))));
    patch.engineeringDraft.topology = { nodes, members };
    const model = handler.buildModel(stateFor(handler, patch));
    expect(model.stories.map(story => story.floor_loads)).toEqual([undefined, [{ type: 'dead', value: 10 }]]);
    expect(model.load_cases.map(item => [item.id, item.type])).toEqual([[caseId, 'dead']]);
  });
});
