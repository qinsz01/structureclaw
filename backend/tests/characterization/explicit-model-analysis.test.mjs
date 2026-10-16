// Scenario 1: a supplied explicit StructureModel v2 → run_analysis(opensees-static) → generate_report.
// Only the LLM transport is scripted; HTTP, graph, tools, OpenSees, persistence and reports are real.
import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, querySimplyBeamResponses, runTurn, setupHarness, TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { eventSignature, stepStatuses } from './helpers/normalize.mjs';
import { beamAnalysis, beamModel, beamReference } from './fixtures/engineering-beam.mjs';

describeWithOpenSees('characterization: explicit model → OpenSees → report', () => {
  const ctx = setupHarness();

  test('analysis and report are current and match the Euler–Bernoulli reference', async () => {
    const turn = await runTurn(ctx, {
      message: 'Analyze the supplied beam with OpenSees and save its report.',
      context: { locale: 'en', model: beamModel, modelFormat: 'structuremodel-v2' },
    }, [
      toolCall('run_analysis', beamAnalysis, 'explicit-analysis'),
      toolCall('generate_report', { message: 'Computed report', analysisType: 'static', locale: 'en', narrative: 'structured' }, 'explicit-report'),
      'EXPLICIT_DONE',
    ]);

    expect(stepStatuses(turn.steps)).toEqual([
      { tool: 'run_analysis', status: 'done' },
      { tool: 'generate_report', status: 'done' },
    ]);
    expect(turn.steps.find(step => step.tool === 'run_analysis' && step.status === 'done')).toMatchObject({
      id: 'step-explicit-analysis', phase: 'analysis', skillId: 'opensees-static' });
    expect(eventSignature(turn.events)).toMatchSnapshot('sse-event-sequence');
    expect(turn.result.content).toMatchObject({ response: 'EXPLICIT_DONE' });

    // Agent LLM saw the user turn and both tool results in order (3 agent calls, no internal calls).
    expect(turn.requests.map(request => request.kind)).toEqual(['agent', 'agent', 'agent']);
    const toolMessages = turn.requests[2].body.messages.filter(message => message.role === 'tool');
    expect(toolMessages.map(message => message.tool_call_id)).toEqual(['explicit-analysis', 'explicit-report']);

    const session = await ctx.backend.session(turn.conversationId);
    expect(session).toMatchObject({ busy: false, waitingForReply: false, modelRevision: 1, modelPending: false,
      analysis: { resultKey: 'case:LC1', current: true, reason: null }, report: { current: true } });
    expect(session.report.runId).toBe(session.analysis.runId);
    expect(session.usage).toMatchObject({ toolCalls: 2, llmCalls: 3, recoveries: 0 });
    expect(session.jobs).toEqual([expect.objectContaining({ kind: 'analysis', status: 'completed', runId: session.analysis.runId })]);

    const values = await querySimplyBeamResponses(ctx, turn.conversationId, {
      runId: session.analysis.runId, supports: ['A', 'B'], member: 'beam', positionM: 5 });
    for (const [index, reaction] of values.reactions.entries()) {
      expect(reaction).toMatchObject({ runId: session.analysis.runId, selection: 'case:LC1', component: 'fz', unit: 'kN',
        location: { kind: 'node', id: ['A', 'B'][index] } });
      expect(reaction.value).toBeCloseTo(beamReference.reactionKn, 8);
    }
    expect(values.moment.location).toMatchObject({ kind: 'member', id: 'beam', positionM: 5, side: 'right' });
    expect(values.moment.value).toBeCloseTo(beamReference.midpointMomentKnm, 8);
    expect(values.displacement.value).toBeCloseTo(beamReference.midpointDisplacementMm, 8);

    // The persisted model is the supplied one (no rebuild, no extra loads).
    const input = await ctx.backend.inputReview(turn.conversationId);
    expect(input.model.nodes.map(node => node.id)).toEqual(['A', 'B']);
    expect(input.model.load_cases[0].loads).toEqual([expect.objectContaining({ id: 'midpoint-load', element: 'beam', position: 5, fz: -1 })]);
    expect(input).toMatchObject({ analysisCurrent: true, reportCurrent: true });
  }, TURN_TIMEOUT_MS);
});
