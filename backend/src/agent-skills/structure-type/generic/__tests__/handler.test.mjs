import { describe, expect, test } from '@jest/globals';
import { handler } from '../../../../../dist/agent-skills/structure-type/generic/handler.js';
import { genericFixtures } from '../../../../../tests/characterization/fixtures/generic-physics.mjs';

const extract = (llmDraftPatch, message = 'User topology and every load must survive.') => handler.extractDraft({ llmDraftPatch, message, locale: 'en' });
describe('free-form generic draft boundary', () => {
  test.each(['帮我看看这个', 'Please take a look at this'])('is a routing fallback without text matching: %s', message => {
    expect(handler.detectStructuralType({ message, locale: 'en' })).toMatchObject({ skillId: 'generic', supportLevel: 'fallback' });
  });
  test('keeps canonical geometry, all loads and original text without scalar or frame projection', () => {
    const draft = structuredClone(genericFixtures[0].draft);
    const patch = extract({ ...draft, lengthM: 999, loadKN: 999, pointLoads: [{ value: 1 }, { value: 2 }] });
    expect(patch.engineeringDraft.loadCases[0].loads).toHaveLength(6);
    expect(patch.lengthM).toBeUndefined(); expect(patch.loadKN).toBeUndefined();
    const state = handler.mergeState(undefined, patch);
    expect(state.structuralTypeKey).toBe('unknown');
    expect(state.floorLoads).toBeUndefined(); expect(state.bayWidthsM).toBeUndefined();
    expect(state.engineeringDraft.topology).toEqual(draft.engineeringDraft.topology);
    expect(state.skillState.userText).toContain('every load');
    expect(state.skillState.genericDraft.pointLoads).toHaveLength(2);
    expect(handler.computeMissing(state, 'execution').critical).toEqual([]);
  });
  test('merges every canonical load and retains workflow context across user answers', () => {
    const initial = extract({ engineeringDraft: { loads: [{ id: 'P1', kind: 'point', unit: 'kN', magnitude: 5, direction: 'gravity', target: 'A' }] }, skillState: { seismicWorkflow: { directions: ['x', 'y'] } } });
    const next = extract({ engineeringDraft: { loads: [{ id: 'P2', kind: 'nodal', unit: 'kN', magnitude: 10, direction: 'globalX', target: 'B' }] } });
    const state = handler.mergeState(handler.mergeState(undefined, initial), next);
    expect(state.engineeringDraft.loads.map(load => load.id)).toEqual(['P1', 'P2']);
    expect(state.skillState.seismicWorkflow.directions).toEqual(['x', 'y']);
    expect(state.loadKN).toBeUndefined();
  });
  test('does not require a template type; asks once for the absent physical groups in both locales', () => {
    const state = handler.mergeState(undefined, extract({}));
    const missing = handler.computeMissing(state, 'execution').critical;
    expect(missing).toEqual(['geometry', 'supports', 'loads', 'properties']);
    expect(missing).not.toContain('inferredType');
    for (const locale of ['en', 'zh']) {
      const questions = handler.buildQuestions(missing, missing, state, locale);
      expect(questions).toHaveLength(4);
      expect(questions.every(question => question.required && question.question !== question.paramKey)).toBe(true);
    }
  });
  test('retains a genuine load ambiguity alongside all other missing physics', () => {
    const state = handler.mergeState(undefined, extract({ draftIssues: [{ field: 'loads', severity: 'ambiguous', reason: 'Unknown direction', question: 'Which physical direction?' }] }));
    expect(handler.buildQuestions(['loads'], ['loads'], state, 'en')[0].question).toBe('Which physical direction?');
  });
  test('never extracts numbers or support defaults by scanning the user text', () => {
    const patch = extract({}, '2 storeys, 3m high, 6m spans, 20kN/m; fixed base.');
    expect(patch.engineeringDraft).toBeUndefined();
    expect(patch.heightM).toBeUndefined(); expect(patch.supportType).toBeUndefined();
  });
});
