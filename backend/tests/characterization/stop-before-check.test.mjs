// Scenario: the default workflow stops after analysis and report (2026-10-18 product decision).
// "设计一个简支钢梁，跨度6m，跨中集中荷载10kN，Q355，HN300×150×6.5×9" is model → analysis → report in one
// turn: "design" does not request a code check, design inputs proposed by the extractor never block or
// prompt, and the four-dimension designation is parsed as sharp-corner H geometry (no catalog). A later
// explicit "按GB50017验算" runs run_code_check and delivers performed checks plus the checks not performed
// with their missing inputs, without a clarification interrupt. Code-determined values (f, fv from GB 50017
// Table 4.4.1 by grade and flange thickness) are looked up with their sources; only engineering-judgment
// inputs (lateral stability factor, deflection limit) remain missing.
import { expect, test } from '@jest/globals';
import { systemPrompt, toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, querySimplyBeamResponses, routerDecision, runTurn, setupHarness,
  toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { stepStatuses } from './helpers/normalize.mjs';

const BEAM = { P: 10, L: 6, E: 206000, H: 300, B: 150, tw: 6.5, tf: 9 };
const DEFAULT_PIPELINE = ['extract_draft_params', 'build_model', 'validate_model', 'run_analysis', 'generate_report'];

/** Euler–Bernoulli midspan deflection for the sharp-corner plate H section (mm). */
function plateHMidspanDeflectionMm({ P, L, E, H, B, tw, tf }) {
  const hw = H - 2 * tf;
  const I = (tw * hw ** 3 / 12 + 2 * (B * tf ** 3 / 12 + B * tf * ((hw + tf) / 2) ** 2)) / 1e12;
  return -P * L ** 3 / (48 * E * 1000 * I) * 1000;
}

// Design inputs a live extractor tends to flag; they must neither block nor prompt the analysis.
const designIssues = [
  { field: 'design.l0', kind: 'missing', severity: 'invalid', reason: 'Effective length for a GB50017 check is not given.' },
  { field: 'material.designStrength', kind: 'missing', severity: 'invalid', reason: 'Design strength f is not given.' },
];
const scope = { responses: ['forces', 'reactions', 'displacements'], design: false };

const LOCALES = {
  zh: {
    message: '设计一个简支钢梁，跨度6m，跨中集中荷载10kN，Q355，HN300×150×6.5×9',
    // A labelled record without shape: the designation itself carries H×B×tw×tf.
    draft: {
      engineeringDraft: {
        structureType: 'beam', geometry: { lengthM: 6 }, boundary: { supportType: 'simply-supported' },
        material: { family: 'steel', grade: 'Q355' },
        sectionRecords: [{ id: 'S1', name: 'HN300×150×6.5×9', type: 'H', purpose: 'beam', standard_steel_name: 'HN300×150×6.5×9' }],
        templateAssignments: { beam: { sectionId: 'S1' } },
        loads: [{ id: 'P1', kind: 'point', magnitude: 10, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 3, nodeRole: 'midspan' } }],
      },
      draftIssues: designIssues, requestScope: scope,
    },
    stop: '停止并结束本轮', checkOnly: '用户未要求时不做规范校核', basis: '无圆角理想化板件几何',
    final: '简支梁分析和报告已完成：支座反力各 5 kN，跨中弯矩 15 kN·m，跨中挠度约 3.15 mm。如需按 GB 50017 验算或修改模型，请告诉我。',
    check: '按GB50017验算', notPerformed: '未执行的校核及所缺输入', strength: '抗拉、抗压和抗弯强度设计值 f = 305 MPa（GB 50017-2017 表4.4.1, Q355, t=9mm≤16）',
  },
  en: {
    message: 'Design a simply supported steel beam, span 6 m, 10 kN point load at midspan, Q355, HN300×150×6.5×9',
    // A role declaration only: the template parses the designation string.
    draft: {
      engineeringDraft: {
        structureType: 'beam', geometry: { lengthM: 6 }, boundary: { supportType: 'simply-supported' },
        material: { family: 'steel', grade: 'Q355' }, sections: { beam: 'HN300×150×6.5×9' },
        loads: [{ id: 'P1', kind: 'point', magnitude: 10, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 3, nodeRole: 'midspan' } }],
      },
      draftIssues: designIssues, requestScope: scope,
    },
    stop: 'Stop and end the turn', checkOnly: 'Do not run a code check the user did not ask for', basis: 'sharp-corner plate geometry',
    final: 'Analysis and report are done: reactions 5 kN each, midspan moment 15 kN·m, midspan deflection about 3.15 mm. If you want a GB 50017 check or a model change, tell me.',
    check: 'Check it against GB50017', notPerformed: 'Checks not performed and missing inputs', strength: 'design strength f = 305 MPa (GB 50017-2017 表4.4.1, Q355, t=9mm≤16)',
  },
};

describeWithOpenSees('characterization: default workflow stops before code checking', () => {
  const ctx = setupHarness();

  test.each(['zh', 'en'])('%s one-sentence beam: analysis + report in one turn, no check; explicit check reports missing inputs', async locale => {
    const spec = LOCALES[locale];
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('beam'),
      'param-extractor': () => spec.draft,
    }));
    const prefix = `stop-${locale}`;
    const first = await runTurn(ctx, { message: spec.message, context: { locale } }, [
      toolCall('extract_draft_params', { locale }, `${prefix}-extract`),
      toolCall('build_model', {}, `${prefix}-build`),
      toolCall('validate_model', {}, `${prefix}-validate`),
      toolCall('run_analysis', { analysisType: 'static', analysisSkillId: 'opensees-static' }, `${prefix}-analysis`),
      toolCall('generate_report', { message: spec.message, analysisType: 'static', locale, narrative: 'structured' }, `${prefix}-report`),
      spec.final,
    ]);

    // (1) The default prompt stops after the report and runs checks only on explicit request.
    const prompt = systemPrompt(first.requests.find(request => request.kind === 'agent').body);
    expect(prompt).toContain(spec.stop);
    expect(prompt).toContain(spec.checkOnly);

    // (2) Design inputs flagged by the extractor are dropped: nothing blocks, nothing is asked.
    const extraction = toolResultSeenByAgent(first.requests, `${prefix}-extract`);
    expect(extraction.criticalMissing).toEqual([]);
    expect(extraction.optionalMissing).toEqual([]);
    expect(extraction.clarificationQuestions).toEqual([]);
    expect(extraction).not.toHaveProperty('nextState');
    // report is omitted: displacement is requested too, so the report is generated by default.
    expect(extraction.requestScope).toMatchObject({ design: false });

    // (3) One turn: analysis + report, no run_code_check, no clarification; the final answer is delivered as written.
    expect(stepStatuses(first.steps)).toEqual(DEFAULT_PIPELINE.map(tool => ({ tool, status: 'done' })));
    expect(first.interactions).toEqual([]);
    expect(first.result.content.response).toBe(spec.final);
    const session = await ctx.backend.session(first.conversationId);
    expect(session).toMatchObject({ waitingForReply: false, modelRevision: 1, modelPending: false,
      analysis: { current: true }, report: { current: true } });

    // (4) The designation is explicit sharp-corner H geometry, stated in the report.
    const { model } = await ctx.backend.inputReview(first.conversationId);
    expect(model.sections).toHaveLength(1);
    expect(model.sections[0].shape).toEqual({ kind: 'H', H: 300, B: 150, tw: 6.5, tf: 9 });
    expect(model.sections[0]).not.toHaveProperty('standard_steel_name');
    expect(model.materials[0]).toMatchObject({ E: 206000 });
    expect(first.result.content.report.markdown).toContain(spec.basis);

    const values = await querySimplyBeamResponses(ctx, first.conversationId, {
      runId: session.analysis.runId, supports: ['1', '3'], member: '1', positionM: 3 });
    for (const reaction of values.reactions) expect(reaction.value).toBeCloseTo(5, 8);
    expect(values.moment.value).toBeCloseTo(-15, 8);
    const deflection = plateHMidspanDeflectionMm(BEAM);
    expect(Math.abs(values.displacement.value - deflection) / Math.abs(deflection)).toBeLessThan(1e-6);

    // (5) Explicit check request: run_code_check executes and reports instead of interrupting.
    const followUp = await runTurn(ctx, { conversationId: first.conversationId, message: spec.check, context: { locale } }, [
      toolCall('run_code_check', { designCode: 'GB50017',
        requestScope: { ...scope, design: true, report: true, outputs: [] } }, `${prefix}-check`),
      'CHECK_REPLY_REPLACED_BY_DELIVERY_NOTICE',
    ]);
    expect(stepStatuses(followUp.steps)).toEqual([{ tool: 'run_code_check', status: 'done' }]);
    expect(followUp.interactions).toEqual([]);
    const check = toolResultSeenByAgent(followUp.requests, `${prefix}-check`);
    expect(check).toMatchObject({ success: true, provider: 'builtin', skillId: 'code-check-gb50017',
      completionStatus: 'incomplete', nextAction: 'report_missing_inputs' });
    expect(check.checkedItems.totalCount).toBeGreaterThan(0);
    expect(check.missingInputs.length).toBeGreaterThan(0);
    const missingFields = check.missingInputs.map(row => row.field);
    expect(missingFields).toEqual(expect.arrayContaining(['member.design.phi_b', 'member.design.deflectionLimitN']));
    expect(missingFields).not.toEqual(expect.arrayContaining(['material.design.f']));
    expect(missingFields).not.toEqual(expect.arrayContaining(['material.design.fv']));
    const performed = Object.fromEntries(check.checkedItems.items.filter(item => item.status === 'pass').map(item => [item.check, item]));
    expect(performed['正应力'].inputs.capacity).toBe(305);
    expect(performed['剪应力'].inputs.capacity).toBe(175);
    const designValueRows = Object.fromEntries(check.designValues.map(row => [row.field, row]));
    expect(designValueRows['material.design.f']).toMatchObject({ value: 305, origin: 'code-table', source: 'GB 50017-2017 表4.4.1, Q355, t=9mm≤16' });
    expect(designValueRows['material.design.fv']).toMatchObject({ value: 175, source: 'GB 50017-2017 表4.4.1, Q355, t=9mm≤16' });
    const reply = followUp.result.content.response;
    expect(reply).toContain(spec.notPerformed);
    expect(reply).toContain(spec.strength);
    expect(await ctx.backend.session(first.conversationId)).toMatchObject({ waitingForReply: false, analysis: { current: true } });
  }, TURN_TIMEOUT_MS * 2);
});
