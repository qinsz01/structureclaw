import { describe, test, expect } from '@jest/globals';
import { handler } from '../../../dist/agent-skills/structure-type/generic/handler.js';
import { computeDraftMissing } from '../../../dist/agent-runtime/draft-readiness.js';

describe('generic frame answer contract', () => {
  test.each(['fixed', '刚接', '嵌固', 'pinned'])('canonical support answer %s resolves the required base field', value => {
    const before = { inferredType: 'frame', skillId: 'generic', updatedAt: 0,
      engineeringDraft: { structureType: 'frame' },
      draftIssues: [{ field: 'boundary.frameBaseSupportType', kind: 'missing', severity: 'missing', reason: 'base required' }],
      skillState: { invalidDraftFields: ['boundary.frameBaseSupportType'] } };
    const patch = handler.extractDraft({ currentState: before, message: value, locale: 'zh',
      llmDraftPatch: { engineeringDraft: { boundary: { supportType: value } } } });
    const after = handler.mergeState(before, patch);
    expect(after.engineeringDraft.boundary.frameBaseSupportType).toBe(value === 'pinned' ? 'pinned' : 'fixed');
    expect(computeDraftMissing({ id: 'generic', handler }, after, 'execution').critical).not.toContain('boundary.frameBaseSupportType');
  });
});
import { buildModelToolSummary } from '../../../dist/agent-langgraph/tools/compaction/analysis.js';
import { buildFrameModel } from '../../../dist/agent-skills/structure-type/frame/model.js';
import { buildConcreteFrameModel } from '../../../dist/agent-skills/structure-type/concrete-frame/model.js';
import { buildFrame2dModel, buildFrame3dModel } from '../../../dist/agent-runtime/model-builder/frame.js';

for (const dimension of ['2d', '3d']) test(`unstated frame bases are fixed and disclosed in both locales (${dimension})`, () => {
  const state = { inferredType: 'frame', frameDimension: dimension, storyCount: 1, storyHeightsM: [3],
    bayCount: 1, bayWidthsM: [5], bayCountX: 1, bayCountY: 1, bayWidthsXM: [5], bayWidthsYM: [5],
    floorLoads: [{ story: 1, lateralXKN: 1 }], frameMaterial: 'C30', frameConcreteGrade: 'C30',
    frameBeamSection: '250X500', frameColumnSection: '400X400', updatedAt: 0,
    requestScope: { responses: ['forces'], design: false, report: false, outputs: [] } };
  const models = [buildFrameModel(state), buildConcreteFrameModel(state),
    dimension === '2d' ? buildFrame2dModel(state, {}) : buildFrame3dModel(state, {})];
  for (const model of models) {
    expect(model.nodes.filter(node => node.z === 0).every(node => node.restraints.every(Boolean))).toBe(true);
    expect(buildModelToolSummary(model, 'en').assumptions).toContain('Unstated frame bases default to fixed.');
    expect(buildModelToolSummary(model, 'zh').assumptions).toContain('未说明柱脚时默认刚接。');
  }
});
