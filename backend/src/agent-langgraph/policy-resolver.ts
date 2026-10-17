import { config } from '../config/index.js';
import { readSettingsFile } from '../config/settings-file.js';
import { listAgentToolDefinitions } from './tool-registry.js';
import { resolveActiveToolIds } from './tool-policy.js';
import { resolveRunPolicy, type RunPolicyInput, type RunPolicy } from '../runtime/run-policy.js';

/** Skill ids plus the structure-type subset the generic-only ablation profile needs. */
export function skillCatalog(manifests: Array<{ id: string; domain: string }>): { availableSkillIds: string[]; structureTypeSkillIds: string[] } {
  return { availableSkillIds: manifests.map(item => item.id),
    structureTypeSkillIds: manifests.filter(item => item.domain === 'structure-type').map(item => item.id) };
}

/** One settings/permission boundary for chat and direct public-tool sessions. */
export function resolveApplicationRunPolicy(input: {
  availableSkillIds: string[]; structureTypeSkillIds?: string[]; previous?: RunPolicy; requested?: RunPolicyInput;
  legacy?: { skillIds?: string[]; enabledToolIds?: string[]; disabledToolIds?: string[] };
  executionOwner?: 'structureclaw' | 'external';
}) {
  const settings = readSettingsFile()?.agent;
  const defaults: RunPolicyInput = { ...settings?.runPolicy,
    budgets: { maxToolCallsPerTurn: config.agentMaxToolCallsPerTurn, ...settings?.runPolicy?.budgets } };
  const definitions = listAgentToolDefinitions();
  const ceiling = resolveActiveToolIds({ requestedEnabledToolIds: defaults.tools?.enabledIds ?? definitions.map(item => item.id),
    requestedDisabledToolIds: defaults.tools?.disabledIds, allowShell: config.agentAllowShell });
  return resolveRunPolicy({ ...input, defaults, envProfile: config.runProfile,
    availableToolIds: definitions.map(item => item.id), defaultToolIds: definitions.filter(item => item.defaultEnabled).map(item => item.id),
    allowedSkillIds: defaults.skillIds ?? undefined, allowedToolIds: ceiling.activeToolIds,
    allowedMemoryScopes: defaults.context?.memoryScopes,
    maxToolCallsPerTurn: defaults.budgets?.maxToolCallsPerTurn,
  });
}
