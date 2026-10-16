// Scenario 3: incomplete request → ask_user_clarification interrupt → /stream/resume with the
// answer → the answer is extracted and merged into the existing draft → build → OpenSees.
import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, querySimplyBeamResponses, routerDecision, runTurn, setupHarness,
  toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { eventSignature, normalizeVolatile, stepStatuses } from './helpers/normalize.mjs';
import { simplySupportedCentralLoad } from './fixtures/engineering-beam.mjs';

const QUESTION = '请提供荷载大小、类型与作用位置。';
const ANSWER = '跨中作用20kN集中荷载，竖直向下。';

describeWithOpenSees('characterization: clarification interrupt and resume', () => {
  const ctx = setupHarness();

  test('missing load pauses on ask_user_clarification; the resumed answer completes the draft and analysis', async () => {
    const extractorPrompts = [];
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('beam'),
      'param-extractor': text => {
        extractorPrompts.push(text);
        if (text.includes(ANSWER)) {
          return { engineeringDraft: { loads: [{ id: 'P1', kind: 'point', magnitude: 20, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 4 } }] } };
        }
        return {
          engineeringDraft: {
            structureType: 'beam', geometry: { lengthM: 8 }, boundary: { supportType: 'simply-supported' },
            materials: [{ id: 'M1', name: 'Q235 钢', E: 206000, nu: 0.3, rho: 7850 }],
            sectionRecords: [{ id: 'S1', name: '200×400 矩形', type: 'rectangular', shape: { kind: 'rectangular', B: 200, H: 400 } }],
            templateAssignments: { beam: { materialId: 'M1', sectionId: 'S1' } },
            analysisControl: { self_weight: false }, analysis: { loadCombinations: [] },
          },
          requestScope: { responses: ['forces', 'reactions', 'displacements'], method: 'solver', design: false, report: false, outputs: [] },
        };
      },
    }));

    const first = await runTurn(ctx, {
      message: '一根8米长的简支钢梁，矩形截面宽200mm高400mm，钢材E=206000MPa，不计自重，请分析内力和挠度。',
      context: { locale: 'zh' },
    }, [toolCall('extract_draft_params', { locale: 'zh' }, 'clarify-extract'), toolCall('ask_user_clarification', { question: QUESTION }, 'clarify-ask')]);

    const extraction = toolResultSeenByAgent(first.requests, 'clarify-extract');
    expect(extraction.criticalMissing).toEqual(expect.arrayContaining(['loadKN']));
    expect(extraction.skillId).toBe('beam');
    expect(stepStatuses(first.steps)).toEqual([
      { tool: 'extract_draft_params', status: 'done' }, { tool: 'ask_user_clarification', status: 'running' }]);
    expect(eventSignature(first.events)).toMatchSnapshot('interrupt-turn-sse-event-sequence');
    expect(first.interactions).toHaveLength(1);
    expect(normalizeVolatile(first.interactions[0], { dataDir: ctx.backend.dataDir })).toMatchSnapshot('interrupt-interaction-payload');
    expect(first.events.some(event => event.type === 'result')).toBe(false);

    const waiting = await ctx.backend.session(first.conversationId);
    expect(waiting).toMatchObject({ busy: false, waitingForReply: true, question: QUESTION, options: [], modelRevision: 0, modelPending: true });

    const resumed = await runTurn(ctx, { conversationId: first.conversationId, resumeValue: ANSWER }, [
      toolCall('extract_draft_params', { locale: 'zh', message: ANSWER }, 'clarify-extract-answer'),
      toolCall('build_model', {}, 'clarify-build'),
      toolCall('run_analysis', { analysisType: 'static', analysisSkillId: 'opensees-static' }, 'clarify-analysis'),
      'CLARIFIED_DONE',
    ], { resume: true });

    expect(toolResultSeenByAgent(resumed.requests, 'clarify-ask')).toMatchObject({ type: 'clarification_answered', question: QUESTION,
      answer: ANSWER, nextAction: 'extract_draft_params' });
    expect(stepStatuses(resumed.steps)).toEqual([
      { tool: 'ask_user_clarification', status: 'done' }, { tool: 'extract_draft_params', status: 'done' },
      { tool: 'build_model', status: 'done' }, { tool: 'run_analysis', status: 'done' }]);
    expect(eventSignature(resumed.events)).toMatchSnapshot('resume-turn-sse-event-sequence');
    // The existing draft is reused: no second router call, the answer is the extractor input.
    expect(resumed.requests.map(request => request.kind).filter(kind => kind !== 'agent')).toEqual(['param-extractor']);
    expect(extractorPrompts).toHaveLength(2);
    expect(extractorPrompts[1]).toContain(ANSWER);
    expect(extractorPrompts[1]).toContain('"lengthM": 8');
    const merged = toolResultSeenByAgent(resumed.requests, 'clarify-extract-answer');
    expect(merged.criticalMissing).toEqual([]);
    expect(merged.nextState.engineeringDraft).toMatchObject({ geometry: { lengthM: 8 }, boundary: { supportType: 'simply-supported' },
      templateAssignments: { beam: { materialId: 'M1', sectionId: 'S1' } },
      loads: [expect.objectContaining({ id: 'P1', magnitude: 20, location: { xM: 4 } })] });

    const session = await ctx.backend.session(first.conversationId);
    expect(session).toMatchObject({ waitingForReply: false, question: null, modelRevision: 1, modelPending: false, analysis: { current: true } });
    const { model } = await ctx.backend.inputReview(first.conversationId);
    expect(model.nodes.map(node => node.x)).toEqual([0, 4, 8]);
    expect(model.load_cases[0].loads).toEqual([{ node: '2', fz: -20, reference_frame: 'global', id: 'LC1:load:1' }]);
    const reference = simplySupportedCentralLoad({ P: 20, L: 8, E: 206000, b: 200, h: 400 });
    const values = await querySimplyBeamResponses(ctx, first.conversationId, {
      runId: session.analysis.runId, supports: ['1', '3'], member: '1', positionM: 4 });
    for (const reaction of values.reactions) expect(reaction.value).toBeCloseTo(reference.reactionKn, 8);
    expect(values.moment.value).toBeCloseTo(reference.midpointMomentKnm, 8);
    expect(values.displacement.value).toBeCloseTo(reference.midpointDisplacementMm, 8);
  }, TURN_TIMEOUT_MS);
});
