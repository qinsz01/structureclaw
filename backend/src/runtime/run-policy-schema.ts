import { migrateLegacySkillIds } from '../shared/legacy-capabilities.js';
import { z } from 'zod';
import { PROFILE_IDS, unknownProfileMessage } from './ablation-profiles.js';
import { MAX_TOOL_CALLS_PER_TURN_LIMIT } from './limits.js';

const ids = z.array(z.string().trim().min(1));
const positive = z.number().int().positive();
export const runPolicyInputSchema = z.object({
  knowledge: z.enum(['enabled', 'disabled']).optional(),
  builder: z.enum(['auto', 'llm']).optional(),
  skillIds: ids.nullable().optional(),
  routing: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('auto') }).strict(),
    z.object({ mode: z.literal('fixed'), skillId: z.string().trim().min(1) }).strict(),
  ]).optional(),
  repair: z.object({ enabled: z.boolean().optional(), maxRecoveriesPerTurn: z.number().int().nonnegative().optional() }).strict().optional(),
  context: z.object({ history: z.enum(['full', 'current-turn']).optional(), memoryScopes: z.array(z.enum(['conversation', 'workspace'])).optional() }).strict().optional(),
  tools: z.object({ enabledIds: ids.nullable().optional(), disabledIds: ids.optional() }).strict().optional(),
  providers: z.object({ preferredIds: ids.optional(), disabledIds: ids.optional() }).strict().optional(),
  budgets: z.object({ maxToolCallsPerTurn: positive.max(MAX_TOOL_CALLS_PER_TURN_LIMIT, 'TOOL_CALL_LIMIT_EXCEEDED / 工具调用次数超过服务器上限').optional(), maxLlmCallsPerTurn: positive.nullable().optional() }).strict().optional(),
  features: z.object({
    clarification: z.enum(['enabled', 'disabled']).optional(),
    validation: z.enum(['enabled', 'disabled']).optional(),
    stateVersioning: z.enum(['on', 'off']).optional(),
    evidenceBinding: z.enum(['on', 'off']).optional(),
  }).strict().optional(),
  /** Pre-registered ablation profile (runtime/ablation-profiles.ts); explicit fields override it. */
  profile: z.enum(PROFILE_IDS, { error: issue => unknownProfileMessage(issue.input) }).optional(),
}).strict();
export type RunPolicyInput = z.infer<typeof runPolicyInputSchema>;

/** Non-structural legacy selections never narrow the structure modelling scope. */
export function migrateRunPolicyInput<T extends RunPolicyInput>(input: T): T {
  if (!input.skillIds) return input;
  const migrated = migrateLegacySkillIds(input.skillIds);
  return { ...input, skillIds: input.skillIds.length && !migrated.skillIds.length ? null : migrated.skillIds,
    ...(migrated.preferredProviderIds.length ? { providers: { ...input.providers,
      preferredIds: [...new Set([...(input.providers?.preferredIds ?? []), ...migrated.preferredProviderIds])] } } : {}) };
}
