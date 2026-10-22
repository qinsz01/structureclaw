import { describe, expect, test } from '@jest/globals';
import { genericFixtures } from './characterization/fixtures/generic-physics.mjs';
import { ingestGenericDraft, mergeGenericDraftState } from '../dist/agent-runtime/draft/boundary.js';
import { currentDraftDiagnostics } from '../dist/agent-runtime/draft-diagnostics.js';
import { draftSectionConfirmations } from '../dist/agent-runtime/draft-readiness.js';
import { genericMissing } from '../dist/agent-runtime/generic-readiness.js';

const field = 'sectionRecords["AX"].shape';
function initial() {
  const state = structuredClone(genericFixtures[5].draft);
  state.engineeringDraft.topology.members.find(member => member.id === 'AD').section = 'AX';
  state.engineeringDraft.sectionRecords.push({ id: 'AX', type: 'custom', name: 'Axial brace section' });
  state.draftIssues = [{ field, kind: 'missing', severity: 'invalid', reason: 'Provide brace section dimensions or area.' }];
  state.skillState = { invalidDraftFields: [field] };
  return state;
}
function withArea(state = initial()) {
  const patch = ingestGenericDraft({ engineeringDraft: { sectionRecords: [
    { id: 'AX', properties: { A: .002 }, extra: { provenance: { properties: 'user' } } },
  ] } }, state);
  return mergeGenericDraftState(state, patch);
}
const issues = state => (state.draftIssues ?? []).map(issue => issue.field);
const section = state => state.engineeringDraft.sectionRecords.find(section => section.id === 'AX');

describe('area-only axial clarification', () => {
  test('a supplied axial area resolves the stale missing-shape issue without inventing geometry', () => {
    const before = initial(), snapshot = structuredClone(before);
    expect(genericMissing(before)).toContain(field);
    const after = withArea(before);
    expect(issues(after)).toEqual([]);
    expect(after.skillState.invalidDraftFields ?? []).toEqual([]);
    expect(genericMissing(after)).toEqual([]);
    expect(draftSectionConfirmations(after)).toEqual([]);
    expect(section(after).properties).toEqual({ A: .002 });
    expect(section(after).shape).toBeUndefined();
    expect(after.engineeringDraft.topology).toEqual(before.engineeringDraft.topology);
    expect(after.engineeringDraft.loadCases).toEqual(before.engineeringDraft.loadCases);
    expect(before).toEqual(snapshot);
  });
  test.each(['sectionRecords.AX.shape', 'engineeringDraft.sectionRecords["AX"].dimensions', 'sectionRecords[1].shape'])
  ('stable IDs and indices resolve the same axial-only absence: %s', path => {
    const state = initial(); state.draftIssues[0].field = path; state.skillState.invalidDraftFields = [path];
    expect(issues(withArea(state))).toEqual([]);
  });
  test.each(['bending consumer', 'unassigned section', 'unconfirmed area', 'design request', 'explicit conflict', 'beam template assignment'])
  ('an area never erases a different requirement: %s', kind => {
    const state = initial();
    section(state).properties = { A: .002 }; section(state).extra = { provenance: { properties: 'user' } };
    const member = state.engineeringDraft.topology.members.find(member => member.id === 'AD');
    if (kind === 'bending consumer') state.engineeringDraft.topology.members[0].section = 'AX';
    if (kind === 'unassigned section') member.section = 'R';
    if (kind === 'unconfirmed area') section(state).extra.provenance.properties = 'llm-table';
    if (kind === 'design request') state.requestScope.design = true;
    if (kind === 'explicit conflict') state.draftIssues[0].severity = 'conflict';
    if (kind === 'beam template assignment') state.engineeringDraft.templateAssignments = { beam: { sectionId: 'AX' } };
    expect(issues(currentDraftDiagnostics(state))).toContain(field);
  });
  test.each([0, -1, NaN, Infinity])('an invalid area remains missing: %s', A => {
    const state = initial(); section(state).properties = { A }; section(state).extra = { provenance: { properties: 'user' } };
    expect(issues(currentDraftDiagnostics(state))).toContain(field);
  });
  test('resolving the area retains an independent load conflict', () => {
    const state = initial();
    const conflict = { field: 'loadCases["LC1"].loads', severity: 'conflict', reason: 'The load direction conflicts.' };
    state.draftIssues.push(conflict);
    expect(withArea(state).draftIssues).toEqual([conflict]);
  });
});
