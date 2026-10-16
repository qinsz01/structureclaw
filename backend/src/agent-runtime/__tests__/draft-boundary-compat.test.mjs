// Compatibility guard for the single-draft boundary (blueprint step 10).
// Old persisted DraftState samples — real characterization checkpoints, the reported 2026-10-15
// fixtures and legacy flat-field drafts — are resumed with a next-turn patch. The goldens were
// captured from the pre-refactor runtime; every replay must stay byte-identical.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { withDeclaredProperties } from '../../../tests/fixtures/declared-template-properties.mjs';
import { normalizeLegacyDraftPatch } from '../../../dist/agent-runtime/legacy.js';
import { buildParamExtractorPrompt } from '../../../dist/agent-langgraph/param-extractor.js';

const fixture = JSON.parse(readFileSync(new URL('../../../tests/fixtures/draft-boundary-compat-20261017.json', import.meta.url), 'utf8'));
const handlers = {};
// Sequential: jest's VM module linker cannot evaluate overlapping dynamic imports of shared modules.
for (const id of new Set(fixture.scenarios.map(item => item.skillId))) {
  handlers[id] = (await import(`../../../dist/agent-skills/structure-type/${id}/handler.js`)).handler;
}
const FLAT_FIELDS = ['lengthM', 'spanLengthM', 'heightM', 'supportType', 'frameDimension', 'storyCount', 'bayCount', 'bayCountX', 'bayCountY',
  'storyHeightsM', 'bayWidthsM', 'bayWidthsXM', 'bayWidthsYM', 'floorLoads', 'frameBaseSupportType', 'loadKN', 'loadType', 'loadPosition', 'loadPositionM'];

const strip = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'updatedAt' ? 0 : item));
const attempt = action => { try { return { value: strip(action()) }; } catch (error) { return { error: String(error?.message ?? error) }; } };
const match = skillId => ({ key: skillId, mappedType: skillId === 'concrete-frame' ? 'frame' : skillId, skillId, supportLevel: 'supported', routingSource: 'current-state' });
const resume = ({ skillId, state, raw }) => {
  const handler = handlers[skillId];
  const persisted = structuredClone(state);
  return handler.mergeState(persisted, handler.extractDraft({ message: '', locale: 'zh', currentState: persisted, llmDraftPatch: structuredClone(raw), structuralTypeMatch: match(skillId) }));
};
const pick = (value, keys) => JSON.stringify(Object.fromEntries(keys.map(key => [key, value?.[key]])));

describe('old persisted draft states', () => {
  test.each(fixture.scenarios.map(item => [item.id, item]))('%s: ingesting the stored state keeps every flat field', (_id, scenario) => {
    const ingested = attempt(() => normalizeLegacyDraftPatch(structuredClone(scenario.state)));
    expect(ingested).toEqual(scenario.expected.ingest);
    expect(pick(ingested.value, FLAT_FIELDS)).toBe(pick(scenario.state, FLAT_FIELDS));
    // Normalization only drops an empty topology container; every engineering value round-trips.
    const stored = structuredClone(scenario.state.engineeringDraft);
    if (stored?.topology && !Object.keys(stored.topology).length) delete stored.topology;
    expect(ingested.value.engineeringDraft).toEqual(stored);
  });

  test.each(fixture.scenarios.map(item => [item.id, item]))('%s: the next turn behaves exactly as before', (_id, scenario) => {
    const handler = handlers[scenario.skillId];
    const original = structuredClone(scenario.state);
    const next = attempt(() => resume(scenario));
    expect(next.error ? next : { json: JSON.stringify(next.value) }).toEqual(scenario.expected.next);
    expect(scenario.state).toEqual(original);
    if (!next.value) return;
    expect(attempt(() => handler.computeMissing(next.value, 'execution'))).toEqual(scenario.expected.missingExecution);
    expect(attempt(() => handler.computeMissing(next.value, 'interactive'))).toEqual(scenario.expected.missingInteractive);
    expect(attempt(() => {
      const missing = handler.computeMissing(next.value, 'interactive');
      return handler.buildQuestions([...missing.critical, ...missing.optional], missing.critical, next.value, 'en');
    })).toEqual(scenario.expected.questions);
    expect(attempt(() => handler.buildModel(withDeclaredProperties(next.value)) ?? null)).toEqual(scenario.expected.model);
  });

  test('the legacy skillState.engineeringDraft mirror always equals the canonical draft it shadows', () => {
    let mirrored = 0;
    for (const scenario of fixture.scenarios) {
      const next = JSON.parse(scenario.expected.next.json);
      if (!next.skillState?.engineeringDraft) continue;
      mirrored += 1;
      expect([scenario.id, next.skillState.engineeringDraft]).toEqual([scenario.id, next.engineeringDraft]);
    }
    expect(mirrored).toBeGreaterThan(10);
    // An out-of-date stored mirror is never read back; the next turn refreshes it from the canonical draft.
    const stale = fixture.scenarios.find(item => item.id === 'fixture-catalog-stale-mirror');
    expect(stale.state.skillState.engineeringDraft.geometry).toEqual({ lengthM: 9 });
    expect(JSON.parse(stale.expected.next.json).skillState.engineeringDraft.geometry).toEqual({ lengthM: 10 });
  });
});

// 275245e (2026-10-15) changed only extractor prompts; its draft-level contract had no test.
describe('explicit empty load combinations (275245e)', () => {
  test('an explicit [] withdraws earlier combinations while omission keeps them', () => {
    const { handler } = { handler: handlers.beam };
    const base = handler.mergeState(undefined, handler.extractDraft({ locale: 'en', llmDraftPatch: { engineeringDraft: {
      structureType: 'beam', geometry: { lengthM: 6 }, boundary: { supportType: 'simply-supported' },
      loads: [{ id: 'D', kind: 'line', magnitude: 2, unit: 'kN/m', direction: 'gravity', caseId: 'LC1', caseType: 'dead' }],
      analysis: { loadCombinations: [{ id: 'C1', factors: { LC1: 1.3 } }] } } } }));
    expect(base.engineeringDraft.analysis.loadCombinations).toEqual([{ id: 'C1', factors: { LC1: 1.3 } }]);
    const kept = handler.mergeState(base, handler.extractDraft({ locale: 'en', currentState: base, llmDraftPatch: { engineeringDraft: { geometry: { lengthM: 7 } } } }));
    expect(kept.engineeringDraft.analysis.loadCombinations).toEqual([{ id: 'C1', factors: { LC1: 1.3 } }]);
    const cleared = handler.mergeState(base, handler.extractDraft({ locale: 'en', currentState: base, llmDraftPatch: { engineeringDraft: { analysis: { loadCombinations: [] } } } }));
    expect(cleared.engineeringDraft.analysis.loadCombinations).toEqual([]);
    expect(cleared.engineeringDraft.loads).toEqual(base.engineeringDraft.loads);
  });

  test.each([
    ['en', 'Analyzing a single case at factor 1 does not create a combination'],
    ['zh', '只分析某工况、系数1不代表新增组合'],
  ])('the extractor prompt states the single-case rule (%s)', (locale, text) => {
    const plugin = { id: 'beam', name: { zh: '梁', en: 'Beam' }, description: { zh: '梁', en: 'Beam' }, stages: ['draft'], structureType: 'beam', markdownByStage: {} };
    expect(buildParamExtractorPrompt(locale, undefined, plugin, '6 m beam, dead load case only')).toContain(text);
  });
});
