import { createHash } from 'node:crypto';
import { DEFAULT_MAX_TOOL_CALLS_PER_TURN } from './limits.js';
import { runPolicyInputSchema, type RunPolicyInput } from './run-policy-schema.js';
export { runPolicyInputSchema, type RunPolicyInput };
export interface RunPolicy {
  knowledge: 'enabled' | 'disabled';
  builder: 'auto' | 'llm';
  skillIds: string[] | null;
  routing: { mode: 'auto' } | { mode: 'fixed'; skillId: string };
  repair: { enabled: boolean; maxRecoveriesPerTurn: number };
  context: { history: 'full' | 'current-turn'; memoryScopes: Array<'conversation' | 'workspace'> };
  tools: { enabledIds: string[] | null; disabledIds: string[] };
  budgets: { maxToolCallsPerTurn: number; maxLlmCallsPerTurn: number | null };
}
export interface EffectiveRunPolicy extends RunPolicy {
  version: 1;
  policyHash: string;
  activeSkillIds: string[];
  activeToolIds: string[];
  deniedSkillIds: string[];
  deniedToolIds: string[];
  executionOwner: 'structureclaw' | 'external';
  fieldSources: Record<string, 'default' | 'settings' | 'session' | 'legacy' | 'request' | 'server-limit'>;
  enforcement: { hostLoop: 'structureclaw' | 'external'; conversationText: 'structureclaw' | 'external'; llmBudget: 'structureclaw-calls'; recovery: 'structureclaw-operations' };
  compatibilityNotes: string[];
}
export const DEFAULT_RUN_POLICY: RunPolicy = {
  knowledge: 'enabled', builder: 'auto', skillIds: null, routing: { mode: 'auto' },
  repair: { enabled: true, maxRecoveriesPerTurn: 2 },
  context: { history: 'full', memoryScopes: ['conversation', 'workspace'] },
  tools: { enabledIds: null, disabledIds: [] },
  budgets: { maxToolCallsPerTurn: DEFAULT_MAX_TOOL_CALLS_PER_TURN, maxLlmCallsPerTurn: null },
};
function merge(base: RunPolicy, patch: RunPolicyInput): RunPolicy {
  return { ...base, ...patch, repair: { ...base.repair, ...patch.repair }, context: { ...base.context, ...patch.context },
    tools: { ...base.tools, ...patch.tools }, budgets: { ...base.budgets, ...patch.budgets } };
}
function sorted(values: string[]): string[] { return [...new Set(values)].sort(); }
export function runPolicyValues(value: RunPolicy): RunPolicy {
  const { knowledge, builder, skillIds, routing, repair, context, tools, budgets } = value;
  return { knowledge, builder, skillIds, routing, repair: { ...repair }, context: { ...context }, tools: { ...tools }, budgets: { ...budgets } };
}
export function resolveRunPolicy(input: {
  defaults?: RunPolicyInput; previous?: RunPolicy; requested?: RunPolicyInput;
  legacy?: { skillIds?: string[]; enabledToolIds?: string[]; disabledToolIds?: string[] };
  availableSkillIds: string[]; availableToolIds: string[]; defaultToolIds: string[];
  allowedSkillIds?: string[]; allowedToolIds?: string[]; allowedMemoryScopes?: RunPolicy['context']['memoryScopes']; maxToolCallsPerTurn?: number;
  executionOwner?: 'structureclaw' | 'external';
}): EffectiveRunPolicy {
  const defaults = runPolicyInputSchema.parse(input.defaults ?? {});
  const requested = runPolicyInputSchema.parse(input.requested ?? {});
  const fieldSources: EffectiveRunPolicy['fieldSources'] = {};
  const mark = (values: Record<string, unknown>, source: EffectiveRunPolicy['fieldSources'][string], prefix = '') => {
    for (const [key, value] of Object.entries(values)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) mark(value as Record<string, unknown>, source, fullKey);
      else if (value !== undefined) fieldSources[fullKey] = source;
    }
  };
  mark(DEFAULT_RUN_POLICY as unknown as Record<string, unknown>, 'default');
  mark(defaults, 'settings');
  if (input.previous) mark(runPolicyValues(input.previous) as unknown as Record<string, unknown>, 'session');
  const legacy: RunPolicyInput = {};
  for (const [old, key] of [['skillIds', 'skillIds'], ['enabledToolIds', 'enabledIds'], ['disabledToolIds', 'disabledIds']] as const) {
    const value = input.legacy?.[old];
    if (value === undefined) continue;
    const current = key === 'skillIds' ? requested.skillIds : requested.tools?.[key];
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(value)) throw new Error(`RUN_POLICY_CONFLICT: ${old}`);
    if (key === 'skillIds') legacy.skillIds = value;
    else legacy.tools = { ...legacy.tools, [key]: value };
  }
  let value = merge(DEFAULT_RUN_POLICY, defaults);
  if (input.previous) value = merge(value, runPolicyValues(input.previous));
  value = merge(merge(value, legacy), requested);
  mark(legacy, 'legacy'); mark(requested, 'request');
  const knownSkills = new Set(input.availableSkillIds), knownTools = new Set(input.availableToolIds);
  for (const id of value.skillIds ?? []) if (!knownSkills.has(id)) throw new Error(`UNKNOWN_SKILL: ${id}`);
  for (const id of [...(value.tools.enabledIds ?? []), ...value.tools.disabledIds]) if (!knownTools.has(id)) throw new Error(`UNKNOWN_TOOL: ${id}`);
  const skillCeiling = new Set(input.allowedSkillIds ?? input.availableSkillIds);
  const toolCeiling = new Set(input.allowedToolIds ?? input.availableToolIds);
  const wantedSkills = sorted(value.skillIds ?? input.availableSkillIds);
  const wantedTools = sorted(value.tools.enabledIds ?? input.defaultToolIds);
  const disabled = new Set(value.tools.disabledIds);
  const memoryScopes = value.context.memoryScopes.filter(scope => !input.allowedMemoryScopes || input.allowedMemoryScopes.includes(scope));
  if (memoryScopes.length !== value.context.memoryScopes.length) fieldSources['context.memoryScopes'] = 'server-limit';
  value = { ...value, context: { ...value.context, memoryScopes } };
  if (!value.context.memoryScopes.length) disabled.add('memory');
  const activeSkillIds = wantedSkills.filter(id => skillCeiling.has(id));
  const activeToolIds = wantedTools.filter(id => toolCeiling.has(id) && !disabled.has(id));
  if (value.routing.mode === 'fixed' && !activeSkillIds.includes(value.routing.skillId)) throw new Error('FIXED_SKILL_OUTSIDE_SCOPE');
  if (input.executionOwner === 'external' && value.context.history !== 'full') throw new Error('HOST_CONTEXT_CONTROL_UNSUPPORTED');
  if (input.maxToolCallsPerTurn !== undefined && value.budgets.maxToolCallsPerTurn > input.maxToolCallsPerTurn) fieldSources['budgets.maxToolCallsPerTurn'] = 'server-limit';
  value = { ...value, skillIds: value.skillIds === null ? null : sorted(value.skillIds),
    repair: { ...value.repair, maxRecoveriesPerTurn: value.repair.enabled ? value.repair.maxRecoveriesPerTurn : 0 },
    tools: { enabledIds: value.tools.enabledIds === null ? null : sorted(value.tools.enabledIds), disabledIds: sorted(value.tools.disabledIds) },
    context: { ...value.context, memoryScopes: sorted(value.context.memoryScopes) as RunPolicy['context']['memoryScopes'] },
    budgets: { ...value.budgets, maxToolCallsPerTurn: Math.min(value.budgets.maxToolCallsPerTurn, input.maxToolCallsPerTurn ?? Infinity) } };
  const body = { ...value, version: 1 as const, activeSkillIds, activeToolIds,
    deniedSkillIds: wantedSkills.filter(id => !activeSkillIds.includes(id)), deniedToolIds: wantedTools.filter(id => !activeToolIds.includes(id)),
    executionOwner: input.executionOwner ?? 'structureclaw' as const };
  return { ...body, policyHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'), fieldSources,
    enforcement: { hostLoop: body.executionOwner, conversationText: body.executionOwner, llmBudget: 'structureclaw-calls', recovery: 'structureclaw-operations' },
    compatibilityNotes: Object.keys(legacy).length ? ['Legacy context fields were mapped once; explicit empty arrays mean no capabilities.'] : [],
  };
}
