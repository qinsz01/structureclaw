import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, querySimplyBeamResponses, routerDecision, runTurn, setupHarness,
  toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';

describeWithOpenSees('characterization: relaxed section and clarification workflow', () => {
  const ctx = setupHarness();
  test.each([false, true])('I20a catalogue/rounding builds and analyzes after one answer (rounded=%s)', async rounded => {
    const answer = 'Q235，工字钢 I20a';
    const question = '请提供材料和截面。';
    const narration = '内力可计算，挠度还需要材料和截面。';
    const inertia = rounded ? 2.3545e-5 : 2370e-8;
    const prompts = [];
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('beam'),
      'param-extractor': text => {
        prompts.push(text);
        return text.includes(answer) ? { engineeringDraft: {
          material: { grade: 'Q235' },
          sectionRecords: [{ id: 'S1', name: 'I20a', type: 'I', shape: { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 },
            properties: { ...(rounded ? {} : { A: 35.578e-4 }), Iy: inertia }, extra: { source: 'LLM: GB/T 706 table value, unverified' } }],
          templateAssignments: { beam: { sectionId: 'S1' } },
        } } : { engineeringDraft: {
          structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
          loads: [{ id: 'P', kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 5 } }],
          analysisControl: { self_weight: false }, analysis: { loadCombinations: [] },
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
    expect(section.properties.Iy).toBe(inertia);
    if (rounded) expect(section.extra.property_geometry_delta).toBeUndefined();
    else expect(section.extra.property_geometry_delta.A).toBeGreaterThan(1);
    const summary = toolResultSeenByAgent(resumed.requests, 'analyze');
    expect(summary.sectionAssumptions.some(note => note.message.zh.includes('GB/T 706'))).toBe(true);
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
});
