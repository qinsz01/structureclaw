import { describe, expect, test } from '@jest/globals';
import { handler } from '../../../../../dist/agent-skills/structure-type/concrete-frame/handler.js';
import { detectConcreteFrameStructuralType } from '../../../../../dist/agent-skills/structure-type/concrete-frame/detect.js';
import { mergeConcreteFrameState } from '../../../../../dist/agent-skills/structure-type/concrete-frame/merge.js';
import { buildConcreteFrameQuestions } from '../../../../../dist/agent-skills/structure-type/concrete-frame/interaction.js';

describe('concrete-frame handler composed modules', () => {
  test('leaves follow-up sticky routing to the runtime registry', () => {
    const match = detectConcreteFrameStructuralType({
      message: '层高3.6m',
      locale: 'zh',
      currentState: {
        inferredType: 'concrete-frame',
        structuralTypeKey: 'concrete-frame',
        supportLevel: 'supported',
        updatedAt: 0,
      },
    });

    expect(match).toBeNull();
  });

  test('does not treat material and sections as critical blockers', () => {
    const missing = handler.computeMissing({
      inferredType: 'concrete-frame',
      frameDimension: '2d',
      storyCount: 2,
      bayCount: 2,
      storyHeightsM: [3, 3],
      bayWidthsM: [6, 6],
      floorLoads: [
        { story: 1, verticalKN: 120, lateralXKN: 30 },
        { story: 2, verticalKN: 120, lateralXKN: 30 },
      ],
      updatedAt: 0,
    }, 'execution');

    expect(missing.critical).toEqual([]);
  });

  test('uses only structured engineeringDraft fields for extraction', () => {
    const patch = handler.extractDraft({
      message: '三层混凝土框架，x方向4跨，间隔6m，每层3m，每层竖向荷载100kN',
      locale: 'zh',
      llmDraftPatch: {
        engineeringDraft: {
          structureType: 'concrete-frame',
          geometry: {
            storyHeightsM: [3.6, 3.6],
            bayWidthsM: [6],
          },
          material: { family: 'concrete', grade: 'C35', rebarGrade: 'HRB400' },
          sections: { column: '500x500', beam: '300x600' },
          loads: [
            { kind: 'nodal', magnitude: 120, unit: 'kN', direction: 'gravity', target: 'floor' },
          ],
        },
      },
    });

    expect(patch.engineeringDraft).toBeDefined();
    expect(patch.frameDimension).toBe('2d');
    expect(patch.storyCount).toBe(2);
    expect(patch.bayCount).toBe(1);
    expect(patch.frameConcreteGrade).toBe('C35');
    expect(patch.frameRebarGrade).toBe('HRB400');
    expect(patch.frameColumnSection).toBe('500x500');
    expect(patch.frameBeamSection).toBe('300x600');
    expect(patch.floorLoads).toEqual([
      { story: 1, verticalKN: 120, lateralXKN: undefined, lateralYKN: undefined },
      { story: 2, verticalKN: 120, lateralXKN: undefined, lateralYKN: undefined },
    ]);
  });

  test('keeps total-load wording in interaction questions', () => {
    const [question] = buildConcreteFrameQuestions(
      ['floorLoads'],
      ['floorLoads'],
      { inferredType: 'concrete-frame', frameDimension: '2d', updatedAt: 0 },
      'zh',
    );

    expect(question.question).toContain('各层总荷载');
    expect(question.question).not.toContain('节点荷载');
  });

  test('merges y-direction follow-up loads into existing 3d concrete-frame state', () => {
    const state = mergeConcreteFrameState(
      {
        inferredType: 'concrete-frame',
        frameDimension: '3d',
        floorLoads: [
          { story: 1, verticalKN: 90, lateralXKN: 18 },
          { story: 2, verticalKN: 90, lateralXKN: 18 },
        ],
        updatedAt: 0,
      },
      {
        inferredType: 'concrete-frame',
        floorLoads: [
          { story: 1, lateralYKN: 12 },
          { story: 2, lateralYKN: 12 },
        ],
      },
    );

    expect(state.floorLoads).toEqual([
      { story: 1, verticalKN: 90, lateralXKN: 18, lateralYKN: 12 },
      { story: 2, verticalKN: 90, lateralXKN: 18, lateralYKN: 12 },
    ]);
  });

  test('does not mark floorLoads missing when llm omits story numbers', () => {
    const patch = handler.extractDraft({
      message: '两层3D混凝土框架，X向2跨每跨6m，Y向1跨6m，层高3.6m，每层总竖向荷载432kN',
      locale: 'zh',
      currentState: undefined,
      llmDraftPatch: {
        inferredType: 'concrete-frame',
        frameDimension: '3d',
        storyCount: 2,
        bayCountX: 2,
        bayCountY: 1,
        storyHeightsM: [3.6, 3.6],
        bayWidthsXM: [6, 6],
        bayWidthsYM: [6],
        floorLoads: [
          { verticalKN: 432 },
          { verticalKN: 432 },
        ],
      },
      structuralTypeMatch: {
        key: 'concrete-frame',
        mappedType: 'frame',
        skillId: 'concrete-frame',
        supportLevel: 'supported',
      },
    });
    const state = handler.mergeState(undefined, patch);
    const missing = handler.computeMissing(state, 'execution');

    expect(state.floorLoads).toEqual([
      { story: 1, verticalKN: 432 },
      { story: 2, verticalKN: 432 },
    ]);
    expect(missing.critical).not.toContain('floorLoads');
  });

  test('does not mark floorLoads missing when semantic line loads are present', () => {
    const missing = handler.computeMissing({
      inferredType: 'concrete-frame',
      structuralTypeKey: 'concrete-frame',
      frameDimension: '2d',
      storyCount: 2,
      bayCount: 1,
      storyHeightsM: [3.6, 3.6],
      bayWidthsM: [6],
      engineeringDraft: {
        structureType: 'concrete-frame',
        loads: [
          { kind: 'line', magnitude: 20, unit: 'kN/m', direction: 'gravity' },
        ],
      },
      frameConcreteGrade: 'C30',
      frameRebarGrade: 'HRB400',
      frameColumnSection: '500X500',
      frameBeamSection: '300X600',
      frameBaseSupportType: 'fixed',
      updatedAt: 0,
    }, 'execution');

    expect(missing.critical).not.toContain('floorLoads');
  });

  test('the interactive phase never requires or asks for the rebar grade', () => {
    const state = { inferredType: 'concrete-frame', structuralTypeKey: 'concrete-frame', frameDimension: '2d', storyCount: 2, bayCount: 1,
      storyHeightsM: [3.6, 3.6], bayWidthsM: [6], frameBaseSupportType: 'fixed', updatedAt: 0,
      engineeringDraft: { structureType: 'concrete-frame', loads: [{ kind: 'line', magnitude: 20, unit: 'kN/m', direction: 'gravity' }] } };
    const missing = handler.computeMissing(state, 'interactive');
    expect(missing.critical).toEqual(expect.arrayContaining(['frameConcreteGrade', 'frameColumnSection', 'frameBeamSection']));
    expect(missing.critical).not.toContain('frameRebarGrade');
    const questions = buildConcreteFrameQuestions(missing.critical, missing.critical, state, 'zh');
    expect(questions.map(question => question.paramKey)).not.toContain('frameRebarGrade');
    const complete = { ...state, frameConcreteGrade: 'C30', frameColumnSection: '500X500', frameBeamSection: '300X600' };
    expect(handler.computeMissing(complete, 'interactive').critical).toEqual([]);
  });

  test('preserves existing floor loads when semantic line loads are added', () => {
    const existingState = {
      inferredType: 'concrete-frame',
      structuralTypeKey: 'concrete-frame',
      frameDimension: '2d',
      storyCount: 2,
      bayCount: 1,
      storyHeightsM: [3.6, 3.6],
      bayWidthsM: [6],
      floorLoads: [
        { story: 1, verticalKN: 360, liveLoadKN: 72, lateralXKN: 20 },
        { story: 2, verticalKN: 360, liveLoadKN: 72, lateralXKN: 20 },
      ],
      frameConcreteGrade: 'C30',
      frameRebarGrade: 'HRB400',
      frameColumnSection: '500X500',
      frameBeamSection: '300X600',
      frameBaseSupportType: 'fixed',
      updatedAt: 0,
    };
    const patch = handler.extractDraft({
      message: '增加梁上均布荷载20kN/m',
      locale: 'zh',
      currentState: existingState,
      llmDraftPatch: {
        engineeringDraft: {
          structureType: 'concrete-frame',
          loads: [
            { kind: 'line', magnitude: 20, unit: 'kN/m', direction: 'gravity' },
          ],
        },
      },
      structuralTypeMatch: {
        key: 'concrete-frame',
        mappedType: 'frame',
        skillId: 'concrete-frame',
        supportLevel: 'supported',
      },
    });
    const state = handler.mergeState(existingState, patch);

    expect(state.floorLoads).toEqual([
      { story: 1, verticalKN: 360, liveLoadKN: 72, lateralXKN: 20 },
      { story: 2, verticalKN: 360, liveLoadKN: 72, lateralXKN: 20 },
    ]);
  });

  test('drops same-patch stale dead floor loads when semantic line loads are present', () => {
    const existingState = {
      inferredType: 'concrete-frame',
      structuralTypeKey: 'concrete-frame',
      frameDimension: '2d',
      storyCount: 1,
      bayCount: 1,
      storyHeightsM: [3.6],
      bayWidthsM: [6],
      frameConcreteGrade: 'C30',
      frameRebarGrade: 'HRB400',
      frameColumnSection: '500X500',
      frameBeamSection: '300X600',
      frameBaseSupportType: 'fixed',
      updatedAt: 0,
    };
    const patch = handler.extractDraft({
      message: '梁上均布荷载60kN/m，同时活荷载72kN',
      locale: 'zh',
      currentState: existingState,
      llmDraftPatch: {
        floorLoads: [{ story: 1, verticalKN: 360, liveLoadKN: 72, lateralXKN: 20 }],
        engineeringDraft: {
          structureType: 'concrete-frame',
          loads: [
            { kind: 'line', magnitude: 60, unit: 'kN/m', direction: 'gravity' },
          ],
        },
      },
      structuralTypeMatch: {
        key: 'concrete-frame',
        mappedType: 'frame',
        skillId: 'concrete-frame',
        supportLevel: 'supported',
      },
    });
    const state = handler.mergeState(existingState, patch);

    expect(state.floorLoads).toEqual([
      { story: 1, liveLoadKN: 72, lateralXKN: 20 },
    ]);
  });

  test('does not treat non-gravity line loads as executable gravity loads', () => {
    const missing = handler.computeMissing({
      inferredType: 'concrete-frame',
      structuralTypeKey: 'concrete-frame',
      frameDimension: '2d',
      storyCount: 2,
      bayCount: 1,
      storyHeightsM: [3.6, 3.6],
      bayWidthsM: [6],
      engineeringDraft: {
        structureType: 'concrete-frame',
        loads: [
          { kind: 'line', magnitude: 20, unit: 'kN/m', direction: 'globalX' },
        ],
      },
      frameConcreteGrade: 'C30',
      frameRebarGrade: 'HRB400',
      frameColumnSection: '500X500',
      frameBeamSection: '300X600',
      frameBaseSupportType: 'fixed',
      updatedAt: 0,
    }, 'execution');

    expect(missing.critical).toContain('floorLoads');
  });
});

describe('concrete-frame reinforcement provenance', () => {
  test.each(['2d', '3d'])('%s geometry template does not invent reinforcement for code checking', (frameDimension) => {
    const model = handler.buildModel({
      inferredType: 'frame', structuralTypeKey: 'concrete-frame', frameDimension,
      storyCount: 2, storyHeightsM: [3.6, 3.6],
      ...(frameDimension === '2d'
        ? { bayCount: 2, bayWidthsM: [6, 6] }
        : { bayCountX: 2, bayCountY: 1, bayWidthsXM: [6, 6], bayWidthsYM: [5] }),
      floorLoads: [{ story: 1, verticalKN: 120 }, { story: 2, verticalKN: 120 }],
      frameConcreteGrade: 'C30', frameRebarGrade: 'HRB400',
      frameColumnSection: '500X500', frameBeamSection: '300X600',
      frameBaseSupportType: 'fixed', updatedAt: 0,
    });
    expect(model).toBeDefined();
    expect(model.elements.some(e => e.type === 'beam')).toBe(true);
    expect(model.elements.some(e => e.type === 'column')).toBe(true);
    for (const element of model.elements) {
      for (const key of ['As', 'Asv', 'main_dia', 'bar_count', 'sn', 'stirrup_dia', 'stirrup_spacing', 'cover', 'crack_cover', 'reinforcement']) {
        expect(element[key]).toBeUndefined();
        expect(element.metadata?.[key]).toBeUndefined();
      }
    }
  });
});
