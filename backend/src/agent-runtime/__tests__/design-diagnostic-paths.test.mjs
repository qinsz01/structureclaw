import { expect, test } from '@jest/globals';
import { isDesignDraftField } from '../../../dist/agent-runtime/draft-guidance.js';
import { computeDraftMissing } from '../../../dist/agent-runtime/draft-readiness.js';
import { handler } from '../../../dist/agent-skills/structure-type/beam/handler.js';

const designPaths = ['materials[0].design.f', 'materials[MAT-Q235B].design.fv', 'materials["M"].design.f',
  'materials.M.design.f', 'materials[].design.fy', 'elements[0].design.l0', 'elements.B1.design.deflectionLimitN',
  'templateAssignments.beam.design.deflectionLimitN', 'templateAssignments.column.design',
  'templateAssignments.member.design.phi_b', 'material.design.f', 'member.design.l0', 'model.materials[0].design.f'];

test.each(designPaths)('canonical design diagnostic %s cannot block an elastic analysis', field => {
  for (const prefix of ['', 'engineeringDraft.']) expect(isDesignDraftField(prefix+field)).toBe(true);
});

test.each(['materials[0].E', 'materials.M.G', 'sectionRecords[0].properties.Iy', 'templateAssignments.beam.sectionId',
  'elements[0].releases', 'analysisControl.self_weight', 'loads[0].magnitude', 'inputEvidence[0].design'])('physical or unresolved input %s remains mandatory', field => {
  expect(isDesignDraftField(field)).toBe(false);
});

test.each([true, false])('reported design-only missing fields remain visible without blocking solver construction, design=%s', design => {
  const issues = ['materials[0].design.fy', 'templateAssignments.beam.design.deflectionLimitN'];
  const state = handler.mergeState(undefined, handler.extractDraft({ locale: 'zh', llmDraftPatch: {
    engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 }, material: { grade: 'Q235B' },
      sections: { beam: 'HW300X300X10X15' }, boundary: { supportType: 'simply-supported' },
      loads: [{ kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', location: { xM: 5 } }],
      analysisControl: { self_weight: false } },
    draftIssues: issues.map(field => ({ field, severity: 'ambiguous', value: null, reason: 'Design conditions not supplied' })),
  } }));
  state.requestScope = { responses: ['forces'], method: 'solver', design, report: false, outputs: [] };
  const missing = computeDraftMissing({ id: 'beam', handler }, state, 'execution');
  expect(missing.critical).toEqual([]);
  expect(missing.optional).toEqual(expect.arrayContaining(issues));
  expect(handler.buildModel(state).sections[0].shape.kind).toBe('H');
});
