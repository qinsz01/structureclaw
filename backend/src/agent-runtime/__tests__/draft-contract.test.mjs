import { expect, test } from '@jest/globals';
import { modelContract, draftContract, promptContract } from '../../../dist/engineering/draft-contract.js';
import { mergeDraftState } from '../../../dist/agent-runtime/fallback.js';
import { currentDraftDiagnostics } from '../../../dist/agent-runtime/draft-diagnostics.js';
import { createLocalStructureProtocolClient } from '../../../dist/services/structure-protocol-execution.js';
import { engineeringModelSchema } from '../../../dist/engineering/model-edit-contract.js';
import { normalizeEngineeringModel } from '../../../dist/engineering/model-boundary.js';
import { getStructureModelTemplate } from '../../../dist/agent-skills/structure-type/generic/llm-model-prompt-fragments.js';

const missing = field => ({ field, kind: 'missing', severity: 'ambiguous', reason: 'Not supplied' });
const state = (draft, issues) => ({ inferredType: 'beam', engineeringDraft: draft, draftIssues: issues, updatedAt: 0 });

test('the shipped contract equals the Python model, including all design and control fields', async () => {
  expect(modelContract).toEqual(await engineeringModelSchema(createLocalStructureProtocolClient()));
  expect(draftContract.properties.materials).toEqual(modelContract.properties.materials);
  expect(draftContract.properties.analysisControl).toEqual(modelContract.properties.analysis_control);
  expect(promptContract().$defs.MemberDesign.properties).toHaveProperty('reinforcement');
  expect(promptContract().$defs.AnalysisControl.properties.self_weight).not.toHaveProperty('default');
  expect(promptContract().$defs.LoadCaseV2.properties.loads.items.properties.fz).toMatchObject({ type: 'number', 'x-unit': 'kN' });
  expect(draftContract.properties.coordinateSystem).toEqual(modelContract.properties.coordinate_system);
});

test('a legal empty load-case default remains an empty collection after Python serialization', async () => {
  const model = JSON.parse(getStructureModelTemplate());
  model.load_cases = [{ id: 'empty', type: 'other' }]; model.load_combinations = [];
  const result = await normalizeEngineeringModel(model, createLocalStructureProtocolClient());
  expect(result.load_cases[0].loads).toEqual([]);
  expect(model.load_cases[0].loads).toBeUndefined();
});

test('a saved missing diagnostic is recomputed from current valid data, without another user turn', () => {
  const before = state({ materials: [{ id: 'M', E: 206000, design: { f: 215 } }], analysisControl: { self_weight: false } },
    [missing('materials[0].E'), missing('materials[0].design.f'), missing('analysisControl.self_weight')]);
  const snapshot = structuredClone(before);
  expect(currentDraftDiagnostics(before).draftIssues).toBeUndefined();
  expect(before).toEqual(snapshot);
});

test('confirmation uses a fresh explicit field answer; unrelated writes do not approve it', () => {
  const before = state({ analysisControl: { self_weight: true } },
    [{ field: 'analysisControl.self_weight', kind: 'confirmation', severity: 'ambiguous', value: true, reason: 'Confirm self weight' }]);
  expect(currentDraftDiagnostics(before).draftIssues).toHaveLength(1);
  expect(mergeDraftState(before, { engineeringDraft: { geometry: { lengthM: 6 } } }).draftIssues).toHaveLength(1);
  expect(mergeDraftState(before, { engineeringDraft: { analysisControl: { self_weight: false } } }).draftIssues).toBeUndefined();
});

test('a bound diagnostic follows the original material through reordering, including IDs with dots', () => {
  const initial = mergeDraftState(undefined, { engineeringDraft: { materials: [{ id: 'M.a' }, { id: 'B' }] }, draftIssues: [missing('materials[0].G')] });
  expect(initial.draftIssues[0].target).toBe('materials["M.a"].G');
  const reordered = { ...initial, engineeringDraft: { materials: [{ id: 'B', G: 100 }, { id: 'M.a' }] } };
  expect(currentDraftDiagnostics(reordered).draftIssues).toHaveLength(1);
  expect(mergeDraftState(reordered, { engineeringDraft: { materials: [{ id: 'M.a', G: 79000 }] } }).draftIssues).toBeUndefined();
});

test.each([
  ['analysisControl.modal_count', { analysisControl: { modal_count: 7 } }],
  ['analysisControl.mass_directions', { analysisControl: { mass_directions: ['x', 'z'] } }],
  ['analysisControl.mass_source', { analysisControl: { mass_source: 'nodal' } }],
  ['templateAssignments.beam.design.serviceability_result_keys', { templateAssignments: { beam: { design: { serviceability_result_keys: ['case:S'] } } } }],
  ['templateAssignments.beam.design.reinforcement', { templateAssignments: { beam: { design: { reinforcement: { values: { As: 1000 } } } } } }],
])('schema-driven resolution supports %s without a field-specific clearing branch', (field, draft) => {
  const before = state({}, [missing(field)]);
  expect(mergeDraftState(before, { engineeringDraft: draft }).draftIssues).toBeUndefined();
});

test.each([0, -1, 1.5, '7', NaN, null])('invalid modal count %j cannot clear its diagnostic', value => {
  const after = mergeDraftState(state({}, [missing('analysisControl.modal_count')]), { engineeringDraft: { analysisControl: { modal_count: value } } });
  expect(after.draftIssues).toHaveLength(1);
});

test('source conflicts cannot be erased by a value, a missing marker or a correct schema type', () => {
  const conflict = { field: 'analysisControl.self_weight', severity: 'conflict', reason: 'Drawing and table disagree' };
  const after = mergeDraftState(state({}, [conflict]), { engineeringDraft: { analysisControl: { self_weight: false } }, draftIssues: [missing(conflict.field)] });
  expect(after.draftIssues).toContainEqual(conflict);
});
