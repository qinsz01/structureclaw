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
    await expect(withRunContext(context, () => runtime.buildModel({ engineeringDraft: { model },
      draftIssues: [{ field: 'model.nodes[0].restraints', kind: 'confirmation', severity: 'ambiguous', reason: 'Support not confirmed' }],
    }, ['test-provider'], { message: 'Import this model', locale: 'en' }))).rejects.toThrow('MODEL_DRAFT_INCOMPLETE');
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

  test('LLM building is not blocked by absent template counts; unresolved user evidence still blocks it', async () => {
    const runtime = new AgentSkillRuntime();
    const recipe = jest.fn(() => ({ critical: ['storyCount', 'bayCount'], optional: [] }));
    const plugin = { id: 'test-provider', handler: { computeMissing: recipe, buildModel: () => { throw Error('template must not run'); } } };
    runtime.registry.resolvePluginForState = async () => plugin;
    const policy = resolve({ builder: 'llm' });
    const context = { message: 'Use the supplied irregular layout without a regular bay count', locale: 'en' };
    const state = { inferredType: 'frame', skillId: 'test-provider' };
    const result = await withRunContext(createRunContext(policy), () => runtime.buildModel(state, ['test-provider'], context));
    expect(result.schema_version).toBe('2.2.0');
    expect(recipe).not.toHaveBeenCalled();
    const calls = generated;
    await expect(withRunContext(createRunContext(policy), () => runtime.buildModel({ ...state,
      draftIssues: [{ field: 'boundary.supportType', kind: 'confirmation', severity: 'ambiguous', reason: 'Support is unclear' }],
    }, ['test-provider'], context))).rejects.toThrow('MODEL_DRAFT_INCOMPLETE: boundary.supportType');
    expect(generated).toBe(calls);
  });

  test('partial explicit topology in llm mode reaches generation instead of a template/import precondition', async () => {
    const runtime = new AgentSkillRuntime();
    const plugin = { id: 'test-provider', handler: { computeMissing: () => ({ critical: ['frameDimension'], optional: [] }) } };
    runtime.registry.resolvePluginForState = async () => plugin;
    const state = { inferredType: 'frame', engineeringDraft: {
      topology: { members: [{ id: 'E', type: 'beam', nodes: ['A', 'B'] }] },
    } };
    const before = generated;
    await withRunContext(createRunContext(resolve({ builder: 'llm' })), () => runtime.buildModel(state, ['test-provider'], { message: 'Use the complete geometry supplied in this user message', locale: 'en' }));
    expect(generated).toBe(before + 1);
  });

  test.each([null, undefined])('static LLM candidates can omit optional density/G as %s when self weight is off', async absent => {
    const model = JSON.parse(getStructureModelTemplate());
    model.analysis_control = { self_weight: false };
    for (const material of model.materials) { material.rho = absent; material.G = absent; }
    const result = await tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(model) }) }, 'Static response without self weight', {}, 'en');
    expect(result.analysis_control.self_weight).toBe(false);
    model.analysis_control.self_weight = true;
    await expect(tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(model) }) }, 'Self weight requested', {}, 'en')).rejects.toThrow('finite rho required');
  });

  test.each(['zh', 'en'])('a correction receives the exact formal validation error and previous candidate (%s)', async locale => {
    const prompts = [];
    const candidate = getStructureModelTemplate();
    let attempts = 0;
    const context = createRunContext(resolve({ builder: 'llm' }));
    const result = await withRunContext(context, () => tryBuildGenericModelWithLlm({ invoke: async prompt => {
      prompts.push(prompt); return { content: candidate };
    } }, 'Preserve the supplied model', { inferredType: 'beam' }, locale, undefined, undefined, undefined,
    async model => { if (++attempts === 1) throw Error('sections[S1].shape.H: must be positive'); return model; }));
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('sections[S1].shape.H: must be positive');
    expect(prompts[1]).toContain('previousCandidate');
    expect(prompts[1]).toContain('validationError');
  });

  test('LLM-identified missing facts request clarification without retrying or consuming recovery', async () => {
    const { ModelInputRequiredError } = await import('../../../dist/agent-skills/structure-type/generic/llm-model-builder.js');
    const { createBuildModelTool } = await import('../../../dist/agent-langgraph/tools.js');
    const context = createRunContext(resolve({ builder: 'llm', repair: { enabled: false } }));
    const invoke = jest.fn(async () => ({ content: JSON.stringify({ missing_fields: [{ field: 'boundary.supportType', reason: 'Support is not specified' }] }) }));
    await expect(withRunContext(context, () => tryBuildGenericModelWithLlm({ invoke }, 'Make a model', {}, 'en'))).rejects.toBeInstanceOf(ModelInputRequiredError);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(context.usage.recoveries).toBe(0);
    const result = await createBuildModelTool({ buildModel: async () => { throw new ModelInputRequiredError(['boundary.supportType']); } }).invoke({}, {
      toolCall: { id: 'clarify-build', name: 'build_model' }, configurable: { agentState: { draftState: {}, messages: [] } },
    });
    const feedback = JSON.parse(result.update.messages[0].content);
    expect(feedback).toMatchObject({ status: 'input_required', modelBuilt: false, nextAction: 'ask_user_clarification' });
    expect(feedback.error).toBeUndefined();
    expect(feedback.success).not.toBe(false);
    expect(result.update.model).toBeUndefined();
  });
});
