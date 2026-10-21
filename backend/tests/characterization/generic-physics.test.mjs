import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, queryResult, routerDecision, runTurn, setupHarness, toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { genericFixtures } from './fixtures/generic-physics.mjs';

describeWithOpenSees('characterization: generic physical modelling', () => {
  const ctx = setupHarness();
  test.each(genericFixtures)('$id: scripted extraction and free-form builder → real OpenSees → equilibrium', async fixture => {
    let builds = 0;
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('generic'),
      'param-extractor': () => fixture.draft,
      'internal-other': () => { builds++; return fixture.model; },
    }));
    const turn = await runTurn(ctx, {
      message: `Build and analyze this physical structure, preserving all IDs. No self-weight, code design or report. ${JSON.stringify(fixture.draft.engineeringDraft)}`,
      context: { locale: 'en', runPolicy: { skillIds: ['generic'] } },
    }, [toolCall('extract_draft_params', { locale: 'en' }, 'extract'), toolCall('build_model', {}, 'build'),
      toolCall('validate_model', {}, 'validate'), toolCall('run_analysis', { analysisType: 'static', analysisSkillId: 'opensees-static' }, 'analyze'), 'GENERIC_DONE']);
    expect(toolResultSeenByAgent(turn.requests, 'build').success).toBe(true);
    const session = await ctx.backend.session(turn.conversationId);
    expect(session.analysis.current).toBe(true);
    expect(session.waitingForReply).toBe(false);
    expect(session.usage.recoveries).toBe(0);
    expect(builds).toBe(1);
    const input = await ctx.backend.inputReview(turn.conversationId);
    expect(input.model.metadata.physicsCheck).toMatchObject({ valid: true, stability: { freeModes: 0 }, loadTotals: { LC1: fixture.total } });
    expect(input.model.load_cases[0].loads).toHaveLength(fixture.model.load_cases[0].loads.length);
    for (const [index, axis] of ['fx', 'fy', 'fz'].entries()) {
      if (fixture.model.coordinate_system.dimension === '2d' && axis === 'fy') continue;
      let sum = 0;
      for (const nodeId of fixture.supports) sum += (await queryResult(ctx, turn.conversationId, { runId: session.analysis.runId, resultKey: 'case:LC1', nodeId, field: 'reactions', component: axis, unit: 'kN' })).quantity.value;
      expect(sum).toBeCloseTo(-fixture.total[index], 6);
    }
  }, TURN_TIMEOUT_MS);
});
