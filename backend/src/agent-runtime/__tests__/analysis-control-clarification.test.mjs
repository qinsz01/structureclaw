import { expect, test } from '@jest/globals';
import { handler } from '../../../dist/agent-skills/structure-type/beam/handler.js';
import { computeDraftMissing } from '../../../dist/agent-runtime/draft-readiness.js';
import { createLocalStructureProtocolClient } from '../../../dist/services/structure-protocol-execution.js';
import { normalizeEngineeringModel } from '../../../dist/engineering/model-boundary.js';
import { engineeringModelSchema } from '../../../dist/engineering/model-edit-contract.js';

const plugin = { id: 'beam', handler };
const source = { structureType: 'beam', geometry: { lengthM: 10 }, material: { grade: 'Q235B' },
  sections: { beam: 'HW300X300X10X15' }, boundary: { supportType: 'simply-supported' },
  loads: [{ kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', location: { xM: 5 } }] };
const issue = field => ({ field, value: null, severity: 'ambiguous', reason: 'Not yet confirmed' });
const state = issues => handler.mergeState(undefined, handler.extractDraft({ locale: 'zh',
  llmDraftPatch: { engineeringDraft: source, draftIssues: issues } }));
const amend = (before, control) => handler.mergeState(before, handler.extractDraft({ locale: 'zh', currentState: before,
  llmDraftPatch: { engineeringDraft: { analysisControl: control } } }));

test.each(['analysisControl', 'engineeringDraft.analysisControl'])('the actual no-self-weight answer resolves %s.self_weight, builds, and keeps history', async prefix => {
  const before = state([issue(`${prefix}.self_weight`)]);
  const snapshot = structuredClone(before);
  expect(computeDraftMissing(plugin, before, 'execution').critical).toContain(`${prefix}.self_weight`);
  const after = amend(before, { self_weight: false });
  expect(computeDraftMissing(plugin, after, 'execution').critical).toEqual([]);
  expect(after.draftIssues ?? []).toEqual([]);
  expect(after.skillState.invalidDraftFields ?? []).toEqual([]);
  const model = await normalizeEngineeringModel(handler.buildModel(after), createLocalStructureProtocolClient());
  expect(model.analysis_control.self_weight).toBe(false);
  expect(before).toEqual(snapshot);
});

test('all formally declared boolean controls resolve both yes and no without clearing another missing field', async () => {
  const contract = await engineeringModelSchema(createLocalStructureProtocolClient());
  const booleanFields = Object.entries(contract.$defs.AnalysisControl.properties).filter(([, schema]) =>
    schema.type === 'boolean' || schema.anyOf?.some(item => item.type === 'boolean')).map(([key]) => key);
  expect(booleanFields.length).toBeGreaterThan(1);
  for (const key of booleanFields) for (const value of [true, false]) {
    const field = `analysisControl.${key}`;
    const before = state([issue(field), issue('material.rebarGrade')]);
    const after = amend(before, { [key]: value });
    expect(after.draftIssues).toEqual([issue('material.rebarGrade')]);
    expect(after.skillState.invalidDraftFields).not.toContain(field);
    expect(after.engineeringDraft.analysisControl[key]).toBe(value);
  }
});

test.each([undefined, null, 'false', 0, 'no'])('unconfirmed or mistyped input %j cannot clear the self-weight question', value => {
  const after = amend(state([issue('analysisControl.self_weight')]), { self_weight: value });
  expect(after.draftIssues).toContainEqual(issue('analysisControl.self_weight'));
});

test.each([{ severity: 'conflict', value: null }, { severity: 'ambiguous', value: 'conflicting source' }])('an unresolved source issue %j survives a boolean patch', fields => {
  const conflict = { ...issue('analysisControl.self_weight'), ...fields };
  const after = amend(state([conflict]), { self_weight: false });
  expect(after.draftIssues).toContainEqual(conflict);
});

test('a corrected invalid boolean follows the same field-contract validation as other corrected values', () => {
  const after = amend(state([{ ...issue('analysisControl.self_weight'), severity: 'invalid' }]), { self_weight: false });
  expect(after.draftIssues ?? []).toEqual([]);
});
