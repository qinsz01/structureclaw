import { readdirSync, existsSync } from 'node:fs';
import { describe, test, expect } from '@jest/globals';
import { computeDraftMissing } from '../../../dist/agent-runtime/draft-readiness.js';
import { draftFieldValues } from '../../../dist/agent-runtime/draft-diagnostics.js';
import { validDraftValue } from '../../../dist/engineering/draft-contract.js';
import { unresolvedAppliedFields } from '../../../dist/agent-runtime/draft/changes.js';

const ids = readdirSync(new URL('../../agent-skills/structure-type/', import.meta.url), { withFileTypes: true }).filter(x => x.isDirectory() && existsSync(new URL(`../../agent-skills/structure-type/${x.name}/skill.yaml`, import.meta.url))).map(x => x.name);
const handlers = {};
for (const id of ids) handlers[id] = (await import(`../../../dist/agent-skills/structure-type/${id}/handler.js`)).handler;
const fields = {
  'geometry.lengthM': 6, 'geometry.heightM': 3, 'geometry.spanLengthsM': [6, 6],
  'geometry.storyHeightsM': [3, 3], 'geometry.bayWidthsM': [5, 5],
  'geometry.bayWidthsXM': [5, 5], 'geometry.bayWidthsYM': [5, 5],
  'boundary.supportType': 'simply-supported', 'boundary.frameBaseSupportType': 'fixed',
  'material.family': 'concrete', 'material.grade': 'C30',
  'sections.beam': '250X500', 'sections.column': '400X400', 'sections.member': '250X500',
  'loads': [{ id: 'P', kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 3 } }],
};
const nested = (path, value) => path.split('.').reverse().reduce((v, key) => ({ [key]: v }), value);
for (const id of ids) {
  describe(`${id}: canonical field answers`, () => {
    const handler = handlers[id];
    for (const [field, value] of Object.entries(fields)) test(field, () => {
      const inferredType = ['concrete-frame', 'generic'].includes(id) ? 'frame' : id;
      const before = { inferredType, skillId: id, updatedAt: 0, requestScope: { responses: ['forces'], design: false, report: false, outputs: [] },
        draftIssues: [{ field, kind: 'confirmation', severity: 'ambiguous', reason: 'Confirm this input' }],
        skillState: { invalidDraftFields: [field] } };
      const draft = nested(field, value);
      expect(draftFieldValues(draft, field).every(item => validDraftValue(item.schema, item.value))).toBe(true);
      expect(computeDraftMissing({ id, handler }, before, 'execution').critical).toContain(field);
      const patch = handler.extractDraft({ message: '', locale: 'en', currentState: before,
        structuralTypeMatch: { key: id, mappedType: inferredType, skillId: id },
        llmDraftPatch: { inferredType, engineeringDraft: draft } });
      const after = handler.mergeState(before, patch);
      expect(computeDraftMissing({ id, handler }, after, 'execution').critical).not.toContain(field);
    });
  });
}

test('a valid applied field cannot remain critical; unrelated and invalid values are not contract faults', () => {
  const patch = { engineeringDraft: { geometry: { lengthM: 6 } } };
  expect(unresolvedAppliedFields(patch, patch, ['geometry.lengthM'])).toEqual([{ requiredPath: 'geometry.lengthM', appliedPaths: ['engineeringDraft.geometry.lengthM'] }]);
  expect(unresolvedAppliedFields(patch, patch, ['geometry.heightM'])).toEqual([]);
  const invalid = { engineeringDraft: { geometry: { lengthM: -1 } } };
  expect(unresolvedAppliedFields(invalid, invalid, ['geometry.lengthM'])).toEqual([]);
});

// Enumerate critical keys from both readiness phases and 2D/3D branches; no hardcoded list of missing keys.
for (const id of ids) for (const dimension of ['2d', '3d']) test(`${id} ${dimension}: every initial critical field has an extractor path`, () => {
  const handler = handlers[id];
  const inferredType = ['generic', 'concrete-frame'].includes(id) ? 'frame' : id;
  const before = { inferredType, skillId: id, frameDimension: dimension, updatedAt: 0,
    requestScope: { responses: ['forces'], design: false, report: false, outputs: [] } };
  const critical = [...new Set(['interactive', 'execution'].flatMap(phase => computeDraftMissing({ id, handler }, before, phase).critical))];
  const engineeringDraft = { structureType: inferredType, coordinateSystem: { dimension },
    geometry: { lengthM: 6, heightM: 3, spanLengthsM: [6, 6], storyHeightsM: [3, 3],
      ...(dimension === '2d' ? { bayWidthsM: [5, 5] } : { bayWidthsXM: [5, 5], bayWidthsYM: [5, 5] }) },
    boundary: { supportType: 'simply-supported', frameBaseSupportType: 'fixed' },
    material: { family: id === 'concrete-frame' ? 'concrete' : 'steel', grade: id === 'concrete-frame' ? 'C30' : 'Q355' },
    sections: { beam: '250X500', column: '400X400', member: '250X500' },
    loads: [{ id: 'L', kind: 'line', magnitude: 1, unit: 'kN/m', direction: 'gravity', target: 'roof', location: { xM: 3 } }] };
  const patch = handler.extractDraft({ message: '', locale: 'en', currentState: before,
    structuralTypeMatch: { key: id, mappedType: inferredType, skillId: id }, llmDraftPatch: { inferredType, engineeringDraft } });
  const after = handler.mergeState(before, patch);
  for (const phase of ['interactive', 'execution']) {
    const remaining = computeDraftMissing({ id, handler }, after, phase).critical;
    expect(remaining.filter(field => critical.includes(field))).toEqual([]);
  }
});
