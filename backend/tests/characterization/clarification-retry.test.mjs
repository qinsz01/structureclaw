import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, routerDecision, runTurn, setupHarness, TURN_TIMEOUT_MS } from './helpers/harness.mjs';

describeWithOpenSees('characterization: unapplied clarification answers', () => {
  const ctx = setupHarness();
  test('the same invalid answer twice permits re-asking and a later valid answer completes', async () => {
    let extracts = 0;
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('beam'),
      'param-extractor': () => {
        extracts++;
        if (extracts === 1) return { requestScope: { responses: ['forces', 'reactions'], design: false, report: false, outputs: [] },
          engineeringDraft: { structureType: 'beam', geometry: { lengthM: 6 }, boundary: { supportType: 'simply-supported' }, analysisControl: { self_weight: false } } };
        if (extracts < 4) return {};
        return { engineeringDraft: { loads: [{ id: 'P', kind: 'point', magnitude: 8, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 3 } }] } };
      },
    }));
    const question = 'What is the downward midspan point load in kN?';
    const ask = index => [toolCall('extract_draft_params', {}, `extract-${index}`),
      toolCall('ask_user_clarification', { question }, `ask-${index}`)];
    const first = await runTurn(ctx, { message: 'Analyze only forces and reactions of a 6m simply supported beam, no self-weight. Ask me for its midspan load.', context: { locale: 'en' } }, ask(1));
    for (const index of [2, 3]) {
      const next = await runTurn(ctx, { conversationId: first.conversationId, resumeValue: 'not sure' }, ask(index), { resume: true });
      expect(next.interactions).toHaveLength(1);
      expect((await ctx.backend.session(first.conversationId)).waitingForReply).toBe(true);
    }
    const last = await runTurn(ctx, { conversationId: first.conversationId, resumeValue: '8kN downward at midspan' }, [
      toolCall('extract_draft_params', {}, 'extract-4'), toolCall('build_model', {}, 'build'),
      toolCall('validate_model', {}, 'validate'), toolCall('run_analysis', { analysisSkillId: 'opensees-static' }, 'analyze'), 'DONE',
    ], { resume: true });
    expect(last.interactions).toHaveLength(0);
    expect((await ctx.backend.session(first.conversationId)).analysis.current).toBe(true);
  }, TURN_TIMEOUT_MS);
});
