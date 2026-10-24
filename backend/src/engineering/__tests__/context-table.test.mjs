import { expect, test } from '@jest/globals';
import { compactCodeCheckFeedback } from '../../../dist/engineering/code-checks.js';
import { contextTable } from '../../../dist/engineering/context-table.js';

function expand(table) {
  return Array.from({ length: table.rowCount }, (_, row) => Object.fromEntries(Object.entries(table.columns).flatMap(([field, column]) =>
    Object.hasOwn(column, 'shared') ? [[field, column.shared]] : column.indexes[row] === -1 ? [] : [[field, column.values[column.indexes[row]]]])));
}

test('large check context preserves every failure, missing value, unit and owner in bounded repeated data', () => {
  const records = Array.from({ length: 600 }, (_, index) => ({ elementId: `E${index}`, resultKey: `case:${index % 2 ? 'L' : 'D'}`,
    check: 'beam-flexure', clause: 'declared code clause', status: index === 599 ? 'fail' : 'input_required',
    message: 'Retain the complete saved check and do not invent reinforcement.',
    ...(index === 599 ? { utilization: 1.25 } : {}), optional: null }));
  const feedback = { success: true, completionStatus: 'incomplete', complianceStatus: 'fail', conclusionEligible: false,
    summary: { total: 600, failed: 1, inputRequired: 599, controllingElement: 'E599' },
    checkedItems: { items: records, totalCount: 600, truncated: false },
    missingInputs: records.slice(0, 599).map(row => ({ elementId: row.elementId, field: 'member.design.reinforcement.values.As',
      unit: 'mm2', source: 'user', label: 'Installed reinforcement', writable: true,
      writeTarget: { collection: 'elements', id: row.elementId, path: 'design.reinforcement.values.As', modelUnit: 'mm2', inputUnit: 'mm2', inputToModelScale: 1 } })),
    inputRequiredChecks: records.slice(0, 599), writeTargets: [{ externalField: 'retain unknown data' }],
    designValues: records.map(row => ({ elementId: row.elementId, field: 'f', value: 16.7, unit: 'MPa', source: 'declared code table' })) };
  const before = structuredClone(feedback), compact = compactCodeCheckFeedback(feedback);
  expect(expand(contextTable(records))).toEqual(records);
  expect(compact.checkedItems.items).toEqual([records[599]]);
  expect(compact.checkedItems.previewOnly).toBe(true);
  expect(compact.missingInputs).toEqual([expect.objectContaining({ field: 'member.design.reinforcement.values.As', unit: 'mm2', source: 'user',
    affectedElementCount: 599, rowCount: 599, writeTarget: expect.objectContaining({ path: 'design.reinforcement.values.As', inputToModelScale: 1 }) })]);
  expect(compact.inputRequiredChecks.totalCount).toBe(599);
  expect(compact.writeTargets).toEqual({ totalCount: 1, detailsStored: true });
  expect(compact.summary).toEqual(feedback.summary);
  expect(compact.complianceStatus).toBe('fail');
  expect(compact.conclusionEligible).toBe(false);
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(feedback).length * .45);
  expect(JSON.stringify(compact).length).toBeLessThan(32000);
  expect(feedback).toEqual(before);
});
