// Scenario: requests answered with minimal inputs (2026-10-18 product decision "用户要什么就做什么").
// - Internal forces only, no material/section: no clarification. A statically determinate beam runs on
//   labelled unit stiffness; an indeterminate beam additionally reports the equal-EI assumption.
//   Cantilever, simple, two-span and portal answers all come from the solver.
//   Displacements from such a run are never presented. Whether to report or check is the agent's
//   decision; if it schedules a report anyway, the tool refuses the placeholder run with a recovery hint.
// - A later displacement request after a placeholder run asks for the real material and section; a code
//   check refuses the placeholder model with a recovery hint.
// - A concrete frame without a rebar grade is analysed; the grade matters only for an explicit check.
import { expect, test } from '@jest/globals';
import { systemPrompt, toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, queryResult, routerDecision, runTurn, setupHarness,
  toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { stepStatuses } from './helpers/normalize.mjs';

const FORCE_SCOPE = { responses: ['forces', 'reactions'], design: false, outputs: [] };

const SIMPLE = {
  zh: { message: '计算一个简支梁的内力，跨度10m，跨中集中荷载1kN', rule: '内力和反力不需要材料截面', followUp: '那挠度呢' },
  en: { message: 'Compute the internal forces of a simply supported beam, span 10 m, 1 kN point load at midspan', rule: 'forces and reactions need no material or section', followUp: 'And the deflection?' },
};
const simpleDraft = {
  engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
    loads: [{ id: 'P1', kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 5, nodeRole: 'midspan' } }] },
  // A live extractor tends to flag the absent material/section; a force-only request must not block on it.
  draftIssues: [{ field: 'material', kind: 'missing', severity: 'invalid', reason: 'No material grade given.' }],
  requestScope: FORCE_SCOPE,
};

/** Placeholder-run displacement queries fail through the same public result-review tool. */
async function displacementQuery(ctx, conversationId, args) {
  const review = await ctx.backend.get(`/api/v1/agent/result-review/${conversationId}`);
  return ctx.backend.post(`/api/v1/agent/result-review/${conversationId}/tools`, { revisionToken: review.body.revisionToken, tool: 'query_results', args });
}

describeWithOpenSees('characterization: minimal inputs', () => {
  const ctx = setupHarness();

  test.each(['zh', 'en'])('%s internal forces of a simple beam: no question, no report, forces only', async locale => {
    const spec = SIMPLE[locale];
    ctx.llm.setInternal(internalResponder({ 'structural-router': () => routerDecision('beam'), 'param-extractor': () => simpleDraft }));
    const prefix = `forces-${locale}`;
    const turn = await runTurn(ctx, { message: spec.message, context: { locale } }, [
      toolCall('extract_draft_params', { locale }, `${prefix}-extract`),
      toolCall('build_model', {}, `${prefix}-build`),
      toolCall('validate_model', {}, `${prefix}-validate`),
      toolCall('run_analysis', { analysisType: 'static' }, `${prefix}-analysis`),
      toolCall('generate_report', { message: spec.message, analysisType: 'static', locale, narrative: 'structured' }, `${prefix}-report`),
      'Reactions 0.5 kN each; maximum moment 2.5 kN·m at midspan.',
    ], { expectedToolErrors: 1 });
    expect(systemPrompt(turn.requests.find(request => request.kind === 'agent').body)).toContain(spec.rule);
    const extraction = toolResultSeenByAgent(turn.requests, `${prefix}-extract`);
    expect(extraction.criticalMissing).toEqual([]);
    expect(extraction.clarificationQuestions).toEqual([]);
    expect(turn.interactions).toEqual([]);
    expect(turn.steps.some(step => ['ask_user_clarification', 'run_code_check'].includes(step.tool))).toBe(false);

    const build = toolResultSeenByAgent(turn.requests, `${prefix}-build`);
    expect(build.stiffnessPlaceholder).toMatchObject({ material: true, section: true, staticIndeterminacy: 0, equalStiffnessAssumed: false });
    const analysis = toolResultSeenByAgent(turn.requests, `${prefix}-analysis`);
    expect(analysis.success).toBe(true);
    expect(analysis.stiffnessPlaceholder).toMatchObject({ equalStiffnessAssumed: false, availableResponses: ['forces', 'reactions'] });
    expect(JSON.stringify(analysis)).not.toMatch(/maxAbsDisplacement|"displacements"/);
    const report = toolResultSeenByAgent(turn.requests, `${prefix}-report`);
    expect(report).toMatchObject({ success: false, errorCode: 'STIFFNESS_PLACEHOLDER_RUN', nextAction: 'ask_user_clarification' });
    expect(report.messageZh).toContain('实际材料和截面');

    const session = await ctx.backend.session(turn.conversationId);
    expect(session).toMatchObject({ waitingForReply: false, analysis: { current: true } });
    expect(session.report?.current ?? false).toBe(false);
    const { model } = await ctx.backend.inputReview(turn.conversationId);
    expect(model.metadata.stiffnessPlaceholder).toMatchObject({ material: true, section: true });
    expect(model.materials[0].name).toContain(locale === 'zh' ? '仅用于内力计算的单位刚度' : 'unit stiffness for force analysis only');

    const runId = session.analysis.runId;
    const reactions = [];
    for (const nodeId of ['1', '3']) {
      reactions.push((await queryResult(ctx, turn.conversationId, { runId, resultKey: 'case:LC1', nodeId, field: 'reactions', component: 'fz', unit: 'kN' })).quantity.value);
    }
    for (const reaction of reactions) expect(reaction).toBeCloseTo(0.5, 8);
    const moment = (await queryResult(ctx, turn.conversationId, { runId, resultKey: 'case:LC1', elementId: '1', positionM: 5, side: 'left',
      field: 'forces', component: 'M2', unit: 'kN.m' })).quantity.value;
    expect(Math.abs(moment)).toBeCloseTo(2.5, 8);
    const displacement = await displacementQuery(ctx, turn.conversationId, { runId, resultKey: 'case:LC1', elementId: '1', positionM: 5,
      field: 'displacements', component: 'uz', unit: 'mm' });
    expect(JSON.stringify(displacement.body)).toContain('STIFFNESS_PLACEHOLDER_DISPLACEMENT_UNAVAILABLE');

    // Follow-up deflection request: the placeholder cannot be reused; material and section are asked for.
    ctx.llm.setInternal(internalResponder({ 'structural-router': () => routerDecision('beam'),
      'param-extractor': () => ({ requestScope: { responses: ['displacements'], design: false, outputs: [] } }) }));
    const followUp = await runTurn(ctx, { conversationId: turn.conversationId, message: spec.followUp, context: { locale } }, [
      toolCall('extract_draft_params', { locale, message: spec.followUp }, `${prefix}-deflection`),
      toolCall('run_code_check', { designCode: 'GB50017', requestScope: { ...FORCE_SCOPE, responses: ['forces', 'reactions', 'displacements'], design: true } }, `${prefix}-check`),
      'Please provide the material grade and the section.',
    ], { expectedToolErrors: 1 });
    const deflection = toolResultSeenByAgent(followUp.requests, `${prefix}-deflection`);
    expect(deflection.criticalMissing).toContain('templateProperties');
    expect(deflection.requestScope.responses).toContain('displacements');
    expect(deflection.clarificationQuestions.map(question => question.paramKey)).toContain('templateProperties');
    expect(toolResultSeenByAgent(followUp.requests, `${prefix}-check`)).toMatchObject({ success: false, errorCode: 'STIFFNESS_PLACEHOLDER_MODEL' });
  }, TURN_TIMEOUT_MS * 2);

  test('two-span continuous beam, forces only: equal-EI assumption, exact support moment and reactions', async () => {
    ctx.llm.setInternal(internalResponder({ 'structural-router': () => routerDecision('double-span-beam'), 'param-extractor': () => ({
      engineeringDraft: { structureType: 'double-span-beam', geometry: { spanLengthsM: [6, 6] },
        loads: [{ id: 'q', kind: 'line', magnitude: 10, unit: 'kN/m', direction: 'gravity', target: 'beam' }] },
      requestScope: FORCE_SCOPE }) }));
    const turn = await runTurn(ctx, { message: '两跨连续梁，每跨6m，满跨均布荷载10kN/m，求内力', context: { locale: 'zh' } }, [
      toolCall('extract_draft_params', { locale: 'zh' }, 'cont-extract'),
      toolCall('build_model', {}, 'cont-build'),
      toolCall('run_analysis', { analysisType: 'static' }, 'cont-analysis'),
      '按各构件EI相同计算：中支座弯矩 -45 kN·m，反力 22.5/75/22.5 kN。',
    ]);
    expect(toolResultSeenByAgent(turn.requests, 'cont-extract').criticalMissing).toEqual([]);
    expect(turn.interactions).toEqual([]);
    const analysis = toolResultSeenByAgent(turn.requests, 'cont-analysis');
    expect(analysis.stiffnessPlaceholder).toMatchObject({ staticIndeterminacy: 1, equalStiffnessAssumed: true });
    expect(analysis.stiffnessPlaceholder.notice).toContain('EI');
    const session = await ctx.backend.session(turn.conversationId);
    const { model } = await ctx.backend.inputReview(turn.conversationId);
    const xs = model.nodes.map(node => node.x);
    const supports = model.nodes.filter(node => Array.isArray(node.restraints) && node.restraints[2] === true).sort((a, b) => a.x - b.x);
    expect(supports.map(node => node.x)).toEqual([0, 6, 12]);
    expect(Math.max(...xs)).toBe(12);
    const reactions = [];
    for (const node of supports) {
      reactions.push((await queryResult(ctx, turn.conversationId, { runId: session.analysis.runId, nodeId: node.id, field: 'reactions',
        component: 'fz', unit: 'kN' })).quantity.value);
    }
    expect(reactions[0]).toBeCloseTo(22.5, 6);
    expect(reactions[1]).toBeCloseTo(75, 6);
    expect(reactions[2]).toBeCloseTo(22.5, 6);
    const middle = supports[1];
    const element = model.elements.find(item => item.nodes[1] === middle.id);
    const start = model.nodes.find(node => node.id === element.nodes[0]);
    const moment = (await queryResult(ctx, turn.conversationId, { runId: session.analysis.runId, elementId: element.id,
      positionM: middle.x - start.x, side: 'left', field: 'forces', component: 'M2', unit: 'kN.m' })).quantity.value;
    // Hogging support moment wL²/8 = 45 kN·m (sagging is negative M2).
    expect(moment).toBeCloseTo(45, 6);
  }, TURN_TIMEOUT_MS);

  test('cantilever, forces only: solved on unit stiffness, fixed-end reaction and moment', async () => {
    ctx.llm.setInternal(internalResponder({ 'structural-router': () => routerDecision('beam'), 'param-extractor': () => ({
      engineeringDraft: { structureType: 'beam', geometry: { lengthM: 4 }, boundary: { supportType: 'cantilever' },
        loads: [{ id: 'P1', kind: 'point', magnitude: 2, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 4, nodeRole: 'free-end' } }] },
      requestScope: FORCE_SCOPE }) }));
    const turn = await runTurn(ctx, { message: '悬臂梁长4m，自由端集中荷载2kN，求固定端反力和弯矩', context: { locale: 'zh' } }, [
      toolCall('extract_draft_params', { locale: 'zh' }, 'cant-extract'),
      toolCall('build_model', {}, 'cant-build'),
      toolCall('run_analysis', { analysisType: 'static' }, 'cant-analysis'),
      '固定端反力 2 kN，弯矩 8 kN·m。',
    ]);
    expect(toolResultSeenByAgent(turn.requests, 'cant-extract').criticalMissing).toEqual([]);
    expect(turn.interactions).toEqual([]);
    const analysis = toolResultSeenByAgent(turn.requests, 'cant-analysis');
    expect(analysis.success).toBe(true);
    expect(analysis.stiffnessPlaceholder).toMatchObject({ staticIndeterminacy: 0, equalStiffnessAssumed: false });
    const session = await ctx.backend.session(turn.conversationId);
    const { model } = await ctx.backend.inputReview(turn.conversationId);
    const fixed = model.nodes.find(node => Array.isArray(node.restraints) && node.restraints.every(Boolean));
    const base = { runId: session.analysis.runId, nodeId: fixed.id, field: 'reactions', unit: 'kN' };
    expect((await queryResult(ctx, turn.conversationId, { ...base, component: 'fz' })).quantity.value).toBeCloseTo(2, 8);
    expect(Math.abs((await queryResult(ctx, turn.conversationId, { ...base, component: 'my', unit: 'kN.m' })).quantity.value)).toBeCloseTo(8, 8);
  }, TURN_TIMEOUT_MS);

  test('portal frame, forces only: equal-EI assumption, symmetric vertical reactions and balanced thrust', async () => {
    ctx.llm.setInternal(internalResponder({ 'structural-router': () => routerDecision('portal-frame'), 'param-extractor': () => ({
      engineeringDraft: { structureType: 'portal-frame', geometry: { spanLengthsM: [12], heightM: 6 },
        loads: [{ id: 'ROOF', kind: 'line', magnitude: 5, unit: 'kN/m', direction: 'gravity', target: 'roof' }] },
      requestScope: FORCE_SCOPE }) }));
    const turn = await runTurn(ctx, { message: '计算一个门式刚架的内力，跨度12m，柱高6m，屋面均布荷载5kN/m', context: { locale: 'zh' } }, [
      toolCall('extract_draft_params', { locale: 'zh' }, 'portal-extract'),
      toolCall('build_model', {}, 'portal-build'),
      toolCall('run_analysis', { analysisType: 'static' }, 'portal-analysis'),
      '按各构件EI相同计算：柱脚竖向反力各 30 kN。',
    ]);
    expect(toolResultSeenByAgent(turn.requests, 'portal-extract').criticalMissing).toEqual([]);
    expect(turn.interactions).toEqual([]);
    const analysis = toolResultSeenByAgent(turn.requests, 'portal-analysis');
    expect(analysis.success).toBe(true);
    expect(analysis.stiffnessPlaceholder).toMatchObject({ staticIndeterminacy: 3, equalStiffnessAssumed: true });
    const session = await ctx.backend.session(turn.conversationId);
    const { model } = await ctx.backend.inputReview(turn.conversationId);
    const bases = model.nodes.filter(node => Array.isArray(node.restraints) && node.restraints[2] === true);
    expect(bases).toHaveLength(2);
    const reaction = async (nodeId, component) => (await queryResult(ctx, turn.conversationId, { runId: session.analysis.runId,
      nodeId, field: 'reactions', component, unit: 'kN' })).quantity.value;
    for (const node of bases) expect(await reaction(node.id, 'fz')).toBeCloseTo(30, 6);
    expect(await reaction(bases[0].id, 'fx') + await reaction(bases[1].id, 'fx')).toBeCloseTo(0, 8);
  }, TURN_TIMEOUT_MS);

  test('concrete frame without a rebar grade: analysis completes; an explicit check lists the rebar strength', async () => {
    ctx.llm.setInternal(internalResponder({ 'structural-router': () => routerDecision('concrete-frame'), 'param-extractor': () => ({
      draftPatch: { inferredType: 'frame', frameDimension: '2d', storyCount: 1, bayCount: 1, storyHeightsM: [3], bayWidthsM: [6],
        floorLoads: [{ story: 1, verticalKN: 20 }], frameBaseSupportType: 'fixed', frameConcreteGrade: 'C30',
        frameColumnSection: '500X500', frameBeamSection: '300X600' } }) }));
    const turn = await runTurn(ctx, { message: '分析一榀单层单跨钢筋混凝土框架，C30，柱500×500，梁300×600', context: { locale: 'zh' } }, [
      toolCall('extract_draft_params', { locale: 'zh' }, 'rc-extract'),
      toolCall('build_model', {}, 'rc-build'),
      toolCall('run_analysis', { analysisType: 'static' }, 'rc-analysis'),
      '分析已完成。',
    ]);
    const extraction = toolResultSeenByAgent(turn.requests, 'rc-extract');
    expect(extraction.criticalMissing).not.toContain('frameRebarGrade');
    expect(extraction.criticalMissing).toEqual([]);
    expect(turn.interactions).toEqual([]);
    expect(stepStatuses(turn.steps)).toEqual(['extract_draft_params', 'build_model', 'run_analysis'].map(tool => ({ tool, status: 'done' })));
    expect(await ctx.backend.session(turn.conversationId)).toMatchObject({ analysis: { current: true } });

    const check = await runTurn(ctx, { conversationId: turn.conversationId, message: '按GB50010验算', context: { locale: 'zh' } }, [
      toolCall('run_code_check', { designCode: 'GB50010', requestScope: { responses: ['forces'], design: true, outputs: [] } }, 'rc-check'),
      'CHECK_REPLY_REPLACED_BY_DELIVERY_NOTICE',
    ]);
    const result = toolResultSeenByAgent(check.requests, 'rc-check');
    expect(result).toMatchObject({ success: true, completionStatus: 'incomplete', nextAction: 'report_missing_inputs' });
    expect(result.missingInputs.map(row => row.field)).toContain('material.design.fy');
    expect(result.designValues.find(row => row.field === 'material.design.fc')).toMatchObject({ value: 14.3, source: 'GB 50010-2010 表4.1.4-1, C30' });
  }, TURN_TIMEOUT_MS * 2);
});
