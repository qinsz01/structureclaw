import fs from 'node:fs';
import { expect, test } from '@jest/globals';
import { handler } from '../dist/agent-skills/structure-type/beam/handler.js';
import { ingestDraft } from '../dist/agent-runtime/draft/boundary.js';
import { sectionMaterialNotes } from '../dist/agent-runtime/draft/materials.js';
import { computeDraftMissing } from '../dist/agent-runtime/draft-readiness.js';

const saved = JSON.parse(fs.readFileSync(new URL('./fixtures/material-merge-session.json', import.meta.url), 'utf8'));
const merge = (state, patch) => handler.mergeState(state, handler.extractDraft({ message: saved.answers[1], locale: 'zh',
  currentState: state, llmDraftPatch: patch }));

test.each(saved.extractions.slice(2, -1).map(row => [row.messageId, row.nextState]))('record draft from saved session %s retains a legacy grade', (_id, state) => {
  const before = structuredClone(state);
  const next = merge(state, { engineeringDraft: { material: { family: 'steel', grade: 'Q235' } } });
  expect(next.engineeringDraft.material).toMatchObject({ grade: 'Q235', family: 'steel' });
  expect(next.engineeringDraft.materials).toEqual([{ id: 'M1', grade: 'Q235', family: 'steel' }]);
  expect(next.engineeringDraft.templateAssignments.beam.materialId).toBe('M1');
  expect(next.engineeringDraft.sectionRecords[0]).not.toHaveProperty('materials');
  expect(computeDraftMissing({ id: 'beam', handler }, next, 'execution').critical).toEqual([]);
  expect(state).toEqual(before);
});

test('a section confirmation gate retains the material and root-level assignments from the same answer', () => {
  const state = saved.extractions[0].nextState;
  const pending = { id: 'S1', name: 'I20a', shape: { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 },
    extra: { provenance: { shape: 'llm-table' }, source: 'LLM: assistant-recalled table value, please verify' }, materials: [] };
  const next = merge(state, { engineeringDraft: { material: { grade: 'Q235' }, sectionRecords: [pending] },
    templateAssignments: { beam: { sectionId: 'S1' } } });
  expect(next.engineeringDraft.materials[0]).toMatchObject({ id: 'M1', grade: 'Q235' });
  expect(next.engineeringDraft.templateAssignments.beam).toEqual({ materialId: 'M1', sectionId: 'S1' });
  expect(computeDraftMissing({ id: 'beam', handler }, next, 'execution').critical).toContain('sectionConfirmation');
  expect(() => handler.buildModel(next)).toThrow('SECTION_CONFIRMATION_REQUIRED');
  expect(sectionMaterialNotes({ sectionRecords: [pending] })).toMatchObject([{ reason: 'MISPLACED_SECTION_MATERIALS' }]);
  const confirmed = merge(next, { engineeringDraft: { sectionRecords: [{ id: 'S1', extra: { provenance: { shape: 'user' } } }] } });
  expect(computeDraftMissing({ id: 'beam', handler }, confirmed, 'execution').critical).toEqual([]);
  expect(confirmed.engineeringDraft.materials[0].grade).toBe('Q235');
});

test('one material record updates the legacy view without replacing IDs, properties or role assignments', () => {
  const state = merge(saved.extractions[0].nextState, { engineeringDraft: { material: { grade: 'Q235' }, sections: { beam: '100X200' } } });
  const next = merge(state, { engineeringDraft: { materials: [{ id: 'CUSTOM', grade: 'Q355', family: 'steel', E: 200000 }],
    templateAssignments: { beam: { materialId: 'CUSTOM' } } } });
  expect(next.engineeringDraft.material).toMatchObject({ grade: 'Q355', family: 'steel' });
  const changed = merge(next, { material: { grade: 'Q235' } });
  expect(changed.engineeringDraft.materials).toEqual([{ id: 'CUSTOM', grade: 'Q235', family: 'steel', E: 200000 }]);
  expect(changed.engineeringDraft.templateAssignments.beam.materialId).toBe('CUSTOM');
});

test('an unscoped grade never overwrites multiple assigned materials', () => {
  const state = { inferredType: 'frame', engineeringDraft: { materials: [{ id: 'A', grade: 'Q235' }, { id: 'B', grade: 'Q355' }],
    templateAssignments: { beam: { materialId: 'A' }, column: { materialId: 'B' } } } };
  const patch = ingestDraft({ engineeringDraft: { material: { grade: 'Q345' } } }, state);
  expect(patch.engineeringDraft.materials).toEqual(state.engineeringDraft.materials);
  expect(patch.engineeringDraft.material.grade).toBe('Q345');
});

