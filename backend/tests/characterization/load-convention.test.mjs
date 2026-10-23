import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, routerDecision, runTurn, setupHarness,
  queryResult, TURN_TIMEOUT_MS } from './helpers/harness.mjs';

describeWithOpenSees('characterization: signed loads with a stated convention', () => {
  const ctx = setupHarness();
  test.each(['en', 'zh'])('a negative downward load needs no direction question (%s)', async locale => {
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('beam'),
      'param-extractor': prompt => {
        expect(prompt).toContain('Ask only if the physical direction is undetermined');
        expect(prompt).toContain('仅方向不明确时追问');
        return { requestScope: { responses: ['forces', 'reactions'], design: false, report: false, outputs: [] }, engineeringDraft: {
          structureType: 'beam', geometry: { lengthM: 6 }, boundary: { supportType: 'simply-supported' },
          loads: [{ id: 'D', caseId: 'D', caseType: 'dead', kind: 'point', magnitude: 8, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 3 } }],
        } };
      },
    }));
    const message = locale === 'zh' ? '6m简支梁，Z向上为正，跨中集中荷载D=-8kN，仅求内力及反力。'
      : '6 m simply supported beam, positive Z is upward, central point load D=-8 kN. Forces and reactions only.';
    const turn = await runTurn(ctx, { message, context: { locale } }, [
      toolCall('extract_draft_params', { locale }, 'extract'), toolCall('build_model', {}, 'build'),
      toolCall('validate_model', {}, 'validate'), toolCall('run_analysis', { analysisSkillId: 'opensees-static' }, 'analyze'), 'SIGNED_LOAD_DONE',
    ]);
    expect(turn.interactions).toHaveLength(0);
    const { model } = await ctx.backend.inputReview(turn.conversationId);
    expect(model.load_cases[0].loads[0].fz).toBe(-8);
    const session = await ctx.backend.session(turn.conversationId);
    const result = await queryResult(ctx, turn.conversationId, { runId: session.analysis.runId, resultKey: `case:${model.load_cases[0].id}`,
      nodeId: '1', field: 'reactions', component: 'fz', unit: 'kN' });
    expect(result.quantity.value).toBeCloseTo(4, 8);
  }, TURN_TIMEOUT_MS);
});
