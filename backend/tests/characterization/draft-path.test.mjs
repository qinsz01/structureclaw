// Scenario 2: natural-language draft path
//   extract_draft_params → build_model → validate_model → run_analysis → [run_code_check] → generate_report
// The agent decides whether to check: the zh request asks for no check, so the script calls none (the
// tool no longer second-guesses the agent's decision); the en request asks for a GB50017 check.
// The internal structural-type router and parameter extractor are answered realistically by
// inspecting each provider request; the agent tool-call sequence is scripted in order.
import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, queryResult, querySimplyBeamResponses, routerDecision, runTurn,
  setupHarness, toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { eventSignature, parseStepOutput, stepStatuses } from './helpers/normalize.mjs';
import { simplySupportedCentralLoad } from './fixtures/engineering-beam.mjs';

const DRAFT_PIPELINE = ['extract_draft_params', 'build_model', 'validate_model', 'run_analysis', 'run_code_check', 'generate_report'];
const ANALYSIS_PIPELINE = DRAFT_PIPELINE.filter(tool => tool !== 'run_code_check');

function pipelineScript(locale, prefix, { check = true } = {}) {
  return [
    toolCall('extract_draft_params', { locale }, `${prefix}-extract`),
    toolCall('build_model', {}, `${prefix}-build`),
    toolCall('validate_model', {}, `${prefix}-validate`),
    toolCall('run_analysis', { analysisType: 'static', analysisSkillId: 'opensees-static' }, `${prefix}-analysis`),
    ...(check ? [toolCall('run_code_check', { designCode: 'GB50017' }, `${prefix}-check`)] : []),
    toolCall('generate_report', { message: locale === 'zh' ? '生成报告' : 'Generate the report', analysisType: 'static', locale,
      narrative: 'structured' }, `${prefix}-report`),
    `${prefix.toUpperCase()}_DONE`,
  ];
}

describeWithOpenSees('characterization: natural-language draft path', () => {
  const ctx = setupHarness();

  test('zh simply supported steel beam: draft → model → OpenSees → (design not requested) → report', async () => {
    const beamDraft = {
      engineeringDraft: {
        structureType: 'beam', geometry: { lengthM: 6 }, boundary: { supportType: 'simply-supported' },
        materials: [{ id: 'M1', name: 'Q235 钢', E: 206000, nu: 0.3, rho: 7850 }],
        sectionRecords: [{ id: 'S1', name: '200×400 矩形', type: 'rectangular', shape: { kind: 'rectangular', B: 200, H: 400 } }],
        templateAssignments: { beam: { materialId: 'M1', sectionId: 'S1' } },
        loads: [{ id: 'P1', kind: 'point', magnitude: 10, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 3 } }],
        analysisControl: { self_weight: false }, analysis: { loadCombinations: [] },
      },
      requestScope: { responses: ['forces', 'reactions', 'displacements'], method: 'solver', design: false, report: true, outputs: [] },
    };
    const seen = [];
    ctx.llm.setInternal(internalResponder({
      'structural-router': text => { seen.push('router'); expect(text).toContain('6米长的简支钢梁'); return routerDecision('beam'); },
      'param-extractor': text => { seen.push('extractor'); expect(text).toContain('"skillId": "beam"'); return beamDraft; },
    }));
    const message = '一根6米长的简支钢梁，跨中作用10kN集中荷载，矩形截面宽200mm高400mm，钢材E=206000MPa，不计自重，请分析内力、反力和挠度并出报告。';
    const turn = await runTurn(ctx, { message, context: { locale: 'zh' } }, pipelineScript('zh', 'zh-beam', { check: false }));

    expect(seen).toEqual(['router', 'extractor']);
    expect(turn.requests.map(request => request.kind)).toEqual(['agent', 'structural-router', 'param-extractor',
      'agent', 'agent', 'agent', 'agent', 'agent']);
    expect(stepStatuses(turn.steps)).toEqual(ANALYSIS_PIPELINE.map(tool => ({ tool, status: 'done' })));
    expect(eventSignature(turn.events)).toMatchSnapshot('zh-beam-sse-event-sequence');
    expect(parseStepOutput(turn.steps, 'build_model')).toMatchObject({ success: true, nodeCount: 3, elementCount: 2, nextAction: 'run_analysis' });
    expect(parseStepOutput(turn.steps, 'validate_model').result).toEqual({ valid: true, schemaVersion: '2.2.0',
      stats: { nodes: 3, elements: 2, materials: 1, sections: 1, loadCases: 1, loadCombinations: 0 } });

    const { model } = await ctx.backend.inputReview(turn.conversationId);
    expect(model.nodes).toEqual([
      { id: '1', x: 0, y: 0, z: 0, restraints: [true, true, true, false, false, false] },
      { id: '2', x: 3, y: 0, z: 0 },
      { id: '3', x: 6, y: 0, z: 0, restraints: [false, true, true, false, false, false] },
    ]);
    expect(model.elements.map(({ id, nodes, material, section, type }) => ({ id, nodes, material, section, type }))).toEqual([
      { id: '1', nodes: ['1', '2'], material: 'M1', section: 'S1', type: 'beam' },
      { id: '2', nodes: ['2', '3'], material: 'M1', section: 'S1', type: 'beam' },
    ]);
    expect(model.load_cases).toEqual([{ id: 'LC1', type: 'other', loads: [{ node: '2', fz: -10, reference_frame: 'global', id: 'LC1:load:1' }] }]);
    expect(model.sections[0].properties.Iy).toBeCloseTo(0.2 * 0.4 ** 3 / 12, 12);
    expect(model.analysis_control).toEqual({ self_weight: false });

    const session = await ctx.backend.session(turn.conversationId);
    expect(session).toMatchObject({ modelRevision: 1, modelPending: false, analysis: { current: true }, report: { current: true } });
    const reference = simplySupportedCentralLoad({ P: 10, L: 6, E: 206000, b: 200, h: 400 });
    const values = await querySimplyBeamResponses(ctx, turn.conversationId, {
      runId: session.analysis.runId, supports: ['1', '3'], member: '1', positionM: 3 });
    for (const reaction of values.reactions) expect(reaction.value).toBeCloseTo(reference.reactionKn, 8);
    expect(values.moment.value).toBeCloseTo(reference.midpointMomentKnm, 8);
    expect(values.displacement.value).toBeCloseTo(reference.midpointDisplacementMm, 8);
  }, TURN_TIMEOUT_MS);

  test('en steel portal frame: draft → model → OpenSees → GB50017 check (input required) → report', async () => {
    const frameDraft = {
      engineeringDraft: {
        structureType: 'portal-frame', geometry: { spanLengthsM: [12], heightM: 6 }, boundary: { frameBaseSupportType: 'fixed' },
        materials: [{ id: 'Q355', name: 'Q355 steel', E: 206000, nu: 0.3, rho: 7850, grade: 'Q355', category: 'steel' }],
        sectionRecords: [
          { id: 'COL', name: 'HW300×300×10×15', type: 'H', shape: { kind: 'H', H: 300, B: 300, tw: 10, tf: 15 } },
          { id: 'RAF', name: 'HN400×200×8×13', type: 'H', shape: { kind: 'H', H: 400, B: 200, tw: 8, tf: 13 } },
        ],
        templateAssignments: { column: { materialId: 'Q355', sectionId: 'COL' }, beam: { materialId: 'Q355', sectionId: 'RAF' } },
        loads: [{ id: 'ROOF', kind: 'line', magnitude: 5, unit: 'kN/m', direction: 'gravity', target: 'roof' }],
        analysisControl: { self_weight: false }, analysis: { loadCombinations: [] },
      },
      requestScope: { responses: ['forces', 'reactions', 'displacements'], method: 'solver', design: true, report: true, outputs: [] },
    };
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('portal-frame', { confidence: 0.93 }),
      'param-extractor': text => { expect(text).toContain('"skillId": "portal-frame"'); return frameDraft; },
    }));
    const message = 'Analyze a single-bay steel portal frame: span 12 m, eave height 6 m, fixed column bases, roof line load 5 kN/m downward, '
      + 'Q355 steel E=206000 MPa, columns HW300x300x10x15, rafter HN400x200x8x13, ignore self-weight. Check it to GB50017 and give a report.';
    const turn = await runTurn(ctx, { message, context: { locale: 'en' } }, pipelineScript('en', 'en-frame'));

    expect(stepStatuses(turn.steps)).toEqual(DRAFT_PIPELINE.map(tool => ({ tool, status: 'done' })));
    expect(eventSignature(turn.events)).toMatchSnapshot('en-frame-sse-event-sequence');
    const { model } = await ctx.backend.inputReview(turn.conversationId);
    expect(model.nodes).toEqual([
      { id: 'B0', x: 0, y: 0, z: 0, restraints: [true, true, true, true, true, true] },
      { id: 'T0', x: 0, y: 0, z: 6 },
      { id: 'B1', x: 12, y: 0, z: 0, restraints: [true, true, true, true, true, true] },
      { id: 'T1', x: 12, y: 0, z: 6 },
    ]);
    expect(model.elements.map(({ id, type, nodes, material, section }) => ({ id, type, nodes, material, section }))).toEqual([
      { id: 'C0', type: 'column', nodes: ['B0', 'T0'], material: 'Q355', section: 'COL' },
      { id: 'C1', type: 'column', nodes: ['B1', 'T1'], material: 'Q355', section: 'COL' },
      { id: 'R0', type: 'beam', nodes: ['T0', 'T1'], material: 'Q355', section: 'RAF' },
    ]);
    expect(model.load_cases[0].loads).toEqual([{ type: 'distributed', element: 'R0', wz: -5, wy: 0, reference_frame: 'global', id: 'LC1:load:1' }]);

    const check = toolResultSeenByAgent(turn.requests, 'en-frame-check');
    expect(check).toMatchObject({ success: true, provider: 'builtin', skillId: 'code-check-gb50017', completionStatus: 'incomplete',
      complianceStatus: 'incomplete', summary: { total: 15, passed: 8, failed: 0, inputRequired: 6, notApplicable: 1 } });
    // Code-determined values are looked up (f by grade and flange thickness, clause factors); only
    // judgment inputs remain: φ (axial stability), effective lengths, φb and the deflection limit.
    expect(check.designValues.filter(row => row.field === 'material.design.f').map(row => [row.value, row.source]))
      .toEqual([[305, 'GB 50017-2017 表4.4.1, Q355, t=15mm≤16'], [305, 'GB 50017-2017 表4.4.1, Q355, t=13mm≤16']]);
    expect([...new Set(check.missingInputs.map(row => row.field))].sort()).toEqual(['member.design.deflectionLimitN',
      'member.design.l0', 'member.design.phi_axial', 'member.design.phi_b', 'member.design.serviceability_result_keys', 'response.deflection'].sort());

    const session = await ctx.backend.session(turn.conversationId);
    expect(session).toMatchObject({ analysis: { current: true }, report: { current: true } });
    // Symmetric fixed portal under a uniform rafter load: each base carries wL/2 = 30 kN vertically.
    for (const nodeId of ['B0', 'B1']) {
      const { quantity } = await queryResult(ctx, turn.conversationId, { runId: session.analysis.runId, resultKey: 'case:LC1', nodeId,
        field: 'reactions', component: 'fz', unit: 'kN', quantityId: `base-${nodeId}` });
      expect(quantity.value).toBeCloseTo(30, 6);
    }
    const left = await queryResult(ctx, turn.conversationId, { runId: session.analysis.runId, resultKey: 'case:LC1', nodeId: 'B0',
      field: 'reactions', component: 'fx', unit: 'kN', quantityId: 'base-B0-fx' });
    const right = await queryResult(ctx, turn.conversationId, { runId: session.analysis.runId, resultKey: 'case:LC1', nodeId: 'B1',
      field: 'reactions', component: 'fx', unit: 'kN', quantityId: 'base-B1-fx' });
    expect(left.quantity.value + right.quantity.value).toBeCloseTo(0, 8); // horizontal equilibrium
    expect(Number(Math.abs(left.quantity.value).toFixed(6))).toMatchSnapshot('portal-base-thrust-kN');
  }, TURN_TIMEOUT_MS);
});
