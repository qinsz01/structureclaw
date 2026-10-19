import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, querySimplyBeamResponses, routerDecision, runTurn, setupHarness,
  toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';

describeWithOpenSees('characterization: relaxed section and clarification workflow', () => {
  const ctx = setupHarness();
  test.each([{ rounded: false }, { rounded: true }, { dimensioned: true }, { dimensioned: true, explicit: true }])('section source precedence after one answer (%j)', async ({ rounded, dimensioned, explicit }) => {
    const answer = dimensioned ? `Q235，I20a 尺寸 200×100×7×11.4${explicit ? '，Iy=2400cm4' : ''}` : 'Q235，工字钢 I20a';
    const question = '请提供材料和截面。';
    const narration = '内力可计算，挠度还需要材料和截面。';
    const inertia = explicit ? 2.4e-5 : dimensioned ? 2.35452664e-5 : rounded ? 2.3545e-5 : 2370e-8;
    const prompts = [];
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('beam'),
      'param-extractor': text => {
        prompts.push(text);
        return text.includes(answer) ? { engineeringDraft: {
          material: { grade: 'Q235' },
          ...(dimensioned ? { materials: [{ id: 'M', name: 'Q235', E: 206000, nu: .3 }] } : {}),
          sectionRecords: [{ id: 'S1', name: 'I20a', ...(dimensioned ? {} : { type: 'I' }), shape: { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 },
            properties: { ...(rounded || explicit ? {} : { A: 35.578e-4 }), Iy: dimensioned && !explicit ? 2370e-8 : inertia }, extra: { source: 'LLM: GB/T 706 table value, unverified',
              provenance: { shape: dimensioned ? 'user' : 'llm-table', properties: explicit ? 'user' : 'llm-table' } } }],
          templateAssignments: { beam: { sectionId: 'S1' } },
        } } : { engineeringDraft: {
          structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
          loads: [{ id: 'P', kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 5 } }],
          analysis: { loadCombinations: [] },
        }, requestScope: { responses: ['forces', 'reactions', 'displacements'], design: false, report: false, outputs: [] } };
      },
    }));
    const first = await runTurn(ctx, { message: '设计一个简支梁，跨度10m，梁中间荷载1kN', context: { locale: 'zh' } }, [
      toolCall('extract_draft_params', { locale: 'zh' }, 'initial'),
      { ...toolCall('ask_user_clarification', { question }, 'ask'), content: narration },
    ]);
    expect(first.interactions).toHaveLength(1);
    // Simulate an exhausted internal-fallback allowance at the durable interrupt.
    const waiting = await ctx.backend.session(first.conversationId);
    const recordPath = path.join(ctx.backend.dataDir, 'run-records', `${waiting.usage.runId}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    record.usage.recoveries = 2;
    record.usage.recoveriesUsed = 2;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    const resumed = await runTurn(ctx, { conversationId: first.conversationId, resumeValue: answer }, [
      toolCall('extract_draft_params', { message: answer, locale: 'zh' }, 'patch'), toolCall('build_model', {}, 'build'),
      toolCall('run_analysis', { analysisSkillId: 'opensees-static' }, 'analyze'), 'CATALOGUE_DONE',
    ], { resume: true });
    expect(resumed.interactions).toHaveLength(0);
    expect(prompts).toHaveLength(2);
    expect(prompts[1].length).toBeLessThan(10000);
    expect(toolResultSeenByAgent(resumed.requests, 'patch').criticalMissing).toEqual([]);
    const session = await ctx.backend.session(first.conversationId);
    const ledger = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    expect(ledger.usage.recoveriesUsed).toBe(0);
    expect(ledger.usage.recoveries).toBe(2); // cumulative history is not erased
    expect(ledger.usage.events.some(event => event.kind === 'clarification_resume')).toBe(true);
    const { model } = await ctx.backend.inputReview(first.conversationId);
    const section = model.sections[0];
    expect(section.type).toBe('I');
    expect(section.properties.Iy).toBeCloseTo(inertia, 13);
    expect(model.materials[0].rho).toBe(7850);
    expect(model.analysis_control?.self_weight ?? false).toBe(false);
    if (rounded || dimensioned && !explicit) expect(section.extra.property_geometry_delta).toBeUndefined();
    else if (!explicit) expect(section.extra.property_geometry_delta.A).toBeGreaterThan(1);
    const summary = toolResultSeenByAgent(resumed.requests, 'analyze');
    expect(summary.sectionAssumptions.some(note => dimensioned && !explicit
      ? note.code === 'SECTION_USER_GEOMETRY' && note.message.en.includes('sharp-corner') && note.message.zh.includes('尖角')
      : note.message.zh.includes('GB/T 706'))).toBe(true);
    const values = await querySimplyBeamResponses(ctx, first.conversationId, {
      runId: session.analysis.runId, supports: ['1', '3'], member: '1', positionM: 5,
    });
    for (const reaction of values.reactions) expect(reaction.value).toBeCloseTo(.5, 8);
    expect(Math.abs(values.moment.value)).toBeCloseTo(2.5, 8);
    expect(Math.abs(values.displacement.value)).toBeCloseTo(1000 * 10 ** 3 / (48 * 206e9 * inertia) * 1000, 7);
    const saved = (await ctx.backend.get(`/api/v1/chat/conversation/${first.conversationId}`)).body;
    const texts = saved.messages.filter(row => row.role === 'assistant').map(row => row.content);
    expect(texts.filter(text => text.includes(narration))).toHaveLength(1);
    expect(texts.filter(text => text === 'CATALOGUE_DONE')).toHaveLength(1);
  }, TURN_TIMEOUT_MS);

  test('adding deflection to a completed force-only draft uses a bounded patch', async () => {
    const prompts = [];
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('beam'),
      'param-extractor': text => {
        prompts.push(text);
        return text.includes('Q235, I20a') ? { engineeringDraft: {
          material: { grade: 'Q235' }, sectionRecords: [{ id: 'S', name: 'I20a', type: 'I',
            shape: { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 }, properties: { Iy: 2.37e-5 },
            extra: { source: 'LLM: GB/T 706 table value, unverified', provenance: { shape: 'llm-table', properties: 'llm-table' } } }],
          templateAssignments: { beam: { sectionId: 'S' } },
        } } : { engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 },
          boundary: { supportType: 'simply-supported' },
          loads: [{ id: 'P', kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 5 } }],
        }, requestScope: { responses: ['forces', 'reactions'], design: false, report: false, outputs: [] } };
      },
    }));
    const first = await runTurn(ctx, { message: 'Simply supported beam, span 10 m, 1 kN at midspan. Reactions and moment.', context: { locale: 'en' } }, [
      toolCall('extract_draft_params', { locale: 'en', requestScope: { responses: ['forces', 'reactions'], design: false, report: false, outputs: [] } }, 'force-extract'), toolCall('build_model', {}, 'force-build'),
      toolCall('run_analysis', { analysisSkillId: 'opensees-static' }, 'force-analyze'), 'FORCES_DONE',
    ]);
    const second = await runTurn(ctx, { conversationId: first.conversationId, message: 'Q235, I20a; include deflection.', context: { locale: 'en' } }, [
      toolCall('extract_draft_params', { locale: 'en', requestScope: { responses: ['forces', 'reactions', 'displacements'], design: false, report: false, outputs: [] } }, 'response-patch'),
      toolCall('build_model', {}, 'response-build'), toolCall('run_analysis', { analysisSkillId: 'opensees-static' }, 'response-analyze'), 'DEFLECTION_DONE',
    ]);
    expect(first.interactions).toHaveLength(0);
    expect(second.interactions).toHaveLength(0);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('PATCH ONLY');
    expect(prompts[1].length).toBeLessThan(10000);
    const request = second.requests.find(row => row.kind === 'param-extractor').body;
    expect(request.max_tokens).toBe(6144);
    expect(request.response_format).toEqual({ type: 'json_object' });
    const { model } = await ctx.backend.inputReview(first.conversationId);
    expect(model.sections[0].properties.Iy).toBe(2.37e-5);
    expect(model.materials[0].rho).toBe(7850);
    expect((await ctx.backend.session(first.conversationId)).analysis.current).toBe(true);
  }, TURN_TIMEOUT_MS);

});
