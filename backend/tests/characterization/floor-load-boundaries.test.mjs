import { describe, expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { internalResponder, runTurn, setupHarness, toolResultSeenByAgent } from './helpers/harness.mjs';

describe('unresolved floor area through the persisted chat API', () => {
  const ctx = setupHarness();
  test.each(['frame', 'concrete-frame'])('%s retains the area declaration and cannot publish a model or analysis', async skillId => {
    const area = { id: 'floor', kind: 'area', magnitude: 10, unit: 'kN/m2', direction: 'gravity', target: 'all-stories', caseId: 'DL', caseType: 'dead' };
    const draft = { engineeringDraft: { structureType: skillId, coordinateSystem: { dimension: '2d' },
      geometry: { storyHeightsM: [3], bayWidthsM: [6] },
      material: skillId === 'frame' ? { family: 'steel', grade: 'Q235' } : { family: 'concrete', grade: 'C40', rebarGrade: 'HRB500' },
      sections: { beam: '300X600', column: '500X500' }, boundary: { frameBaseSupportType: 'fixed' }, analysisControl: { self_weight: false },
      loads: [area, { id: 'node', kind: 'nodal', magnitude: 2, unit: 'kN', direction: 'gravity', target: 'N1_1', caseId: 'POINT', caseType: 'dead' }] },
      requestScope: { responses: ['reactions'], design: false, report: false, outputs: [] } };
    ctx.llm.setInternal(internalResponder({ 'param-extractor': () => draft }));
    const turn = await runTurn(ctx, { message: `Use only these confirmed facts; do not invent a loaded width or floor area. ${JSON.stringify(draft)}`,
      context: { locale: 'en', runPolicy: { skillIds: [skillId], routing: { mode: 'fixed', skillId } } } }, [
      toolCall('extract_draft_params', { locale: 'en' }, `${skillId}-extract`),
      toolCall('build_model', {}, `${skillId}-build`), 'MISSING_AREA',
    ], { expectedToolErrors: 1 });
    const extraction = toolResultSeenByAgent(turn.requests, `${skillId}-extract`);
    expect(extraction.criticalMissing).toContain('frameFloorArea');
    expect(extraction.extractionMode).toBe('llm');
    expect(toolResultSeenByAgent(turn.requests, `${skillId}-build`).success).toBe(false);
    const session = await ctx.backend.session(turn.conversationId);
    expect(session.analysis.current).toBe(false);
    expect(session.report.current).toBe(false);
    const review = await ctx.backend.inputReview(turn.conversationId);
    expect(review.model).toBeNull();
  }, 60_000);
});
