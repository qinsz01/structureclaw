import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, queryResult, routerDecision, runTurn, setupHarness, toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { genericFixtures } from './fixtures/generic-physics.mjs';

const operationsFixture = {
  id: 'operations-frame-partial-user-topology', total: [60, 0, 0], supports: ['A', 'g:N0_1', 'g:N0_2'], loadCount: 6,
  draft: { inferredType: 'unknown', engineeringDraft: { metadata: { geometryDescription: '2d two-storey two-bay frame, each bay 5m, each storey 3m', supportDescription: 'All base nodes fixed' },
    topology: { nodes: [{ id: 'A', x: 0, y: 0, z: 0, restraints: [true, true, true, true, true, true] }] },
    loads: [{ kind: 'nodal', unit: 'kN', magnitude: 10, direction: 'globalX', target: 'each upper node' }],
    materials: genericFixtures[0].model.materials, sectionRecords: genericFixtures[0].model.sections,
    analysisControl: { self_weight: false } }, requestScope: { responses: ['forces', 'reactions'], design: false, report: false, outputs: [] } },
  model: { schema_version: '2.2.0', unit_system: 'SI', coordinate_system: { dimension: '2d' },
    materials: genericFixtures[0].model.materials, sections: genericFixtures[0].model.sections,
    operations: [
      { id: 'g', op: 'regular-frame', dimension: '2d', bayWidthsX: [5, 5], storeyHeights: [3, 3], baseRestraint: 'fixed', nodeIds: { '0,0,0': 'A' }, material: 'Q235', columnSection: 'R', beamSection: 'R' },
      { id: 'P', op: 'nodal-load', selector: { coordinate: { axis: 'z', gt: 0 } }, caseId: 'LC1', vector: [10, 0, 0] },
    ] },
};
const axialHingeFixture = structuredClone(genericFixtures[5]);
axialHingeFixture.id = 'axial-rotational-hinge-equivalence';
for (const member of [axialHingeFixture.model.elements, axialHingeFixture.draft.engineeringDraft.topology.members].flat()) {
  if (member.id === 'AD') member.releases = { i: { ry: true }, j: { ry: true } };
}

describeWithOpenSees('characterization: generic physical modelling', () => {
  const ctx = setupHarness();
  test.each([...genericFixtures, operationsFixture, axialHingeFixture])('$id: scripted extraction and free-form builder → real OpenSees → equilibrium', async fixture => {
    let builds = 0;
    // Pydantic's authoritative nullable node field is a normal LLM serialization of a free joint.
    const extracted = structuredClone(fixture.draft);
    for (const node of extracted.engineeringDraft.topology?.nodes ?? []) if (!node.restraints) node.restraints = null;
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('generic'),
      'param-extractor': () => extracted,
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
    expect(turn.requests.some(request => request.kind === 'structural-router')).toBe(false);
    expect(session.modeling).toMatchObject({ usedSkillIds: ['generic'], builder: 'llm' });
    expect(builds).toBe(1);
    const input = await ctx.backend.inputReview(turn.conversationId);
    expect(input.model.metadata.physicsCheck).toMatchObject({ valid: true, stability: { freeModes: 0 }, loadTotals: { LC1: fixture.total } });
    expect(input.model.load_cases[0].loads).toHaveLength(fixture.loadCount ?? fixture.model.load_cases[0].loads.length);
    for (const [index, axis] of ['fx', 'fy', 'fz'].entries()) {
      if (fixture.model.coordinate_system.dimension === '2d' && axis === 'fy') continue;
      let sum = 0;
      for (const nodeId of fixture.supports) sum += (await queryResult(ctx, turn.conversationId, { runId: session.analysis.runId, resultKey: 'case:LC1', nodeId, field: 'reactions', component: axis, unit: 'kN' })).quantity.value;
      expect(sum).toBeCloseTo(-fixture.total[index], 6);
    }
  }, TURN_TIMEOUT_MS);
  test('an invalid case ID is corrected in the same turn before any uncertain solver outcome', async () => {
    const fixture = genericFixtures[0];
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('generic'), 'param-extractor': () => fixture.draft,
      'internal-other': () => fixture.model,
    }));
    const turn = await runTurn(ctx, { message: `Analyze this supplied frame. ${JSON.stringify(fixture.draft.engineeringDraft)}`,
      context: { locale: 'en', runPolicy: { skillIds: ['generic'] } } }, [
      toolCall('extract_draft_params', { locale: 'en' }, 'extract-case'), toolCall('build_model', {}, 'build-case'),
      toolCall('run_analysis', { analysisType: 'static', analysisSkillId: 'opensees-static', loadCaseIds: ['L1'] }, 'wrong-case'),
      toolCall('run_analysis', { analysisType: 'static', analysisSkillId: 'opensees-static', loadCaseIds: ['LC1'] }, 'correct-case'), 'CASE_CORRECTED',
    ], { expectedToolErrors: 1 });
    expect(toolResultSeenByAgent(turn.requests, 'wrong-case')).toMatchObject({ success: false, error_code: 'ANALYSIS_SELECTION_INVALID', availableLoadCaseIds: ['LC1'] });
    expect(toolResultSeenByAgent(turn.requests, 'correct-case').success).toBe(true);
    const session = await ctx.backend.session(turn.conversationId);
    expect(session.analysis.current).toBe(true); expect(session.usage.recoveries).toBe(0);
    let total = 0;
    for (const nodeId of fixture.supports) total += (await queryResult(ctx, turn.conversationId, { runId: session.analysis.runId, resultKey: 'case:LC1', nodeId, field: 'reactions', component: 'fx', unit: 'kN' })).quantity.value;
    expect(total).toBeCloseTo(-60, 6);
  }, TURN_TIMEOUT_MS);
});
