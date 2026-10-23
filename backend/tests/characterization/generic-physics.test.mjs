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
// Explicit extractor mapping for the two storeys and three columns in the user description.
// These IDs follow regular-frame operation g; they are not read from its candidate output.
const operationsUpperNodeIds = ['g:N1_0', 'g:N1_1', 'g:N1_2', 'g:N2_0', 'g:N2_1', 'g:N2_2'];
const axialHingeFixture = structuredClone(genericFixtures[5]);
axialHingeFixture.id = 'axial-rotational-hinge-equivalence';
for (const member of [axialHingeFixture.model.elements, axialHingeFixture.draft.engineeringDraft.topology.members].flat()) {
  if (member.id === 'AD') member.releases = { i: { ry: true }, j: { ry: true } };
}
const axialAliasFixture = structuredClone(axialHingeFixture);
axialAliasFixture.id = 'axial-type-alias-with-implicit-hinges';
axialAliasFixture.model = structuredClone(axialAliasFixture.model);
const axialAlias = axialAliasFixture.model.elements.find(member => member.id === 'AD');
axialAlias.type = 'truss'; delete axialAlias.releases;
const momentAliasFixture = structuredClone(genericFixtures[5]);
momentAliasFixture.id = 'canonical-release-aliases-in-draft-and-model';
momentAliasFixture.model = structuredClone(momentAliasFixture.model);
for (const member of [momentAliasFixture.draft.engineeringDraft.topology.members, momentAliasFixture.model.elements].flat()) {
  if (member.id === 'AD') member.releases = { releaseI: { mx: true, my: true, mz: true }, releaseJ: { my: true }, reference_frame: 'element-local' };
}
momentAliasFixture.model.elements.find(member => member.id === 'AD').type = 'truss';
const invalidExtractionFixture = structuredClone(genericFixtures[5]);
invalidExtractionFixture.id = 'invalid-first-extraction-repaired-before-persistence';
invalidExtractionFixture.invalidFirstExtraction = true;
const invalidAxialExtractionFixture = structuredClone(invalidExtractionFixture);
invalidAxialExtractionFixture.id = 'invalid-axial-translation-repaired-before-persistence';
invalidAxialExtractionFixture.invalidAxialTranslation = true;
const axialAreaFixture = structuredClone(genericFixtures[5]);
axialAreaFixture.id = 'axial-area-only-resolves-missing-shape';
axialAreaFixture.model = structuredClone(axialAreaFixture.model);
axialAreaFixture.total = [5, 0, -10];
const axialSection = { id: 'AX', name: 'Axial area only', type: 'custom', properties: { A: .002 }, extra: { provenance: { properties: 'user' } } };
for (const source of [axialAreaFixture.model, {
  nodes: axialAreaFixture.draft.engineeringDraft.topology.nodes,
  elements: axialAreaFixture.draft.engineeringDraft.topology.members,
  sections: axialAreaFixture.draft.engineeringDraft.sectionRecords,
  load_cases: axialAreaFixture.draft.engineeringDraft.loadCases,
}]) {
  source.nodes.push({ id: 'E', x: 7, y: 0, z: 3 });
  source.elements.push({ id: 'DE', type: 'beam', nodes: ['D', 'E'], material: 'Q235', section: 'R' });
  source.elements.find(member => member.id === 'AD').section = 'AX';
  source.sections[0].shape = { kind: 'rectangular', B: 200, H: 300 };
  source.sections.push(structuredClone(axialSection));
  source.load_cases[0].loads = [{ type: 'nodal', node: 'D', fx: 5 }, { type: 'nodal', node: 'E', fz: -10 }];
}
axialAreaFixture.draft.draftIssues = [{ field: 'sectionRecords["AX"].shape', kind: 'missing', severity: 'invalid', reason: 'Area or shape missing.' }];
axialAreaFixture.draft.skillState = { invalidDraftFields: ['sectionRecords["AX"].shape'] };

describeWithOpenSees('characterization: generic physical modelling', () => {
  const ctx = setupHarness();
  test.each([...genericFixtures, operationsFixture, axialHingeFixture, axialAliasFixture, momentAliasFixture, invalidExtractionFixture, invalidAxialExtractionFixture, axialAreaFixture])('$id: scripted extraction and free-form builder → real OpenSees → equilibrium', async fixture => {
    let builds = 0, extractions = 0;
    // Pydantic's authoritative nullable node field is a normal LLM serialization of a free joint.
    const extracted = structuredClone(fixture.draft);
    if (fixture.id === operationsFixture.id) extracted.engineeringDraft.loads = operationsUpperNodeIds.map((target, index) => ({
      ...fixture.draft.engineeringDraft.loads[0], id: `P${index + 1}`, target,
    }));
    for (const node of extracted.engineeringDraft.topology?.nodes ?? []) if (!node.restraints) node.restraints = null;
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('generic'),
      'param-extractor': () => {
        extractions++;
        if (fixture.invalidFirstExtraction && extractions === 1) {
          const invalid = structuredClone(extracted);
          invalid.engineeringDraft.topology.members.find(member => member.id === 'AD').releases = {
            i: fixture.invalidAxialTranslation ? { uy: true } : { unknownRotation: true },
          };
          return invalid;
        }
        return extracted;
      },
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
    expect(session.usage.recoveries).toBe(fixture.invalidFirstExtraction ? 1 : 0);
    expect(extractions).toBe(fixture.invalidFirstExtraction ? 2 : 1);
    for (const request of turn.requests.filter(request => ['param-extractor', 'internal-other'].includes(request.kind))) {
      expect(request.body.response_format).toEqual({ type: 'json_object' });
    }
    expect(turn.requests.some(request => request.kind === 'structural-router')).toBe(false);
    expect(session.modeling).toMatchObject({ usedSkillIds: ['generic'], builder: 'llm' });
    expect(builds).toBe(1);
    const input = await ctx.backend.inputReview(turn.conversationId);
    if (fixture.id === operationsFixture.id) {
      expect(input.model.nodes.filter(node => node.z > 0).map(node => node.id).sort()).toEqual([...operationsUpperNodeIds].sort());
      expect(input.model.load_cases[0].loads.map(load => load.node).sort()).toEqual([...operationsUpperNodeIds].sort());
      for (const load of input.model.load_cases[0].loads) expect(load.fx).toBe(10);
    }
    if (fixture.id === axialAreaFixture.id) {
      const section = input.model.sections.find(section => section.id === 'AX');
      expect(section.properties).toEqual({ A: .002 }); expect(section.shape).toBeUndefined();
      expect(input.model.nodes).toHaveLength(5); expect(input.model.elements).toHaveLength(5);
    }
    if (fixture.id === axialAliasFixture.id) expect(input.model.elements.find(member => member.id === 'AD'))
      .toMatchObject({ type: 'brace', releases: { i: { ry: true }, j: { ry: true } } });
    if (fixture.id === momentAliasFixture.id) expect(input.model.elements.find(member => member.id === 'AD'))
      .toMatchObject({ type: 'brace', releases: { i: { rx: true, ry: true, rz: true }, j: { ry: true }, reference_frame: 'element-local' } });
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
