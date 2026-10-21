import { describe, expect, test } from '@jest/globals';
import { tryBuildGenericModelWithLlm } from '../../../../../dist/agent-skills/structure-type/generic/llm-model-builder.js';
import { genericFixtures } from '../../../../../tests/characterization/fixtures/generic-physics.mjs';
import { resolveRunPolicy } from '../../../../../dist/runtime/run-policy.js';
import { createRunContext, withRunContext } from '../../../../../dist/runtime/run-context.js';

const fixture = genericFixtures[0];
function context(repair) {
  return createRunContext(resolveRunPolicy({ availableSkillIds: ['generic'], structureTypeSkillIds: ['generic'], availableToolIds: [], requested: { repair } }));
}
const state = { skillId: 'generic', inferredType: 'unknown', updatedAt: 0 };
const broken = () => { const model = structuredClone(fixture.model); for (const node of model.nodes) delete node.restraints; return model; };
describe('generic physics repair and shared completion', () => {
  test('feeds the actual bilingual diagnostics and previous candidate back into one correction', async () => {
    const prompts = [], run = context({ enabled: true, maxRecoveriesPerTurn: 2 });
    const llm = { invoke: async prompt => { prompts.push(prompt); return { content: JSON.stringify(prompts.length === 1 ? broken() : fixture.model) }; } };
    const model = await withRunContext(run, () => tryBuildGenericModelWithLlm(llm, 'Build the supplied frame.', state, 'en'));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('KINEMATIC_MECHANISM');
    expect(prompts[1]).toContain('支座');
    expect(prompts[1]).toContain('previousCandidate');
    expect(run.usage.recoveries).toBe(1);
    expect(model.metadata.physicsCheck.valid).toBe(true);
  });
  test.each([0, 1, 2])('uses exactly the permitted %i repairs and preserves exhausted diagnostics', async repairs => {
    let calls = 0; const run = context({ enabled: repairs > 0, maxRecoveriesPerTurn: repairs });
    const llm = { invoke: async () => { calls++; return { content: JSON.stringify(broken()) }; } };
    await expect(withRunContext(run, () => tryBuildGenericModelWithLlm(llm, 'Frame.', state, 'zh')))
      .rejects.toMatchObject({ code: 'MODEL_PHYSICS_INVALID', check: { valid: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'KINEMATIC_MECHANISM' })]) } });
    expect(calls).toBe(repairs + 1); expect(run.usage.recoveries).toBe(repairs);
  });
  test('fills known grades without overwriting supplied constants and leaves geometric properties to the protocol', async () => {
    const candidate = structuredClone(fixture.model);
    candidate.materials = [{ id: 'Q235', name: 'Q235', E: 200000 }];
    const model = await tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(candidate) }) }, 'Use Q235 with explicit E=200000MPa.', state, 'en');
    expect(model.materials[0]).toMatchObject({ E: 200000, nu: 0.3, rho: 7850 });
    expect(model.sections[0].shape).toEqual(fixture.model.sections[0].shape);
    expect(model.sections[0].properties).toBeUndefined();
  });
  test.each([undefined, 'opensees'])('force-only topology with engine %s gets host unit stiffness and excludes self-weight', async engineTarget => {
    const candidate = structuredClone(fixture.model); candidate.materials = []; candidate.sections = [];
    const model = await tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(candidate) }) }, 'Forces only.', {
      ...state, engineeringDraft: { analysis: { type: 'static', ...(engineTarget ? { engineTarget } : {}) } },
      requestScope: { responses: ['forces', 'reactions'], design: false, report: false, outputs: [] },
    }, 'en');
    expect(model.materials[0].E).toBe(1);
    expect(model.metadata.stiffnessPlaceholder).toMatchObject({ material: true, section: true });
    expect(model.analysis_control.self_weight).toBe(false);
    expect(model.sections[0].extra.stiffnessPlaceholder).toBe(true);
  });
  test('a model cannot insert partial unit stiffness beside confirmed real properties', async () => {
    const candidate = structuredClone(fixture.model);
    candidate.sections.push({ id: 'invented', type: 'custom', name: 'Unit brace', properties: { A: 1 }, extra: { provenance: { properties: 'unit-stiffness' } } });
    candidate.elements[0].section = 'invented';
    await expect(withRunContext(context({ enabled: false }), () => tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(candidate) }) },
      'Use supplied real sections; ask for missing ones.', { ...state, engineeringDraft: fixture.draft.engineeringDraft }, 'en'))).rejects.toThrow('actual properties required for invented');
  });
  test('model-authored placeholder metadata cannot hide displacement of a real-property model', async () => {
    const candidate = structuredClone(fixture.model); candidate.metadata = { stiffnessPlaceholder: { material: true, section: true } };
    const model = await tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(candidate) }) }, 'Use real properties.',
      { ...state, engineeringDraft: fixture.draft.engineeringDraft }, 'en');
    expect(model.metadata.stiffnessPlaceholder).toBeUndefined();
    expect(candidate.metadata.stiffnessPlaceholder).toBeDefined();
  });
});
