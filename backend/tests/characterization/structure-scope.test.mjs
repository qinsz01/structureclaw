import { readFileSync } from 'node:fs';
import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, runTurn, setupHarness, toolResultSeenByAgent, queryResult } from './helpers/harness.mjs';
import { beamModel } from './fixtures/engineering-beam.mjs';

// Read the actual frontend defaults; no independently maintained all-skills test scope.
const frontend = readFileSync(new URL('../../../frontend/src/lib/skill-normalization.ts', import.meta.url), 'utf8');
const skillIds = [...frontend.match(/DEFAULT_CONSOLE_SKILL_IDS = \[([\s\S]*?)\] as const/)[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
const scope = { responses: ['forces', 'reactions'], design: false, report: false, outputs: [] };
const point = { id: 'P', kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', location: { xM: 3 } };
const line = { id: 'Q', kind: 'line', magnitude: 20, unit: 'kN/m', direction: 'gravity', target: 'roof' };
const frame = { structureType: 'frame', coordinateSystem: { dimension: '2d' }, geometry: { storyHeightsM: [3, 3], bayWidthsM: [5, 5] },
  boundary: { frameBaseSupportType: 'fixed' }, material: { family: 'concrete', grade: 'C30' }, sections: { beam: '250X500', column: '400X400' },
  loads: [1, 2].flatMap(story => ['left', 'middle', 'right'].map(nodeRole => ({ id: `${story}-${nodeRole}`, kind: 'nodal', magnitude: .1, unit: 'kN', direction: 'globalX', location: { story, nodeRole } }))) };
const cases = [
  ['beam', '计算6m简支梁，跨中1kN向下集中力。', { structureType: 'beam', geometry: { lengthM: 6 }, boundary: { supportType: 'simply-supported' }, loads: [point] }],
  ['column', '计算3m悬臂柱，顶部向下1kN轴力。', { structureType: 'column', geometry: { heightM: 3 }, loads: [{ ...point, target: 'top', location: {} }] }],
  ['double-span-beam', '计算两跨连续梁，每跨6m，满跨向下20kN/m。', { structureType: 'double-span-beam', geometry: { spanLengthsM: [6, 6] }, loads: [line] }],
  ['frame', '计算两跨两层钢框架，跨度6m，层高3.5m，每层梁上20kN/m。', { structureType: 'frame', coordinateSystem: { dimension: '2d' }, geometry: { storyHeightsM: [3.5, 3.5], bayWidthsM: [6, 6] }, loads: [{ ...line, target: 'all beams' }] }],
  ['concrete-frame', '计算一个2*2的小混凝土框架，跨度5m，高度3米每层，一共两层，其他材料你自己安排，荷载除了地面外每个节点都有100N的x方向荷载', frame],
  ['portal-frame', '计算门式刚架，跨度12m，柱高6m，屋面向下20kN/m。', { structureType: 'portal-frame', geometry: { spanLengthsM: [12], heightM: 6 }, loads: [line] }],
  ['truss', '计算跨度6m高2m桁架，顶部节点向下1kN。', { structureType: 'truss', geometry: { lengthM: 6, heightM: 2 }, loads: [{ ...point, target: 'top-nodes', location: {} }] }],
  ['generic', '按所给显式节点和连接计算自定义结构：' + JSON.stringify(beamModel), { model: beamModel }],
];
describeWithOpenSees('all structure skills with frontend default scope', () => {
  const ctx = setupHarness();
  test.each(cases)('%s routes and completes analysis', async (id, message, engineeringDraft) => {
    let extractionCount = 0;
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => ({ action: id === 'generic' ? 'generic' : 'switch_skill', skillId: id,
        structuralTypeKey: id === 'generic' ? 'unknown' : id, mappedType: ['concrete-frame', 'frame'].includes(id) ? 'frame' : id === 'generic' ? 'unknown' : id, confidence: .99 }),
      'param-extractor': () => { extractionCount++; return { requestScope: scope, engineeringDraft: { ...engineeringDraft, analysisControl: { self_weight: false } } }; },
    }));
    const script = [toolCall('detect_structure_type', {}, 'route'), toolCall('extract_draft_params', {}, 'extract')];
    let first;
    if (id === 'concrete-frame') {
      first = await runTurn(ctx, { message, context: { locale: 'zh', skillIds } }, [...script,
        toolCall('ask_user_clarification', { question: '确认采用C30、梁250×500mm、柱400×400mm、柱脚刚接？', optionsJson: ['全部确认'] }, 'confirm')]);
      expect(first.interactions).toHaveLength(1);
    }
    const turn = await runTurn(ctx, first ? { conversationId: first.conversationId, resumeValue: '全部确认：C30、梁250×500mm、柱400×400mm、柱脚刚接。' }
      : { message, context: { locale: 'zh', skillIds } }, [
        ...(first ? [toolCall('extract_draft_params', {}, 'extract-confirmed')] : script),
        toolCall('build_model', {}, 'build'), toolCall('run_analysis', { analysisType: 'static', analysisSkillId: 'opensees-static' }, 'analysis'), 'DONE',
      ], { resume: !!first });
    expect(toolResultSeenByAgent((first ?? turn).requests, 'route').skillId).toBe(id);
    expect(extractionCount).toBeLessThanOrEqual(2);
    const session = await ctx.backend.session(turn.conversationId);
    expect(session.analysis.current).toBe(true);
    if (id === 'concrete-frame') {
      const { model } = await ctx.backend.inputReview(turn.conversationId);
      expect(model.nodes).toHaveLength(9);
      expect(model.nodes.filter(n => n.z === 0).every(n => n.restraints.every(Boolean))).toBe(true);
      expect(model.materials).toEqual(expect.arrayContaining([expect.objectContaining({ grade: 'C30' })]));
      expect(model.sections).toEqual(expect.arrayContaining([
        expect.objectContaining({ purpose: 'beam', name: '250X500' }),
        expect.objectContaining({ purpose: 'column', name: '400X400' }),
      ]));
      const loads = model.load_cases.flatMap(c => c.loads).filter(l => l.fx);
      expect(loads).toHaveLength(6);
      expect(loads.every(l => Math.abs(l.fx - .1) < 1e-10)).toBe(true);
      let shear = 0;
      for (const node of model.nodes.filter(n => n.z === 0)) {
        const response = await queryResult(ctx, turn.conversationId, { runId: session.analysis.runId, resultKey: session.analysis.resultKey,
          nodeId: node.id, field: 'reactions', component: 'fx', unit: 'kN', quantityId: `base-${node.id}` });
        shear += response.quantity.value;
      }
      expect(shear).toBeCloseTo(-.6, 7);
    }
  }, 120_000);
});
