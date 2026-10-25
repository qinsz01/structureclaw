import { expect, test } from '@jest/globals';
import { buildAnalysisToolSummary } from '../../../dist/agent-langgraph/tools.js';

const units = { displacement: 'm', rotation: 'rad', force: 'kN', moment: 'kN.m' };
const result = (fz, factor = 1) => ({
  success: true,
  analysis_type: 'static',
  meta: { modelRevision: 3 },
  data: {
    meta: { nodalResultFrame: 'global' },
    units,
    reactions: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
      `N${index + 1}`, { fx: factor, fy: -2 * factor, fz: fz * factor,
        mx: 3 * factor, my: -4 * factor, mz: 5 * factor, R: 99999 },
    ])),
    summary: { reactionTotals: { fz: 2040 } },
  },
});

test('reports signed solver reaction totals bound to each current case and combination', () => {
  const dead = result(790.5), live = result(210), combination = result(790.5 + 210, 1.5);
  const summary = buildAnalysisToolSummary({
    model: { metadata: { physicsCheck: { totalLoadKN: 2040 } } },
    result: { ...dead, runId: 'current-run', selectedResultKey: 'case:DEAD',
      results: { 'case:DEAD': dead, 'case:LIVE': live, 'combination:ULS': combination } },
  });
  expect(summary.runId).toBe('current-run');
  expect(summary.reactionTotals).toEqual({
    'case:DEAD': { nodeCount: 20, modelRevision: 3, referenceFrame: 'global',
      units: { force: 'kN', moment: 'kN.m' },
      values: { fx: 20, fy: -40, fz: 15810, mx: 60, my: -80, mz: 100 } },
    'case:LIVE': { nodeCount: 20, modelRevision: 3, referenceFrame: 'global',
      units: { force: 'kN', moment: 'kN.m' },
      values: { fx: 20, fy: -40, fz: 4200, mx: 60, my: -80, mz: 100 } },
    'combination:ULS': { nodeCount: 20, modelRevision: 3, referenceFrame: 'global',
      units: { force: 'kN', moment: 'kN.m' },
      values: { fx: 30, fy: -60, fz: 30015, mx: 90, my: -120, mz: 150 } },
  });
  expect(summary.responses.units).toEqual(units);
  expect(summary.reactionTotalsInstruction).toContain('excluding r×F');
});

test('totals include solver nodes omitted from the compact response sample', () => {
  const current = result(1);
  current.selection = { key: 'case:D', kind: 'case', id: 'D' };
  current.data.reactions = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
    `N${index + 1}`, { fx: 0, fy: 0, fz: index + 1, mx: 0, my: 0, mz: 0 },
  ]));
  const summary = buildAnalysisToolSummary({ result: current });
  expect(summary.responses.reactions.totalCount).toBe(65);
  expect(summary.responses.reactions.truncated).toBe(true);
  expect(Object.keys(summary.responses.reactions.values)).toHaveLength(60);
  expect(summary.reactionTotals['case:D'].values.fz).toBe(2145);
  expect(summary.reactionTotals['case:D'].nodeCount).toBe(65);
});

test('missing, nonnumeric and nonfinite components are unavailable rather than zero-filled', () => {
  const current = result(10);
  delete current.data.reactions.N20.fy;
  current.data.reactions.N19.fz = '10';
  current.data.reactions.N18.mx = Number.NaN;
  const summary = buildAnalysisToolSummary({ result: current });
  expect(summary.reactionTotals['analysis:default']).toMatchObject({
    values: { fx: 20, my: -80, mz: 100 }, missingComponents: ['fy', 'fz', 'mx'],
  });
  expect(Object.keys(summary.reactionTotals['analysis:default'].values)).toEqual(['fx', 'my', 'mz']);
});

test.each(['missing units', 'unknown frame', 'failed result', 'dynamic envelope', 'unknown analysis type'])('does not fabricate reaction totals for %s', condition => {
  const current = result(10);
  if (condition === 'missing units') delete current.data.units;
  if (condition === 'unknown frame') delete current.data.meta.nodalResultFrame;
  if (condition === 'failed result') current.success = false;
  if (condition === 'dynamic envelope') current.analysis_type = 'dynamic';
  if (condition === 'unknown analysis type') delete current.analysis_type;
  expect(buildAnalysisToolSummary({ result: current }).reactionTotals).toBeUndefined();
});

test('reads explicit canonical native units without conversion or magnitude summation', () => {
  const current = result(10);
  delete current.data.units;
  Object.assign(current.data.meta, { forceUnit: 'kN', momentUnit: 'kN.m' });
  const summary = buildAnalysisToolSummary({ result: current });
  expect(summary.reactionTotals['analysis:default'].units).toEqual({ force: 'kN', moment: 'kN.m' });
  expect(summary.reactionTotals['analysis:default'].values).not.toHaveProperty('R');
});
