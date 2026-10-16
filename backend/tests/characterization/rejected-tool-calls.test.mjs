// Scenario 6 (API-level port of the first test in frontend/tests/e2e/specs/engineering-workflow.spec.ts):
// rejected/invalid tool calls must not invalidate or alter the saved analysis and report.
import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, querySimplyBeamResponses, runTurn, setupHarness, toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { eventSignature, normalizeVolatile } from './helpers/normalize.mjs';
import { beamAnalysis, beamModel, beamReference } from './fixtures/engineering-beam.mjs';

const INVALID_CALLS = [
  ['invalid-analysis-type', 'run_analysis', { analysisType: 'equilibrium' }],
  ['invalid-extraction-scope', 'extract_draft_params', { requestScope: { responses: [] } }],
  ['missing-build-draft', 'build_model', {}],
];

describeWithOpenSees('characterization: rejected tool calls preserve saved results', () => {
  const ctx = setupHarness();

  test('invalid tool arguments preserve the saved analysis and report', async () => {
    const initial = await runTurn(ctx, {
      message: 'Analyze the supplied beam and save its report.',
      context: { locale: 'en', model: beamModel, modelFormat: 'structuremodel-v2' },
    }, [
      toolCall('run_analysis', beamAnalysis, 'preserve-analysis'),
      toolCall('generate_report', { message: 'Computed report', analysisType: 'static', locale: 'en', narrative: 'structured' }, 'preserve-report'),
      'INITIAL_SAVED',
    ]);
    const conversationId = initial.conversationId;
    const before = await ctx.backend.session(conversationId);
    expect(before.analysis.current).toBe(true);
    expect(before.report.current).toBe(true);

    const rejections = {};
    for (const [id, name, args] of INVALID_CALLS) {
      const turn = await runTurn(ctx, { conversationId, message: 'Injected rejected operation must preserve the saved result.', context: { locale: 'en' } },
        [toolCall(name, args, id), 'INVALID_CALL_REJECTED'], { expectedToolErrors: 1 });
      expect(turn.steps.find(step => step.status === 'error')).toMatchObject({ id: `step-${id}`, tool: name });
      expect(turn.events.filter(event => event.type === 'artifact_payload_sync' && event.invalidated)).toEqual([]);
      const retained = await ctx.backend.session(conversationId);
      expect(retained.analysis).toEqual(before.analysis);
      expect(retained.report).toEqual(before.report);
      expect(retained.modelRevision).toBe(before.modelRevision);
      const seen = toolResultSeenByAgent(turn.requests, id);
      rejections[id] = { events: eventSignature(turn.events), toolResult: normalizeVolatile(seen, { dataDir: ctx.backend.dataDir }) };
    }
    // What the agent LLM is told for each rejection is part of the agent contract.
    expect(rejections).toMatchSnapshot('rejected-tool-results');

    const after = await querySimplyBeamResponses(ctx, conversationId, { runId: before.analysis.runId, supports: ['A', 'B'], member: 'beam', positionM: 5 });
    expect(after.displacement.value).toBeCloseTo(beamReference.midpointDisplacementMm, 8);
    expect((await ctx.backend.session(conversationId)).report).toEqual(before.report);
  }, TURN_TIMEOUT_MS);
});
