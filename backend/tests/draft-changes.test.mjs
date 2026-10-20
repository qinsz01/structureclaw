import fs from 'node:fs';
import { expect, test } from '@jest/globals';
import { handler } from '../dist/agent-skills/structure-type/beam/handler.js';
import { ingestDraft } from '../dist/agent-runtime/draft/boundary.js';
import { draftChangedFields, unappliedDraftFields } from '../dist/agent-runtime/draft/changes.js';
const saved = JSON.parse(fs.readFileSync(new URL('./fixtures/material-merge-session.json', import.meta.url), 'utf8'));

test('applied paths ignore clocks, empty normalization objects and the legacy mirror; readback reports dropped values', () => {
  const state = saved.extractions[5].nextState;
  expect(draftChangedFields(state, { ...state, updatedAt: state.updatedAt + 1, engineeringDraft: { ...state.engineeringDraft, wind: {} } })).toEqual([]);
  const patch = ingestDraft({ engineeringDraft: { material: { grade: 'Q235' } } }, state);
  const next = handler.mergeState(state, patch);
  expect(draftChangedFields(state, next)).toContain('engineeringDraft.materials["M1"].grade');
  expect(unappliedDraftFields(patch, next)).toEqual([]);
  expect(unappliedDraftFields(patch, state)).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'engineeringDraft.materials["M1"].grade', reason: 'NOT_RETAINED' }),
  ]));
});
