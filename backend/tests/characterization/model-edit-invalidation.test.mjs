// Scenario 4: after a current analysis, edit_model changes a load → analysis/report become
// historical (not current) → undo_model restores the load → re-analysis reproduces the original values.
import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, querySimplyBeamResponses, runTurn, setupHarness, toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { eventSignature, normalizeVolatile, stepStatuses } from './helpers/normalize.mjs';
import { beamAnalysis, beamModel, beamReference } from './fixtures/engineering-beam.mjs';

const midpoint = { supports: ['A', 'B'], member: 'beam', positionM: 5 };

describeWithOpenSees('characterization: model edit invalidation and undo', () => {
  const ctx = setupHarness();

  test('edit_model invalidates analysis and report; undo_model + run_analysis restores the reference values', async () => {
    const initial = await runTurn(ctx, {
      message: 'Analyze this supplied 10 m beam with OpenSees. Do not change its geometry or loads.',
      context: { locale: 'en', model: beamModel, modelFormat: 'structuremodel-v2' },
    }, [
      toolCall('run_analysis', beamAnalysis, 'edit-initial-analysis'),
      toolCall('generate_report', { message: 'Report this computed beam', analysisType: 'static', locale: 'en', narrative: 'structured' }, 'edit-initial-report'),
      'EDIT_INITIAL_DONE',
    ]);
    const conversationId = initial.conversationId;
    const before = await ctx.backend.session(conversationId);
    expect(before).toMatchObject({ modelRevision: 1, analysis: { current: true }, report: { current: true } });
    const initialRunId = before.analysis.runId;
    const original = await querySimplyBeamResponses(ctx, conversationId, { runId: initialRunId, ...midpoint });
    expect(original.displacement.value).toBeCloseTo(beamReference.midpointDisplacementMm, 8);

    const edit = await runTurn(ctx, { conversationId, message: 'Double the existing midpoint load to 2 kN, keeping its ID and position. Do not recalculate yet.',
      context: { locale: 'en' } }, [
      toolCall('edit_model', { baseRevision: before.modelRevision, label: 'Double existing midpoint load',
        edits: [{ operation: 'update', collection: 'loads', caseId: 'LC1', id: 'midpoint-load', values: { fz: -2 } }] }, 'edit-double-load'),
      'EDIT_DONE',
    ]);
    expect(stepStatuses(edit.steps)).toEqual([{ tool: 'edit_model', status: 'done' }]);
    expect(eventSignature(edit.events)).toMatchSnapshot('edit-turn-sse-event-sequence');
    expect(edit.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'artifact_payload_sync', artifact: 'analysis', invalidated: true })]));
    const editReceipt = toolResultSeenByAgent(edit.requests, 'edit-double-load');
    expect(editReceipt).toMatchObject({ success: true });

    const edited = await ctx.backend.session(conversationId);
    expect(edited.modelRevision).toBeGreaterThan(before.modelRevision);
    // Invalidation clears the current-run pointer; the run itself remains in history (below).
    expect(edited.analysis).toMatchObject({ runId: null, current: false });
    expect(normalizeVolatile({ analysis: edited.analysis, report: edited.report })).toMatchSnapshot('invalidated-session-state');
    expect(edited.report.current).toBe(false);
    const editedInput = await ctx.backend.inputReview(conversationId);
    expect(editedInput.model.load_cases[0].loads).toEqual([expect.objectContaining({ id: 'midpoint-load', position: 5, fz: -2 })]);
    expect(editedInput).toMatchObject({ analysisCurrent: false, reportCurrent: false });

    // The historical run stays queryable with its original values.
    const historical = await querySimplyBeamResponses(ctx, conversationId, { runId: initialRunId, ...midpoint });
    expect(historical.displacement.value).toBe(original.displacement.value);
    const review = await ctx.backend.get(`/api/v1/agent/result-review/${conversationId}`);
    expect(review.body.runs.map(run => ({ runId: run.runId, current: run.current }))).toEqual([{ runId: initialRunId, current: false }]);

    const undone = await runTurn(ctx, { conversationId, message: 'Undo the last load change and recalculate the restored model with OpenSees.',
      context: { locale: 'en' } }, [
      toolCall('undo_model', { baseRevision: edited.modelRevision }, 'edit-undo'),
      toolCall('run_analysis', beamAnalysis, 'edit-restored-analysis'),
      'EDIT_UNDO_DONE',
    ]);
    expect(stepStatuses(undone.steps)).toEqual([{ tool: 'undo_model', status: 'done' }, { tool: 'run_analysis', status: 'done' }]);
    expect(eventSignature(undone.events)).toMatchSnapshot('undo-turn-sse-event-sequence');

    const restored = await ctx.backend.session(conversationId);
    expect(restored.modelRevision).toBeGreaterThan(edited.modelRevision);
    expect(restored.analysis.current).toBe(true);
    expect(restored.analysis.runId).not.toBe(initialRunId);
    expect(restored.report.current).toBe(false); // the report was not regenerated after undo
    const restoredInput = await ctx.backend.inputReview(conversationId);
    expect(restoredInput.model.load_cases[0].loads).toEqual([expect.objectContaining({ id: 'midpoint-load', position: 5, fz: -1 })]);
    const runs = (await ctx.backend.get(`/api/v1/agent/result-review/${conversationId}`)).body.runs;
    expect(runs.map(run => ({ runId: run.runId, current: run.current }))).toEqual([
      { runId: initialRunId, current: false }, { runId: restored.analysis.runId, current: true }]);

    const recomputed = await querySimplyBeamResponses(ctx, conversationId, { runId: restored.analysis.runId, ...midpoint });
    for (const reaction of recomputed.reactions) expect(reaction.value).toBeCloseTo(beamReference.reactionKn, 8);
    expect(recomputed.moment.value).toBeCloseTo(beamReference.midpointMomentKnm, 8);
    expect(recomputed.displacement.value).toBeCloseTo(original.displacement.value, 10);
  }, TURN_TIMEOUT_MS);
});
