// Unit corpus for the final-answer integrity checker (agent-langgraph/delivery/answer-integrity.ts).
// False positives (inputs, saved results in other units, code-table values with sources, shown
// derivations, counts, rounding) must not be flagged; invented result values must be.
import { describe, expect, test } from '@jest/globals';

const { buildEvidence, derivedInputNumbers, quantitySums, extractUnitNumbers, findActionClaims, findUnsupportedNumbers } = await import('../dist/agent-langgraph/delivery/answer-integrity.js');

const beamTool = JSON.stringify({ success: true, runId: '3f9c1d2e-8a7b-4c6d-9e0f-123456789abc', createdAt: '2026-10-18T09:12:33.123Z',
  reactions: { '1': { fz: 5.000000000001 }, '3': { fz: 4.999999999 } }, memberForces: { '1': { M2: -15.0000000002 } },
  displacements: { '2': { uz: -0.0031497 } }, summary: { maxDisplacementMm: 3.1497, maxMomentKnm: 15 } });
const BEAM_ZH = '设计一个简支钢梁，跨度6m，跨中集中荷载10kN，Q355，HN300×150×6.5×9';
const BEAM_EN = 'Design a simply supported steel beam, span 6 m, 10 kN point load at midspan, Q355, HN300×150×6.5×9';
const beamEvidence = buildEvidence([BEAM_ZH, BEAM_EN, beamTool]);
const forcesEvidence = buildEvidence(['计算简支梁内力，跨度10m，跨中1kN', JSON.stringify({ reactions: { A: { fz: 0.5 }, B: { fz: 0.5 } }, M: -2.5 })]);
const CONTINUOUS = 'two-span continuous beam 2×6 m, 10 kN/m, forces only';
const continuousEvidence = buildEvidence([CONTINUOUS, derivedInputNumbers([CONTINUOUS]),
  JSON.stringify({ reactions: { A: 22.5, B: 75, C: 22.5 }, supportMoment: -45 })]);

// [answer, evidence] pairs that must produce no unsupported number.
const NEGATIVES = [
  ['简支梁分析和报告已完成：支座反力各 5 kN，跨中弯矩 15 kN·m，跨中挠度约 3.15 mm。如需按 GB 50017 验算或修改模型，请告诉我。', beamEvidence],
  ['Analysis and report are done: reactions 5 kN each, midspan moment 15 kN·m, midspan deflection about 3.15 mm. If you want a GB 50017 check or a model change, tell me.', beamEvidence],
  ['支座反力 0.5 kN，跨中弯矩 |M| = 2.5 kN·m（跨度 10 m，跨中 1 kN）。', forcesEvidence],
  ['Equal EI assumed. Support moment 45 kN·m; reactions 22.5 kN, 75 kN and 22.5 kN under 10 kN/m over 2×6 m.', continuousEvidence],
  ['抗拉、抗压和抗弯强度设计值 f = 305 MPa（GB 50017-2017 表4.4.1, Q355, t=9mm≤16）。', beamEvidence],
  ['design shear strength fv = 175 MPa (GB 50017-2017 Table 4.4.1).', beamEvidence],
  ['The deflection limit is L/250 = 24 mm, so 3.15 mm is acceptable.', beamEvidence],
  ['挠度限值 l/400 = 6000/400 = 15 mm。', beamEvidence],
  ['In N: reactions 5000 N and moment 15000 N·m; the span is 6000 mm.', beamEvidence],
  ['The midspan deflection is 0.00315 m (3.1 mm).', beamEvidence],
  ['The model has 3 nodes, 2 elements and 1 load case.', beamEvidence],
  ['跨中弯矩 -15 kN·m（受拉在下）。', beamEvidence],
  ['跨度6米，荷载10千牛，弯矩 15 千牛·米。', beamEvidence],
  ['Section HN300×150×6.5×9: H = 300 mm, B = 150 mm, tw = 6.5 mm, tf = 9 mm.', beamEvidence],
  ['Q355 has a nominal yield strength of 355 MPa.', beamEvidence],
  ['E = 206,000 MPa', buildEvidence([JSON.stringify({ materials: [{ E: 206000 }] })])],
  ['uniform load q = 10 N/mm', continuousEvidence],
  // Live run 2026-10-18: equilibrium checks and totals derived from the user's inputs.
  ['总反力校核：22.5 + 75 + 22.5 = 120 kN = 10 kN/m × 12 m ✓', continuousEvidence],
  ['The total load is 120 kN over the 12 m length.', continuousEvidence],
  // Live batch 2: the same value shown once with its derivation; Chinese numeral "两跨" gives no input 2.
  ['合计 120 kN，与总荷载 2×6×10 = 120 kN 平衡 ✓', buildEvidence(['两跨连续梁，每跨6m，满跨均布荷载10kN/m'])],
  ['Reactions sum to 120 kN.', buildEvidence([quantitySums([22.5, 75, 22.5])])],
  // Live batch 3: second moment of area, limits written as "L/n (value)", derivation after the value.
  ['截面按 HN300×150×6.5×9 几何计算 Ix≈6930 cm⁴，A = 45.3 cm²，W = 462 cm³。', beamEvidence],
  ['far below typical limits such as L/400 (15 mm) or L/250 (24 mm).', beamEvidence],
  ['Reactions: 22.5 kN, 75 kN and 22.5 kN. Total = 120 kN = 10×12. ✓', buildEvidence(['two-span beam, each span 6 m, 10 kN/m', '22.5 75 22.5'])],
  // Live batch 4: units inside the following derivation; "≈" as the result sign.
  ['合计 120 kN = 10 kN/m × 12 m，竖向平衡满足。', buildEvidence(['两跨连续梁，每跨6m，满跨均布荷载10kN/m', JSON.stringify({ nodes: [{ x: 0 }, { x: 6 }, { x: 12 }] })])],
  ['the elastic bending stress is roughly 15×10⁶ / 478×10³ ≈ 31 MPa.', beamEvidence],
  ['No numbers with units here: case 1, 2 and 3.', beamEvidence],
  // A unit weight is not a line load: kN/m³ is not checked as kN/m.
  ['Concrete unit weight 25 kN/m³ (25 kN/m3).', beamEvidence],
];

// [answer, evidence, expected flagged raw values]
const POSITIVES = [
  ['跨中弯矩 20 kN·m，挠度 3.15 mm。', beamEvidence, ['20 kN·m']],
  ['The midspan deflection is 7.5 mm.', beamEvidence, ['7.5 mm']],
  ['Each reaction is 8 kN.', beamEvidence, ['8 kN']],
  ['Maximum bending stress is 123.4 MPa.', beamEvidence, ['123.4 MPa']],
  ['The moment is 60000 N·m.', beamEvidence, ['60000 N·m']],
  // Digits inside timestamps and IDs are not evidence.
  ['The reaction is 18 kN.', beamEvidence, ['18 kN']],
  ['跨中弯矩 30 kN·m，支座反力 12 kN。', forcesEvidence, ['30 kN·m', '12 kN']],
  // A cited code clause in another sentence does not cover an invented result.
  ['The check follows GB 50017 Table 4.4.1. The stress is 250 MPa.', beamEvidence, ['250 MPa']],
];

describe('final-answer integrity checker', () => {
  test('extracts values with engineering units and their precision', () => {
    expect(extractUnitNumbers('M = -15.25 kN·m, δ = 3 mm, q = 10 kN/m, 6米, 1,250 N, f=305MPa').map(item => [item.raw, item.family, item.decimals]))
      .toEqual([['-15.25 kN·m', 'moment', 2], ['3 mm', 'length', 0], ['10 kN/m', 'lineLoad', 0], ['6 米', 'length', 0],
        ['1,250 N', 'force', 0], ['305 MPa', 'stress', 0]]);
    expect(extractUnitNumbers('Q355 HN300 LC1 3 nodes 12 s 5 %')).toEqual([]);
  });

  test.each(NEGATIVES.map(([answer, evidence], index) => [index, answer, evidence]))('false-positive corpus %i: %s', (_index, answer, evidence) => {
    expect(findUnsupportedNumbers(answer, evidence).map(item => item.raw)).toEqual([]);
  });

  test.each(POSITIVES.map(([answer, evidence, flagged], index) => [index, answer, evidence, flagged]))('true-positive corpus %i: %s', (_index, answer, evidence, flagged) => {
    expect(findUnsupportedNumbers(answer, evidence).map(item => item.raw)).toEqual(flagged);
  });

  test('corpus summary: no false positives, every invented value detected', () => {
    const falsePositives = NEGATIVES.filter(([answer, evidence]) => findUnsupportedNumbers(answer, evidence).length > 0).length;
    const detected = POSITIVES.reduce((count, [answer, evidence, flagged]) => count
      + flagged.filter(raw => findUnsupportedNumbers(answer, evidence).some(item => item.raw === raw)).length, 0);
    const expected = POSITIVES.reduce((count, [, , flagged]) => count + flagged.length, 0);
    expect({ falsePositives, detected }).toEqual({ falsePositives: 0, detected: expected });
  });
});

describe('claimed-action detection', () => {
  test.each([
    ['报告已生成，请查看。', ['report']],
    ['已生成计算报告。', ['report']],
    ['I have generated the report.', ['report']],
    ['The report has been generated and saved.', ['report']],
    ['静力分析已完成。', ['analysis']],
    ['已完成结构分析。', ['analysis']],
    ['The static analysis was completed successfully.', ['analysis']],
    ['I have run the OpenSees analysis.', ['analysis']],
    ['所有验算均通过。', ['check-passed']],
    ['All checks passed.', ['check-passed']],
    ['The beam passes the GB50017 checks.', ['check-passed']],
  ])('affirmative: %s', (answer, actions) => {
    expect(findActionClaims(answer).map(item => item.action)).toEqual(actions);
  });

  test.each([
    '如需生成报告，请告诉我。',
    '尚未生成报告。',
    '未进行规范校核；验算未通过的项目为零。',
    '若验算通过，可以采用该截面。',
    'If you want, I can generate a report.',
    'The report was not generated.',
    'Once the analysis is run, the checks can be evaluated.',
    'I could run the analysis if you confirm the load.',
    'Whether the checks passed depends on the missing inputs.',
    '已完成需求分析，下面列出所需参数。',
    '分析已完成。',
    '我已经进行了初步分析。',
    'I have generated a summary of the report.',
    '本次未执行规范校核，当前分析结果不构成"验算合格"的结论。',
    '以上数值仅反映弹性分析结果，不构成验算合格与否的判断。',
    '合计 120 kN，竖向平衡校核通过。',
    'The equilibrium check passed.',
    '已生成报告摘要。',
  ])('negated, conditional or offered: %s', (answer) => {
    expect(findActionClaims(answer)).toEqual([]);
  });
});
