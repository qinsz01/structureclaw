import { expect, test } from '@jest/globals';
import { AgentSkillRuntime } from '../../../dist/agent-runtime/index.js';
import { computeDraftMissing } from '../../../dist/agent-runtime/draft-readiness.js';
import { handler } from '../../../dist/agent-skills/structure-type/beam/handler.js';

const field = 'sectionRecords[0].properties.A/Iy/Iz/Wx/Wz/tw/imin';
function draft() {
  return { inferredType: 'beam', skillId: 'beam', lengthM: 10, supportType: 'simply-supported',
    loadKN: 1, loadType: 'point', loadPosition: 'midspan',
    engineeringDraft: { materials: [{ id: 'MAT', name: 'User steel', E: 206000, nu: .3, rho: 7850 }],
      sectionRecords: [{ id: 'SEC', name: 'I20a (GB/T 706)', type: 'custom', properties: { S: .000104, Wnx: .000237, b: .0465, t: .0114 } }],
      sections: { beam: 'I20a' }, templateAssignments: { beam: { materialId: 'MAT', sectionId: 'SEC' } },
      analysisControl: { self_weight: false } },
    draftIssues: [{ field, value: null, severity: 'ambiguous', reason: 'Named catalog properties are not yet attached.' }] };
}
const missing = state => computeDraftMissing({ id: 'beam', handler }, state, 'execution').critical;

test.each([field, 'sectionRecords.SEC.properties', 'engineeringDraft.sectionRecords[0].properties'])('a reviewed catalog resolves missing properties at %s', async diagnosticField => {
  const state = draft(); state.draftIssues[0].field = diagnosticField;
  const before = structuredClone(state);
  expect(missing(state)).toEqual([]);
  const model = await new AgentSkillRuntime().buildModel(state, ['beam']);
  expect(model.sections[0].properties).toMatchObject({ A: .003555, Iy: .0000237, Iz: .00000158, S: .000104 });
  expect(model.sections[0].extra.catalogSource.recordId).toBe('I20a');
  expect(state).toEqual(before);
});

test.each(['conflict', 'invalid', 'unrealistic'])('catalog lookup does not dismiss an explicit %s issue', severity => {
  const state = draft(); state.draftIssues[0].severity = severity;
  expect(missing(state)).toContain(field);
});

test.each(['unknown-catalog', 'explicit-custom-property', 'nonempty-issue-value', 'unknown-property', 'missing-record'])('unresolved section issue remains blocking: %s', variant => {
  const state = draft();
  if (variant === 'unknown-catalog') { state.engineeringDraft.sectionRecords[0].name = 'Custom'; state.engineeringDraft.sections.beam = 'Custom'; }
  if (variant === 'explicit-custom-property') state.engineeringDraft.sectionRecords[0].properties.A = .01;
  if (variant === 'nonempty-issue-value') state.draftIssues[0].value = 'conflicting sources';
  if (variant === 'unknown-property') state.draftIssues[0].field = 'sectionRecords[0].properties.gammaX';
  if (variant === 'missing-record') state.draftIssues[0].field = 'sectionRecords[5].properties.A';
  expect(missing(state)).toContain(state.draftIssues[0].field);
});
