import { z } from 'zod';
import { PROFILE_IDS, unknownProfileMessage } from './ablation-profiles.js';

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
  budgets: z.object({ maxToolCallsPerTurn: positive.optional(), maxLlmCallsPerTurn: positive.nullable().optional() }).strict().optional(),
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
