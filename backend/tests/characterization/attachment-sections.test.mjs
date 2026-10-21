import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, routerDecision, runTurn, setupHarness,
  toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';

const properties = { A: .004, Iy: .00008, Iz: .00002, J: .000001 };
const scope = { responses: ['forces', 'reactions', 'displacements'], design: false, report: false, outputs: [] };

describeWithOpenSees('characterization: section table evidence', () => {
  const ctx = setupHarness();
  test.each([false, true])('table completes without repeated section confirmation (two turns: %s)', async twoTurns => {
    const created = await ctx.backend.post('/api/v1/chat/conversation', { title: 'Section table', type: 'general' });
    const conversationId = created.body.id;
    const relPath = `.uploads/${conversationId}/sections.csv`;
    const file = path.join(ctx.backend.dataDir, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'id,A (m2),Iy (m4),Iz (m4),J (m4)\nS1,0.004,0.00008,0.00002,0.000001\n');
    const fields = Object.keys(properties).map(key => `sections.S1.properties.${key}`);
    const inputEvidence = [
      ...Object.entries(properties).map(([key, value], index) => ({ id: `table:${key}`, field: fields[index],
        status: 'observed', required: true, value, unit: key === 'A' ? 'm2' : 'm4',
        source: { file: relPath, row: 2, column: index + 2 } })),
      { id: 'table:mapped', field: `file:${relPath}:fields`, status: 'resolved', required: true,
        resolution: { value: 'mapped', mappedFields: fields, reason: 'Section row mapped to stable section S1' } },
    ];
    let extracts = 0;
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => routerDecision('beam'),
      'param-extractor': () => {
        extracts++;
        const sectionInputs = { sectionRecords: [{ id: 'S1', type: 'custom', name: 'Table S1', properties,
          extra: { provenance: { properties: 'attachment' } } }], inputEvidence,
          templateAssignments: { beam: { materialId: 'M1', sectionId: 'S1' } } };
        return extracts > 1 ? { engineeringDraft: sectionInputs } : { requestScope: scope, engineeringDraft: {
          structureType: 'beam', geometry: { lengthM: 6 }, boundary: { supportType: 'simply-supported' },
          material: { grade: 'Q235', family: 'steel' },
          loads: [{ id: 'P', kind: 'point', magnitude: 10, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 3 } }],
          analysisControl: { self_weight: false }, ...(twoTurns ? {} : sectionInputs),
        } };
      },
    }));
    const finish = [toolCall('build_model', {}, 'build'), toolCall('validate_model', {}, 'validate'),
      toolCall('run_analysis', { analysisSkillId: 'opensees-static' }, 'analyze'), 'TABLE_DONE'];
    const first = await runTurn(ctx, { conversationId, message: '分析6m简支梁，跨中10kN向下，Q235钢，截面按附表，不计自重。',
      context: { locale: 'zh', attachments: [{ fileId: 'section-table', relPath, originalName: 'sections.csv' }] } }, [
      toolCall('extract_draft_params', {}, 'extract'),
      ...(twoTurns ? [toolCall('ask_user_clarification', { question: '这根梁使用附表S1行的截面吗？', optionsJson: ['按附表'] }, 'ask')] : finish),
    ]);
    const last = twoTurns ? await runTurn(ctx, { conversationId: first.conversationId, resumeValue: '按附表' }, [
      toolCall('extract_draft_params', {}, 'extract-again'), ...finish,
    ], { resume: true }) : first;
    expect(last.interactions).toHaveLength(0);
    expect(first.interactions).toHaveLength(twoTurns ? 1 : 0);
    expect(toolResultSeenByAgent(last.requests, 'build').success).toBe(true);
    const review = await ctx.backend.inputReview(first.conversationId);
    expect(review).toHaveProperty('model');
    expect(review.model.sections[0].properties).toMatchObject(properties);
    expect(review.model.sections[0].extra.provenance.properties).toBe('attachment');
    expect(review.model.sections[0].extra.evidence['properties.Iy'].evidenceId).toMatch(/^file:/);
    expect((await ctx.backend.session(first.conversationId)).analysis.current).toBe(true);
  }, TURN_TIMEOUT_MS);
});
