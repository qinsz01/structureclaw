// Compatibility guard for the single-draft boundary (blueprint step 10).
// Old persisted DraftState samples — real characterization checkpoints, the reported 2026-10-15
// fixtures and legacy flat-field drafts — are resumed with a next-turn patch. The goldens were
// captured from the pre-refactor runtime; every replay must stay byte-identical.
// 2026-10-18 (stop before code check): fixture-hw-design-no-mirror.next no longer carries a design-field
// invalidDraftFields entry, and frame-legacy-flat.model reports the missing tw/tf instead of a catalog error.
// 2026-10-20: material representations are reconciled; the four affected expectations include the
// grade mirror or a material record/assignment. Original persisted inputs remain unchanged.
// 2026-10-22 phase 2: generic retains alias patches as context and uses canonical physics only.
// Phase 3: explicit 3D node loads no longer require redundant floor totals. The original stored
// inputs remain unchanged; an unresolved node location still blocks the same replay.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { withDeclaredProperties } from '../../../tests/fixtures/declared-template-properties.mjs';
import { ingestDraft, projectDraftState } from '../../../dist/agent-runtime/draft/boundary.js';
import { buildParamExtractorPrompt } from '../../../dist/agent-langgraph/param-extractor.js';
import { normalizeEngineeringDraft } from '../../../dist/agent-runtime/engineering-draft.js';

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

describe('optional restraints in the canonical node contract', () => {
  test.each([undefined, null])('accepts %s as an unrestrained node without mutating input', restraints => {
    const raw = { topology: { nodes: [{ id: 'C', x: 0, y: 0, z: 3, restraints }] } };
    const original = structuredClone(raw);
    expect(normalizeEngineeringDraft(raw).topology.nodes[0].restraints).toBeUndefined();
    expect(raw).toEqual(original);
  });
  test('continues to reject a malformed restraint array', () => {
    expect(() => normalizeEngineeringDraft({ topology: { nodes: [{ id: 'C', x: 0, y: 0, z: 3, restraints: [true] }] } })).toThrow('needs six boolean restraints');
  });
});

describe('old persisted draft states', () => {
  test.each(fixture.scenarios.map(item => [item.id, item]))('%s: ingesting the stored state keeps every flat field', (_id, scenario) => {
    const ingested = attempt(() => ingestDraft(structuredClone(scenario.state)));
    expect(ingested).toEqual(scenario.expected.ingest);
    expect(pick(ingested.value, FLAT_FIELDS)).toBe(pick(scenario.state, FLAT_FIELDS));
    // Original engineering values survive; normalization may add material records and the grade mirror.
    const stored = structuredClone(scenario.state.engineeringDraft);
    if (stored?.topology && !Object.keys(stored.topology).length) delete stored.topology;
    if (stored) expect(ingested.value.engineeringDraft).toMatchObject(stored);
    else expect(ingested.value.engineeringDraft).toBeUndefined();
  });

  test.each(fixture.scenarios.map(item => [item.id, item]))('%s: ingest -> project round-trips through the boundary', (_id, scenario) => {
    const ingested = attempt(() => ingestDraft(structuredClone(scenario.state)));
    expect(ingested).toEqual(scenario.expected.ingest);
    const projected = projectDraftState(ingested.value.engineeringDraft, structuredClone(scenario.state));
    expect(pick(projected, FLAT_FIELDS)).toBe(pick(scenario.state, FLAT_FIELDS));
    const { engineeringDraft: _draft, skillState, ...rest } = projected;
    const { engineeringDraft: _stored, skillState: storedSkillState, ...storedRest } = scenario.state;
    expect(rest).toEqual(storedRest);
    const { engineeringDraft: mirror, ...skillRest } = skillState ?? {};
    const { engineeringDraft: _storedMirror, ...storedSkillRest } = storedSkillState ?? {};
    expect(skillRest).toEqual(storedSkillRest);
    // The mirror is written only where it was persisted before, and then equals the canonical draft.
    expect(mirror).toEqual(storedSkillState?.engineeringDraft === undefined ? undefined : projected.engineeringDraft);
  });

  test.each(fixture.scenarios.map(item => [item.id, item]))('%s: the next turn behaves exactly as before', (_id, scenario) => {
    const handler = handlers[scenario.skillId];
    const original = structuredClone(scenario.state);
    const next = attempt(() => resume(scenario));
    if (scenario.skillId === 'generic') {
      expect(next.error).toBeUndefined();
      expect(next.value.structuralTypeKey).toBe('unknown');
      expect(next.value.engineeringDraft.loads).toHaveLength(1);
      expect(next.value.engineeringDraft.loads[0]).toMatchObject({ magnitude: 12, kind: 'point' });
      expect(next.value.skillState.genericDraft.distributedLoads).toEqual([{ value: 2 }]);
      expect(next.value.loadKN).toBeUndefined();
      expect(next.value.lengthM).toBeUndefined();
      expect(scenario.state).toEqual(original);
      return;
    }
    expect(next.error ? next : { json: JSON.stringify(next.value) }).toEqual(scenario.expected.next);
    expect(scenario.state).toEqual(original);
    if (!next.value) return;
    const expected = structuredClone(scenario.expected);
    if (scenario.id === 'frame-3d-engineering') {
      expected.missingExecution = expected.missingInteractive = { value: { critical: ['frameNodalLoadLocation'], optional: [] } };
      expected.questions.value = expected.questions.value.filter(question => question.paramKey !== 'floorLoads');
    }
    expect(attempt(() => handler.computeMissing(next.value, 'execution'))).toEqual(expected.missingExecution);
    expect(attempt(() => handler.computeMissing(next.value, 'interactive'))).toEqual(expected.missingInteractive);
    expect(attempt(() => {
      const missing = handler.computeMissing(next.value, 'interactive');
      return handler.buildQuestions([...missing.critical, ...missing.optional], missing.critical, next.value, 'en');
    })).toEqual(expected.questions);
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

describe('projectDraftState', () => {
  const draft = { structureType: 'beam', geometry: { lengthM: 6 } };
  test('never invents a skill state or a mirror that was not persisted', () => {
    const plain = { inferredType: 'beam', lengthM: 6, updatedAt: 1 };
    expect(Object.keys(projectDraftState(draft, plain))).toEqual(['inferredType', 'lengthM', 'updatedAt', 'engineeringDraft']);
    const withState = { inferredType: 'beam', engineeringDraft: {}, skillState: { extractionSource: 'llm' }, updatedAt: 1 };
    expect(projectDraftState(draft, withState)).toEqual({ ...withState, engineeringDraft: draft });
    expect(projectDraftState(undefined, plain)).toEqual(plain);
    expect(Object.keys(projectDraftState(undefined, plain))).toEqual(Object.keys(plain));
  });

  test('refreshes an existing mirror in place, or adds one on request when a skill state exists', () => {
    const stale = { inferredType: 'beam', engineeringDraft: { structureType: 'beam' }, skillState: { engineeringDraft: { old: true }, beamLoads: [] }, updatedAt: 1 };
    const refreshed = projectDraftState(draft, stale);
    expect(refreshed.skillState).toEqual({ engineeringDraft: draft, beamLoads: [] });
    expect(Object.keys(refreshed.skillState)).toEqual(['engineeringDraft', 'beamLoads']);
    expect(stale.skillState.engineeringDraft).toEqual({ old: true });
    const noMirror = { inferredType: 'beam', engineeringDraft: {}, skillState: { invalidDraftFields: ['loadPosition'] }, updatedAt: 1 };
    expect(projectDraftState(draft, noMirror, { mirror: 'whenSkillState' }).skillState)
      .toEqual({ invalidDraftFields: ['loadPosition'], engineeringDraft: draft });
    expect(projectDraftState(draft, { inferredType: 'beam', updatedAt: 1 }, { mirror: 'whenSkillState' })).not.toHaveProperty('skillState');
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
