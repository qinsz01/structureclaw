import { beforeEach, describe, expect, test, jest } from '@jest/globals';
import { resolveRunPolicy } from '../../../dist/runtime/run-policy.js';
import { createRunContext, withRunContext } from '../../../dist/runtime/run-context.js';
import { getStructureModelTemplate } from '../../../dist/agent-skills/structure-type/generic/llm-model-prompt-fragments.js';
import { withDeclaredProperties } from '../../../tests/fixtures/declared-template-properties.mjs';
const llmModule = await import('../../../dist/utils/llm.js');
let generated = 0;
jest.unstable_mockModule('../../../dist/utils/llm.js', () => ({ ...llmModule, createChatModel: () => ({ invoke: async () => { generated++; return { content: getStructureModelTemplate() }; } }) }));
const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
const { tryBuildGenericModelWithLlm } = await import('../../../dist/agent-skills/structure-type/generic/llm-model-builder.js');
const resolve = requested => resolveRunPolicy({ requested, availableSkillIds: ['test-provider'], availableToolIds: ['build_model'], defaultToolIds: ['build_model'] });
beforeEach(() => { generated = 0; });

describe('model builder choice is independent of routing and guidance', () => {
  test('the registered beam template runs only in auto mode; llm mode invokes the generic builder with the same draft', async () => {
    const runtime = new AgentSkillRuntime();
    const plugin = await runtime.resolvePluginForType('beam', ['beam']);
    expect(plugin?.id).toBe('beam');
    const draft = withDeclaredProperties(plugin.handler.mergeState(undefined, plugin.handler.extractDraft({ message: '', llmDraftPatch: {
      engineeringDraft: { structureType: 'beam', geometry: { lengthM: 6 }, boundary: { supportType: 'simply-supported' },
        loads: [{ kind: 'line', magnitude: 10, unit: 'kN/m', direction: 'gravity', target: 'beam' }] },
    } })));
    const policy = requested => resolveRunPolicy({ requested, availableSkillIds: ['beam'], availableToolIds: ['build_model'], defaultToolIds: ['build_model'] });
    const template = jest.spyOn(plugin.handler, 'buildModel');
    const before = generated;
    try {
      const automatic = createRunContext(policy({ builder: 'auto' }));
      const direct = await withRunContext(automatic, () => runtime.buildModel(draft, ['beam'], { message: 'Build the specified beam', locale: 'en' }));
      expect(direct.elements.length).toBeGreaterThan(0);
      expect(template).toHaveBeenCalledTimes(1);
      expect(generated).toBe(before);
      expect(automatic.usage.events).toContainEqual(expect.objectContaining({ kind: 'model_builder', builder: 'template', skillId: 'beam' }));

      const generic = createRunContext(policy({ builder: 'llm' }));
      await withRunContext(generic, () => runtime.buildModel(draft, ['beam'], { message: 'Build the specified beam', locale: 'en' }));
      expect(template).toHaveBeenCalledTimes(1);
      expect(generated).toBe(before + 1);
      expect(generic.usage.events).toContainEqual(expect.objectContaining({ kind: 'model_builder', builder: 'llm', skillId: 'beam' }));
    } finally { template.mockRestore(); }
  });
  test.each(['auto', 'llm'])('explicit imports retain geometry and record that the %s builder was bypassed', async builder => {
    const runtime = new AgentSkillRuntime();
    const context = createRunContext(resolve({ builder }));
    const model = JSON.parse(getStructureModelTemplate());
    const before = generated;
    const result = await withRunContext(context, () => runtime.buildModel({ engineeringDraft: { model } }, ['test-provider'], { message: 'Import this model', locale: 'en' }));
    expect(result.nodes).toEqual(model.nodes);
    expect(result.elements).toEqual(model.elements);
    expect(generated).toBe(before);
    expect(context.usage.events).toContainEqual(expect.objectContaining({ kind: 'model_builder', builder: 'explicit', requestedBuilder: builder, source: 'model' }));
  });
  test('llm builder bypasses the exact same routed template without changing knowledge or scope', async () => {
    let templates = 0;
    const runtime = new AgentSkillRuntime();
    const plugin = { id: 'test-provider', structureType: 'beam', manifest: { structuralTypeKeys: ['beam'] }, handler: {
      computeMissing: () => ({ critical: [], optional: [] }), buildModel: () => { templates++; return { template: true }; },
    } };
    runtime.registry.resolvePluginForState = async () => plugin;
    runtime.registry.resolvePluginForIdentifier = async () => plugin;
    const base = resolve({ routing: { mode: 'fixed', skillId: 'test-provider' } });
    const generic = resolve({ routing: { mode: 'fixed', skillId: 'test-provider' }, builder: 'llm' });
    expect(generic.activeSkillIds).toEqual(base.activeSkillIds);
    expect(generic.knowledge).toBe(base.knowledge);
    const context = { message: 'Use the supplied model data', locale: 'en' };
    const draft = { inferredType: 'beam', skillId: 'test-provider' };
    expect(await withRunContext(createRunContext(base), () => runtime.buildModel(draft, ['test-provider'], context))).toEqual({ template: true });
    const result = await withRunContext(createRunContext(generic), async () => {
      expect(await runtime.detectStructuralTypeWithLlm(null, 'beam', 'en')).toMatchObject({ skillId: 'test-provider', routingSource: 'policy-fixed' });
      return runtime.buildModel(draft, ['test-provider'], context);
    });
    expect(result.schema_version).toBe('2.2.0');
    expect(templates).toBe(1); expect(generated).toBe(1);
  });
  test('invalid generated candidates use the shared recovery ledger; transport failures are never hidden retries', async () => {
    const runtime = createRunContext(resolve({ repair: { enabled: false } }));
    let calls = 0;
    await expect(withRunContext(runtime, () => tryBuildGenericModelWithLlm({ invoke: async () => { calls++; return { content: 'invalid' }; } }, 'model', {}, 'en'))).rejects.toThrow('RECOVERY_BUDGET_EXHAUSTED');
    expect(calls).toBe(1);
    calls = 0;
    await expect(withRunContext(createRunContext(resolve({})), () => tryBuildGenericModelWithLlm({ invoke: async () => { calls++; throw new Error('transport'); } }, 'model', {}, 'en'))).rejects.toThrow('transport');
    expect(calls).toBe(1);
  });
});
