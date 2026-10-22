import { describe, expect, jest, test } from '@jest/globals';
import { AgentSkillRuntime } from '../dist/agent-runtime/index.js';
import { resolveRunPolicy } from '../dist/runtime/run-policy.js';
import { createRunContext, withRunContext } from '../dist/runtime/run-context.js';

const policy = requested => resolveRunPolicy({ requested, availableSkillIds: ['beam', 'frame', 'generic'],
  availableToolIds: ['extract_draft_params'], defaultToolIds: ['extract_draft_params'] });
const response = decision => ({ content: JSON.stringify({ confidence: 1, ...decision }) });
const beam = { action: 'switch_skill', skillId: 'beam', structuralTypeKey: 'beam', mappedType: 'beam', supportLevel: 'supported' };

describe('configured scope never classifies text with rules', () => {
  test('scope accepts only exact provider or skill IDs, never a model family or type alias', async () => {
    const registry = new AgentSkillRuntime().getRegistry();
    expect((await registry.resolveEnabledPlugins(['frame'])).map(plugin => plugin.id)).toEqual(['frame']);
    expect(await registry.resolveEnabledPlugins(['steel-frame'])).toEqual([]);
    expect((await registry.resolvePluginForIdentifier('steel-frame', ['frame']))?.id).toBe('frame');
  });
  test.each([
    ['zh', '问题：候选A混凝土矩形250×500；候选B钢梁腹板tw=8mm。真实回答：C30混凝土矩形250×500。'],
    ['en', 'Use the beam template. The unselected alternative was a slab with a base plate.'],
  ])('sole generic binds the selected provider without inspecting %s keywords', async (locale, message) => {
    const runtime = new AgentSkillRuntime();
    const invoke = jest.fn(() => { throw new Error('No additional router call is needed'); });
    const context = createRunContext(policy({ skillIds: ['generic'] }));
    const before = { inferredType: 'unknown', structuralTypeKey: 'plate-slab', skillId: 'generic',
      supportLevel: 'unsupported', updatedAt: 0, engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 } } };
    const saved = structuredClone(before);
    const match = await withRunContext(context, () => runtime.detectStructuralTypeWithLlm({ invoke }, message, locale, before, ['generic']));
    expect(match).toEqual({ key: 'unknown', mappedType: 'unknown', skillId: 'generic', supportLevel: 'supported', routingSource: 'scope-selected' });
    expect(match.scopeExclusion).toBeUndefined();
    expect(before).toEqual(saved);
    expect(invoke).not.toHaveBeenCalled();
    expect(context.usage.llmCalls).toBe(0);
    expect(context.usage.recoveries).toBe(0);
    expect(context.usage.events).toContainEqual(expect.objectContaining({ kind: 'structural_routing', path: 'scope-only', skillId: 'generic' }));
  });

  test.each([
    { skillIds: ['beam', 'generic'] }, { skillIds: ['generic'] },
    { skillIds: ['generic'], routing: { mode: 'fixed', skillId: 'generic' } },
  ])('a natural-language routing entry cannot succeed without an LLM: %j', async requested => {
    const context = createRunContext(policy(requested));
    await expect(withRunContext(context, () => new AgentSkillRuntime().detectStructuralTypeWithLlm(null, '简支梁跨度10m', 'zh')))
      .rejects.toThrow(/LLM_STRUCTURAL_ROUTER_REQUIRED:.*大模型/);
    expect(context.usage.events.filter(event => event.kind === 'structural_routing')).toEqual([]);
  });

  test('an empty scope fails without silently enabling generic', async () => {
    const invoke = jest.fn();
    const context = createRunContext(policy({ skillIds: [] }));
    await expect(withRunContext(context, () => new AgentSkillRuntime().detectStructuralTypeWithLlm({ invoke }, 'Build a beam.', 'en')))
      .rejects.toThrow(/STRUCTURE_SKILL_UNAVAILABLE:.*建模技能/);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('fixed routing binds its configured skill without looking at structural words', async () => {
    const invoke = jest.fn();
    const context = createRunContext(policy({ skillIds: ['generic'], routing: { mode: 'fixed', skillId: 'generic' } }));
    const match = await withRunContext(context, () => new AgentSkillRuntime().detectStructuralTypeWithLlm({ invoke }, 'beam slab shell tower bridge 腹板', 'en'));
    expect(match).toMatchObject({ skillId: 'generic', routingSource: 'policy-fixed' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test.each(['invalid', 'network', 'disabled-skill', 'contradictory-type'])('%s LLM output never selects a rule or another provider', async failure => {
    const context = createRunContext(policy({ skillIds: ['beam', 'frame', 'generic'] }));
    const before = { inferredType: 'beam', skillId: 'beam', structuralTypeKey: 'beam', updatedAt: 0, lengthM: 10 };
    const saved = structuredClone(before);
    const invoke = jest.fn(async () => {
      if (failure === 'network') throw new Error('offline');
      if (failure === 'disabled-skill') return response({ ...beam, skillId: 'concrete-frame', mappedType: 'frame', structuralTypeKey: 'concrete-frame' });
      if (failure === 'contradictory-type') return response({ ...beam, mappedType: 'frame', structuralTypeKey: 'frame' });
      return { content: 'not JSON' };
    });
    await expect(withRunContext(context, () => new AgentSkillRuntime().detectStructuralTypeWithLlm({ invoke }, 'Build a concrete frame with a beam.', 'en', before)))
      .rejects.toThrow(failure === 'network' ? /LLM_STRUCTURAL_ROUTER_INFRASTRUCTURE_ERROR:.*大模型/ : /LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT:.*大模型/);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(before).toEqual(saved);
    expect(context.usage.recoveries).toBe(1);
    expect(context.usage.events.filter(event => event.kind === 'structural_routing')).toEqual([
      expect.objectContaining({ path: 'failed' }),
    ]);
  });

  test('an LLM decision remains authoritative despite words naming other skills', async () => {
    const context = createRunContext(policy({ skillIds: ['beam', 'generic'] }));
    const invoke = jest.fn(async () => response(beam));
    const match = await withRunContext(context, () => new AgentSkillRuntime().detectStructuralTypeWithLlm({ invoke },
      'Do not use the concrete frame option. Analyze only the beam; the template mentions a plate.', 'en'));
    expect(match).toMatchObject({ key: 'beam', skillId: 'beam', routingSource: 'llm-suggested' });
    expect(match.scopeExclusion).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test.each([
    { action: 'switch_skill', skillId: 'beam', supportLevel: 'fallback' },
    { action: 'generic', skillId: 'generic', structuralTypeKey: 'plate-slab' },
    { action: 'generic', skillId: 'generic', mappedType: 'beam' },
    { action: 'continue_current', skillId: 'beam', supportLevel: 'unsupported' },
    { skillId: 'beam', supportLevel: 'supported' },
  ])('rejects contradictory or retired router output %j', async decision => {
    const before = { inferredType: 'beam', skillId: 'beam', structuralTypeKey: 'beam', updatedAt: 0 };
    const invoke = jest.fn(async () => response(decision));
    await expect(new AgentSkillRuntime().detectStructuralTypeWithLlm({ invoke }, 'Continue.', 'en', before, ['beam', 'generic']))
      .rejects.toThrow('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test.each([
    { inferredType: 'unknown', structuralTypeKey: 'plate-slab', skillId: 'generic', supportLevel: 'unsupported' },
    { inferredType: 'frame', structuralTypeKey: 'beam', skillId: 'beam' },
    { inferredType: 'frame', structuralTypeKey: 'concrete-frame', skillId: 'concrete-frame' },
  ])('continue_current cannot adopt an inconsistent or disabled historical state %j', async draft => {
    const before = { ...draft, updatedAt: 0 };
    const saved = structuredClone(before);
    const invoke = jest.fn(async () => response({ action: 'continue_current' }));
    await expect(new AgentSkillRuntime().detectStructuralTypeWithLlm({ invoke }, 'Continue.', 'en', before, ['beam', 'generic']))
      .rejects.toThrow('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT');
    expect(before).toEqual(saved);
  });

  test('a validated continuation creates supported routing metadata instead of copying a legacy fallback label', async () => {
    const before = { inferredType: 'beam', structuralTypeKey: 'unknown', skillId: 'generic', supportLevel: 'fallback',
      supportNote: 'historical keyword result', updatedAt: 0 };
    const invoke = jest.fn(async () => response({ action: 'continue_current', skillId: 'generic' }));
    const match = await new AgentSkillRuntime().detectStructuralTypeWithLlm({ invoke }, 'Continue.', 'en', before, ['beam', 'generic']);
    expect(match).toMatchObject({ key: 'unknown', mappedType: 'unknown', skillId: 'generic', supportLevel: 'supported' });
    expect(match.supportNote).toBeUndefined();
    expect(before.supportLevel).toBe('fallback');
  });

  test('deleted rule-only APIs cannot be called by the runtime or skill handlers', async () => {
    const runtime = new AgentSkillRuntime();
    expect(runtime.detectStructuralType).toBeUndefined();
    expect(runtime.getRegistry().detectStructuralType).toBeUndefined();
    for (const plugin of await runtime.getRegistry().listPlugins()) expect(plugin.handler.detectStructuralType).toBeUndefined();
  });
});
