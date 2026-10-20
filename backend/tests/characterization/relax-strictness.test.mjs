import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, querySimplyBeamResponses, routerDecision, runTurn, setupHarness,
  toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';

describeWithOpenSees('characterization: relaxed section and clarification workflow', () => {
  const ctx = setupHarness();
  test.each([{ rounded: false }, { rounded: true }, { dimensioned: true }, { dimensioned: true, explicit: true },
    { dimensioned: true, filleted: true }])('section source precedence after one answer (%j)', async ({ rounded, dimensioned, explicit, filleted }) => {
    const answer = dimensioned ? `Q235，I20a 尺寸 200×100×7×11.4${explicit ? '，Iy=2400cm4' : ''}${filleted ? '，圆角 r=9mm' : ''}`
      : `Q235，I20a 尺寸 200×100×7×11.4，${rounded ? 'Iy=2354.5cm4' : 'A=35.578cm2，Iy=2370cm4'}`;
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
          sectionRecords: [{ id: 'S1', name: 'I20a', ...(dimensioned ? {} : { type: 'I' }), shape: { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4, ...(filleted ? { r: 9 } : {}) },
            properties: { ...(rounded || explicit ? {} : { A: 35.578e-4 }), Iy: dimensioned && !explicit ? 2370e-8 : inertia }, extra: { source: dimensioned && !explicit ? 'LLM: recalled, unconfirmed' : 'User supplied / 用户提供',
              provenance: { shape: 'user', properties: dimensioned && !explicit ? 'llm-table' : 'user' } } }],
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
    if (filleted) {
      expect(section.shape.r).toBe(9);
      expect(summary.success).toBe(true);
      expect(summary.sectionAssumptions).toContainEqual(expect.objectContaining({ code: 'SECTION_FILLET_IGNORED',
        message: { en: expect.stringContaining('r=9'), zh: expect.stringContaining('圆角') } }));
      expect(resumed.requests.filter(row => row.kind === 'agent').flatMap(row => row.body.messages)
        .filter(row => row.role === 'tool' && row.tool_call_id === 'analyze').length).toBe(1);
    }
    expect(summary.sectionAssumptions.some(note => dimensioned && !explicit
      ? note.code === 'SECTION_USER_GEOMETRY' && note.message.en.includes('sharp-corner') && note.message.zh.includes('尖角')
      : note.message.zh.includes('用户提供'))).toBe(true);
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
            shape: { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 },
            extra: { provenance: { shape: 'user' } } }],
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
    const second = await runTurn(ctx, { conversationId: first.conversationId, message: 'Q235, I20a dimensions 200×100×7×11.4 mm; include deflection.', context: { locale: 'en' } }, [
      toolCall('extract_draft_params', { locale: 'en', requestScope: { responses: ['forces', 'reactions', 'displacements'], design: false, report: false, outputs: [] } }, 'response-patch'),
      toolCall('build_model', {}, 'response-build'), toolCall('run_analysis', { analysisSkillId: 'opensees-static' }, 'response-analyze'), 'DEFLECTION_DONE',
    ]);
    expect(first.interactions).toHaveLength(0);
    expect(second.interactions).toHaveLength(0);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('PATCH ONLY');
    expect(prompts[1].length).toBeLessThan(10000);
    const request = second.requests.find(row => row.kind === 'param-extractor').body;
    expect(request.max_tokens).toBe(1024);
    expect(request.response_format).toEqual({ type: 'json_object' });
    const { model } = await ctx.backend.inputReview(first.conversationId);
    expect(model.sections[0].properties.Iy).toBeCloseTo(2.35452664e-5, 13);
    expect(model.materials[0].rho).toBe(7850);
    expect((await ctx.backend.session(first.conversationId)).analysis.current).toBe(true);
  }, TURN_TIMEOUT_MS);

  test.each(['zh', 'en'])('designation-only recall is refused, then one confirmed option completes analysis (%s)', async locale => {
    const zh = locale === 'zh';
    const label = zh ? '助手记忆的标准表值，请核对' : 'assistant-recalled table value, please verify';
    const answer = zh ? `确认采用 Q235，I20a 尺寸 200×100×7×11.4 mm（${label}）`
      : `I confirm Q235, I20a dimensions 200×100×7×11.4 mm (${label})`;
    const shape = { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 };
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('beam'),
      'param-extractor': text => text.includes(answer) ? { engineeringDraft: {
        ...(zh ? { material: { grade: 'Q235' } } : { materials: [{ id: 'M', grade: 'Q235' }] }),
        sectionRecords: [{ id: 'S', shape, extra: { provenance: { shape: 'user' } } }],
      } } : { engineeringDraft: {
        structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
        loads: [{ id: 'P', kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 5 } }],
        sectionRecords: [{ id: 'S', name: 'I20a', type: 'I', shape, properties: { A: .0035578, Iy: 2.37e-5 },
          // Reproduce the live failure: the extractor claims that a designation confirms its own numbers.
          extra: { provenance: { shape: 'user', properties: 'user' }, source: `LLM: ${label}` } }],
        templateAssignments: { beam: { sectionId: 'S' } },
      }, requestScope: { responses: ['forces', 'reactions', 'displacements'], design: false, report: false, outputs: [] } },
    }));
    const first = await runTurn(ctx, { message: zh ? '跨度10m简支梁，跨中1kN，工字钢I20a。' : 'Simply supported I20a beam, span 10 m, 1 kN at midspan.', context: { locale } }, [
      toolCall('extract_draft_params', { locale }, 'unconfirmed-extract'),
      toolCall('build_model', {}, 'unconfirmed-build'),
      toolCall('run_analysis', { analysisSkillId: 'opensees-static' }, 'unconfirmed-analysis'),
      toolCall('ask_user_clarification', { question: zh ? '请一起确认材料与截面尺寸。' : 'Please confirm the material and section dimensions together.', optionsJson: JSON.stringify([answer]) }, 'confirm-dimensions'),
    ], { expectedToolErrors: 2 });
    expect(first.interactions).toHaveLength(1);
    expect(JSON.stringify(first.interactions)).toContain(label);
    expect(toolResultSeenByAgent(first.requests, 'unconfirmed-extract').criticalMissing).toContain('sectionConfirmation');
    expect(toolResultSeenByAgent(first.requests, 'unconfirmed-build')).toMatchObject({ errorCode: 'SECTION_CONFIRMATION_REQUIRED',
      recoverable: true, candidates: [expect.objectContaining({ id: 'S', shape })] });
    expect((await ctx.backend.session(first.conversationId)).analysis.current).toBe(false);
    expect((await ctx.backend.inputReview(first.conversationId)).model).toBeFalsy();
    const prose = zh ? '支座反力各0.5 kN，跨中弯矩2.5 kN·m，挠度4.30 mm。用户确认了助手候选尺寸，截面属性由系统按尖角几何推导（不计圆角，sharp-corner）。未计自重，未进行规范校核。'
      : 'Each reaction is 0.5 kN; midspan moment is 2.5 kN·m; deflection is 4.30 mm. The user confirmed the assistant-proposed dimensions. The system derived sharp-corner properties (no fillets). Self-weight is excluded. No code check was run.';
    const resumed = await runTurn(ctx, { conversationId: first.conversationId, resumeValue: answer }, [
      toolCall('extract_draft_params', { message: answer, locale }, 'confirmed-extract'), toolCall('build_model', {}, 'confirmed-build'),
      toolCall('run_analysis', { analysisSkillId: 'opensees-static' }, 'confirmed-analysis'), prose,
    ], { resume: true });
    expect(resumed.interactions).toHaveLength(0);
    const { model } = await ctx.backend.inputReview(first.conversationId);
    expect(model.sections[0].properties.Iy).toBeCloseTo(2.35452664e-5, 13);
    expect(model.sections[0].extra.provenance).toMatchObject({ shape: 'user', properties: 'geometry' });
    const session = await ctx.backend.session(first.conversationId);
    expect(session.analysis.current).toBe(true);
    const values = await querySimplyBeamResponses(ctx, first.conversationId, { runId: session.analysis.runId, supports: ['1', '3'], member: '1', positionM: 5 });
    expect(Math.abs(values.displacement.value)).toBeCloseTo(1000 * 10 ** 3 / (48 * 206e9 * 2.35452664e-5) * 1000, 7);
    const saved = (await ctx.backend.get(`/api/v1/chat/conversation/${first.conversationId}`)).body;
    const delivered = saved.messages.filter(row => row.role === 'assistant').at(-1).content;
    expect(delivered).toBe(prose);
    expect(delivered).not.toMatch(/满足要求|clearly adequate|passes? (?:the )?code/i);
    expect(delivered).toMatchSnapshot('confirmed dimensions analysis prose');
  }, TURN_TIMEOUT_MS);

});
