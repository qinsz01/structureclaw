import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@jest/globals';
import { toolCall, requestText } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, querySimplyBeamResponses, routerDecision, runTurn, setupHarness,
  toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';

const saved = JSON.parse(fs.readFileSync(new URL('../fixtures/material-merge-session.json', import.meta.url), 'utf8'));
const scope = { responses: ['forces', 'reactions', 'displacements'], design: false, report: false, outputs: [] };

describeWithOpenSees('characterization: material and section clarification after an exhausted patch', () => {
  const ctx = setupHarness();
  test.each([['zh', 'length'], ['en', 'length'], ['zh', 'invalid_patch'], ['en', 'invalid_patch']])(
    'two answers preserve material, compact feedback and review state (%s, %s)', async (locale, failure) => {
    let patches = 0;
    ctx.llm.setInternal((body, record) => {
      if (record.kind === 'structural-router') return JSON.stringify(routerDecision('beam'));
      if (record.kind !== 'param-extractor') return undefined;
      const text = requestText(body);
      if (!text.includes('PATCH ONLY')) return JSON.stringify({ ...saved.extractions[0].llmDraftPatch, requestScope: scope });
      patches++;
      if (patches === 1) return failure === 'length' ? { content: '', finish_reason: 'length' }
        : JSON.stringify({ engineeringDraft: { material: { grade: 'Q235' },
          sectionRecords: [{ id: 'S1', shape: { kind: 'I', designation: 'I20a' } }] } });
      if (patches === 2) return JSON.stringify({ engineeringDraft: { material: { grade: 'Q235', family: 'steel' },
        sectionRecords: [{ id: 'S1', name: 'I20a', shape: { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 },
          materials: [], extra: { provenance: { shape: 'llm-table' }, source: 'LLM: assistant-recalled table value, please verify' } }] },
        templateAssignments: { beam: { sectionId: 'S1' } } });
      if (patches === 3 && failure === 'invalid_patch') return JSON.stringify({
        clearDraftFields: ['sectionRecords["S1"].extra.provenance.llm-table-shape'],
        engineeringDraft: { sectionRecords: [{ id: 'S1', extra: { provenance: { shape: 'user' } } }] } });
      return JSON.stringify({ engineeringDraft: { sectionRecords: [{ id: 'S1', extra: { provenance: { shape: 'user' } } }] } });
    });
    const first = await runTurn(ctx, { message: saved.answers[0], context: { locale } }, [
      toolCall('extract_draft_params', { locale }, 'initial'),
      toolCall('ask_user_clarification', { question: locale === 'zh' ? '请提供材料与截面。' : 'Provide material and section.' }, 'ask-material'),
    ]);
    const second = await runTurn(ctx, { conversationId: first.conversationId, resumeValue: saved.answers[1] }, [
      toolCall('extract_draft_params', { locale }, 'material'),
      toolCall('ask_user_clarification', { question: locale === 'zh' ? '请确认助手记忆的 I20a 尺寸 200×100×7×11.4 mm。'
        : 'Confirm assistant-recalled I20a dimensions 200×100×7×11.4 mm.' }, 'ask-dimensions'),
    ], { resume: true });
    const material = toolResultSeenByAgent(second.requests, 'material');
    expect(material.applied).toContain('engineeringDraft.materials["M1"].grade');
    expect(material.criticalMissing).toContain('sectionConfirmation');
    expect(material).not.toHaveProperty('nextState');
    const third = await runTurn(ctx, { conversationId: first.conversationId, resumeValue: saved.answers[2] }, [
      toolCall('extract_draft_params', { locale }, 'dimensions'), toolCall('build_model', {}, 'build'),
      toolCall('validate_model', {}, 'validate'), toolCall('run_analysis', { analysisSkillId: 'opensees-static' }, 'analyze'), 'MATERIAL_DONE',
    ], { resume: true });
    expect(third.interactions).toHaveLength(0);
    expect(first.interactions.length + second.interactions.length).toBe(2);
    const dimensions = toolResultSeenByAgent(third.requests, 'dimensions');
    expect(dimensions.criticalMissing).toEqual([]);
    expect(dimensions.applied).toContain('engineeringDraft.sectionRecords["S1"].extra.provenance.shape');
    const outputs = [toolResultSeenByAgent(first.requests, 'initial'), material, dimensions];
    expect(outputs.every(output => output.applied.length > 0)).toBe(true);
    expect(outputs.every(output => !('nextState' in output) && !('engineeringDraft' in output))).toBe(true);
    const session = await ctx.backend.session(first.conversationId);
    const { model } = await ctx.backend.inputReview(first.conversationId);
    expect(model.materials[0]).toMatchObject({ id: 'M1', name: 'Q235', E: 206000 });
    expect(model.sections[0].shape).toEqual({ kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 });
    const result = await querySimplyBeamResponses(ctx, first.conversationId, { runId: session.analysis.runId,
      supports: ['1', '3'], member: '1', positionM: 5 });
    expect(Math.abs(result.displacement.value)).toBeCloseTo(4.295, 3);
    const record = JSON.parse(fs.readFileSync(path.join(ctx.backend.dataDir, 'run-records', `${session.usage.runId}.json`), 'utf8'));
    expect(record.usage.events.filter(event => event.kind === 'param_extractor').map(event => [event.mode, event.attempt, event.outcome]))
      .toEqual(failure === 'length'
        ? [['full', 1, 'accepted'], ['patch', 1, 'length'], ['patch', 2, 'accepted'], ['patch', 1, 'accepted']]
        : [['full', 1, 'accepted'], ['patch', 1, 'invalid_patch'], ['patch', 2, 'accepted'], ['patch', 1, 'invalid_patch'], ['patch', 2, 'accepted']]);
    expect(second.requests.filter(row => row.kind === 'param-extractor').map(row => row.body.max_tokens)).toEqual([1024, 2048]);
  }, TURN_TIMEOUT_MS);
});
