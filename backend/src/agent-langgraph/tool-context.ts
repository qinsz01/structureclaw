/**
 * Per-node tool context derived from the turn's frozen run policy.
 *
 * The effective run policy is resolved once per turn (`prepareRunContext` → `createRunContext`,
 * which freezes it). Tool exposure, the tools' skill scope, the tool-call budget and the file
 * allow-list are pure functions of that policy and the checkpointed state; hosts derive them with
 * `deriveToolContext` and hand the result to tools in a fresh config instead of mutating
 * `configurable`.
 */
import type { EffectiveRunPolicy } from '../runtime/run-policy.js';
import type { AgentState, AgentToolAccessPolicy } from './state.js';
import { resolveActiveToolIds } from './tool-policy.js';

export interface ToolContext {
  /** Registry tool IDs bound to the model and executable in this node (sorted). */
  readonly activeToolIds: readonly string[];
  /** Skills tools may resolve; undefined means unrestricted. */
  readonly skillScope: string[] | undefined;
  /** Tool-call budget for this turn; undefined lets callers apply the server default. */
  readonly maxToolCallsPerTurn: number | undefined;
  /** Exact readable file paths for a restricted run; undefined means unrestricted. */
  readonly fileAccessAllowlist: string[] | undefined;
}

/**
 * Host inputs. Without a run policy (direct tool hosts such as scripts and tests, and conversations
 * checkpointed before run policies existed) the tool request comes from here; with a policy only
 * `allowShell` and the request-level `fileAccessAllowlist` are consulted.
 */
export interface ToolHostInputs {
  allowShell: boolean;
  fileAccessAllowlist?: string[];
  enabledToolIds?: string[];
  disabledToolIds?: string[];
  maxToolCallsPerTurn?: number;
}

/**
 * Tool-policy fields that direct tool hosts (scripts, tests) may still inject into `configurable`.
 * They apply only when the host passes no ToolContext and the turn has no run policy.
 */
export interface LegacyToolConfigurable {
  enabledToolIds?: string[];
  disabledToolIds?: string[];
  maxToolCallsPerTurn?: number;
  skillScope?: string[];
}

type ToolContextState = Partial<Pick<AgentState, 'runPolicy' | 'selectedSkillIds' | 'toolAccessPolicy'>>;

/** Skill scope: the policy's active skills intersected with the session selection. */
export function deriveSkillScope(state: ToolContextState, policy: EffectiveRunPolicy | undefined): string[] | undefined {
  const effective = state.runPolicy ?? policy;
  return effective
    ? effective.activeSkillIds.filter(id => state.selectedSkillIds!.includes(id))
    : state.selectedSkillIds?.length ? state.selectedSkillIds : undefined;
}

/**
 * Tool request after applying the checkpointed access policy. Its enabled/disabled lists were
 * mapped into the policy when the turn started, so with a policy they only narrow (never widen) the
 * exposure; they still matter for conversations checkpointed before run policies existed.
 */
export function deriveToolRequest(
  access: Partial<AgentToolAccessPolicy> | undefined,
  policy: EffectiveRunPolicy | undefined,
  host: Omit<ToolHostInputs, 'allowShell'>,
): { enabledToolIds?: string[]; disabledToolIds?: string[]; fileAccessAllowlist?: string[]; maxToolCallsPerTurn?: number } {
  const enabled = Array.isArray(access?.enabledToolIds) ? access.enabledToolIds : undefined;
  const disabled = Array.isArray(access?.disabledToolIds) ? access.disabledToolIds : undefined;
  const fileAccessAllowlist = Array.isArray(access?.fileAccessAllowlist) ? [...access.fileAccessAllowlist] : host.fileAccessAllowlist;
  if (!policy) {
    return {
      enabledToolIds: enabled ? [...enabled] : host.enabledToolIds,
      disabledToolIds: disabled ? [...disabled] : host.disabledToolIds,
      fileAccessAllowlist,
      maxToolCallsPerTurn: host.maxToolCallsPerTurn,
    };
  }
  return {
    enabledToolIds: policy.activeToolIds.filter(id => !enabled || enabled.includes(id)),
    disabledToolIds: [...new Set([...(disabled ?? host.disabledToolIds ?? []), ...policy.tools.disabledIds])],
    fileAccessAllowlist,
    maxToolCallsPerTurn: policy.budgets.maxToolCallsPerTurn,
  };
}

export function deriveToolContext(state: ToolContextState, policy: EffectiveRunPolicy | undefined, host: ToolHostInputs): ToolContext {
  const request = deriveToolRequest(state.toolAccessPolicy, policy, host);
  return Object.freeze({
    activeToolIds: Object.freeze(resolveActiveToolIds({
      requestedEnabledToolIds: request.enabledToolIds,
      requestedDisabledToolIds: request.disabledToolIds,
      allowShell: host.allowShell,
    }).activeToolIds),
    skillScope: deriveSkillScope(state, policy),
    maxToolCallsPerTurn: request.maxToolCallsPerTurn,
    fileAccessAllowlist: request.fileAccessAllowlist,
  });
}
