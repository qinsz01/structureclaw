// Scenario: 2026-10-17 live-acceptance conversation shape that deadlocked before analysis.
// "简支钢梁，跨度6m，跨中集中荷载10kN，Q355，H型钢 HN300x150，用OpenSees静力分析并出报告"
// The extractor (scripted like the live provider) records the designation HN300x150 without plate
// thicknesses, a confirmation on sections.beam and an unqualified missing `materials.E` while already
// writing E. Designations are labels (there is no section catalog): exactly one clarification asks for
// tw/tf, a choice naming the incomplete designation is not offered, and an answer that supplies the
// assigned section record (not sections.beam) completes the model, analysis and report.
import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, querySimplyBeamResponses, routerDecision, runTurn, setupHarness,
  toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { stepStatuses } from './helpers/normalize.mjs';

const MESSAGE = '简支钢梁，跨度6m，跨中集中荷载10kN，Q355，H型钢 HN300x150，用OpenSees静力分析并出报告';
const QUESTION = '截面 HN300x150 需要落实为具体尺寸，请选择。';
const CATALOG_OPTION = '按 HN300x150 取截面属性';
const EXPLICIT_OPTION = '按 H300x150x6.5x9（H×B×tw×tf，mm）理想化板件几何建模';
const ANSWER = EXPLICIT_OPTION;

const firstDraft = {
  engineeringDraft: {
    structureType: 'beam', geometry: { lengthM: 6 }, boundary: { supportType: 'simply-supported' },
    materials: [{ id: 'M1', name: 'Q355', category: 'steel', grade: 'Q355', E: 206000, G: 79000, nu: 0.3, rho: 7850 }],
    material: { family: 'steel', grade: 'Q355' },
    sectionRecords: [{ id: 'SEC1', name: 'HN300x150', type: 'H', purpose: 'beam', standard_steel_name: 'HN300x150' }],
    sections: { beam: 'HN300x150' }, templateAssignments: { beam: { materialId: 'M1', sectionId: 'SEC1' } },
    loads: [{ id: 'L1', kind: 'point', magnitude: 10, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 3, nodeRole: 'midspan' } }],
    analysis: { type: 'static', engineTarget: 'opensees', loadCombinations: [] }, analysisControl: { self_weight: false },
  },
  draftIssues: [
    { field: 'sections.beam', kind: 'confirmation', severity: 'ambiguous',
      reason: '用户仅给出热轧目录型号 HN300x150，未提供数值截面尺寸或属性。', question: '是否采用目录截面数值，还是提供具体截面尺寸？' },
    { field: 'materials.E', kind: 'missing', severity: 'invalid', reason: 'Only the grade designation Q355 is supplied.' },
  ],
  requestScope: { responses: ['forces', 'reactions', 'displacements', 'rotations'], design: false, report: true, outputs: [] },
};
// The answer supplies the assigned record's geometry and withdraws the catalog lookup; it does not re-send sections.beam.
const answerDraft = {
  engineeringDraft: { sectionRecords: [{ id: 'SEC1', shape: { kind: 'H', H: 300, B: 150, tw: 6.5, tf: 9 } }] },
  clearDraftFields: ['sectionRecords["SEC1"].standard_steel_name'],
};

/** Euler–Bernoulli midspan deflection for the idealized plate H section (mm). */
function plateHMidspanDeflectionMm({ P, L, E, H, B, tw, tf }) {
  const hw = H - 2 * tf;
  const I = (tw * hw ** 3 / 12 + 2 * (B * tf ** 3 / 12 + B * tf * ((hw + tf) / 2) ** 2)) / 1e12;
  return -P * L ** 3 / (48 * E * 1000 * I) * 1000;
}

describeWithOpenSees('characterization: HN designation without plate thicknesses', () => {
  const ctx = setupHarness();

  test('exactly one clarification asks for tw/tf, rejected choices are dropped and the answer reaches analysis and report', async () => {
    const extractorPrompts = [];
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('beam'),
      'param-extractor': text => {
        extractorPrompts.push(text);
        return text.includes(ANSWER) ? answerDraft : firstDraft;
      },
    }));

    const first = await runTurn(ctx, { message: MESSAGE, context: { locale: 'zh' } }, [
      toolCall('extract_draft_params', { locale: 'zh' }, 'hn-extract'),
      toolCall('ask_user_clarification', { question: QUESTION, optionsJson: JSON.stringify([CATALOG_OPTION, EXPLICIT_OPTION]) }, 'hn-ask'),
    ]);
    const extraction = toolResultSeenByAgent(first.requests, 'hn-extract');
    expect(extraction.criticalMissing).toContain('templateProperties');
    expect(extraction.criticalMissing).not.toContain('materials.E');
    const sectionQuestion = extraction.clarificationQuestions.find(question => question.paramKey === 'templateProperties');
    expect(sectionQuestion.question).toContain('截面 SEC1（HN300x150）');
    expect(sectionQuestion.question).toContain('腹板厚 tw 和翼缘厚 tf');
    expect(sectionQuestion.question).not.toContain('目录');
    expect(stepStatuses(first.steps)).toEqual([
      { tool: 'extract_draft_params', status: 'done' }, { tool: 'ask_user_clarification', status: 'running' }]);
    expect(first.interactions).toHaveLength(1);
    const waiting = await ctx.backend.session(first.conversationId);
    expect(waiting).toMatchObject({ waitingForReply: true, question: QUESTION, options: [EXPLICIT_OPTION], modelPending: true });

    const resumed = await runTurn(ctx, { conversationId: first.conversationId, resumeValue: ANSWER }, [
      toolCall('extract_draft_params', { locale: 'zh', message: ANSWER }, 'hn-extract-answer'),
      toolCall('build_model', {}, 'hn-build'),
      toolCall('run_analysis', { analysisType: 'static', analysisSkillId: 'opensees-static' }, 'hn-analysis'),
      toolCall('generate_report', { message: '生成报告', analysisType: 'static', locale: 'zh', narrative: 'structured' }, 'hn-report'),
      'HN_DONE',
    ], { resume: true });

    expect(resumed.interactions).toEqual([]);
    expect(extractorPrompts).toHaveLength(2);
    const merged = toolResultSeenByAgent(resumed.requests, 'hn-extract-answer');
    expect(merged.criticalMissing).toEqual([]);
    expect(merged).not.toHaveProperty('nextState');
    expect(merged.applied).toContain('engineeringDraft.sectionRecords["SEC1"].standard_steel_name');
    expect(stepStatuses(resumed.steps)).toEqual([
      { tool: 'ask_user_clarification', status: 'done' }, { tool: 'extract_draft_params', status: 'done' },
      { tool: 'build_model', status: 'done' }, { tool: 'run_analysis', status: 'done' }, { tool: 'generate_report', status: 'done' }]);

    const session = await ctx.backend.session(first.conversationId);
    expect(session).toMatchObject({ waitingForReply: false, modelRevision: 1, modelPending: false,
      analysis: { current: true }, report: { current: true } });
    const { model } = await ctx.backend.inputReview(first.conversationId);
    expect(model.sections[0]).not.toHaveProperty('standard_steel_name');
    expect(model.sections).toEqual([expect.objectContaining({ id: 'SEC1', shape: { kind: 'H', H: 300, B: 150, tw: 6.5, tf: 9 } })]);
    expect(model.materials[0]).toMatchObject({ id: 'M1', E: 206000 });
    const values = await querySimplyBeamResponses(ctx, first.conversationId, {
      runId: session.analysis.runId, supports: ['1', '3'], member: '1', positionM: 3 });
    for (const reaction of values.reactions) expect(reaction.value).toBeCloseTo(5, 8);
    expect(values.moment.value).toBeCloseTo(-15, 8);
    const deflection = plateHMidspanDeflectionMm({ P: 10, L: 6, E: 206000, H: 300, B: 150, tw: 6.5, tf: 9 });
    expect(Math.abs(values.displacement.value - deflection) / Math.abs(deflection)).toBeLessThan(1e-6);
  }, TURN_TIMEOUT_MS);
});
