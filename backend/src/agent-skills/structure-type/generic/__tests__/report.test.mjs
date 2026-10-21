import { expect, test } from '@jest/globals';
import { buildGenericReportNarrative } from '../../../../../dist/agent-skills/structure-type/generic/report.js';

const model = { coordinate_system: { dimension: '2d' }, nodes: [{ id: 'A', x: 0, y: 0, z: 0, restraints: [true, true, true, true, true, true] }, { id: 'B', x: 4, y: 0, z: 0 }],
  elements: [{ id: 'AB', nodes: ['A', 'B'] }], load_cases: [{ id: 'L', loads: [{ type: 'nodal', node: 'B', fz: -10 }] }] };
const input = { analysisType: 'static', analysisSuccess: true, summary: 'Solved', codeCheckText: '', keyMetrics: { maxAbsDisplacement: 0.002, maxAbsMoment: 40 },
  controllingCases: { batchControlCase: { moment: 'L' }, controlElementMoment: 'AB' }, normalizedModel: model,
  analysis: { results: { 'case:L': { data: { meta: { units: { displacement: 'm', moment: 'kN.m' } } } } } } };
test.each(['en', 'zh'])('generic %s report explains supports, actual load totals and governing units', locale => {
  const report = buildGenericReportNarrative({ ...input, locale });
  expect(report).toContain('A: ux, uy, uz, rx, ry, rz');
  expect(report).toContain('L: (0, 0, -10)');
  expect(report).toContain('40 kN.m (L / AB)');
  expect(report).toContain('0.002 m');
  expect(report).toContain(locale === 'zh' ? '不含自重' : 'self-weight excluded');
});
test.each(['en', 'zh'])('generic %s report never presents unit-stiffness displacement as a physical result', locale => {
  const report = buildGenericReportNarrative({ ...input, locale, normalizedModel: { ...model, metadata: { stiffnessPlaceholder: { section: true } } } });
  expect(report).not.toContain('0.002');
  expect(report).toContain('40 kN.m');
  expect(report).toContain(locale === 'zh' ? '单位刚度占位' : 'Unit stiffness');
});
