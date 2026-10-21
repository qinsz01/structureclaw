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
import { migrateLegacySkillIds } from '../shared/legacy-capabilities.js';

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

/** Host inputs: the shell gate and the request-level file allow-list. */
interface ToolHostInputs {
  allowShell: boolean;
  fileAccessAllowlist?: string[];
}

type ToolContextState = Partial<Pick<AgentState, 'runPolicy' | 'selectedSkillIds' | 'toolAccessPolicy'>>;

/** Skill scope: the policy's active skills intersected with the session selection. */
function deriveSkillScope(state: ToolContextState, policy: EffectiveRunPolicy | undefined): string[] | undefined {
  const effective = state.runPolicy ?? policy;
  const selection = state.selectedSkillIds ? migrateLegacySkillIds(state.selectedSkillIds, () => {}).skillIds : [];
  return effective
    ? migrateLegacySkillIds(effective.activeSkillIds, () => {}).skillIds.filter(id => selection.includes(id))
    : selection.length ? selection : undefined;
}

/**
 * Tool request after applying the checkpointed access policy. Its enabled/disabled lists were
 * mapped into the policy when the turn started, so with a policy they only narrow (never widen) the
 * exposure; they still matter for conversations checkpointed before run policies existed.
 */
export function deriveToolRequest(
  access: Partial<AgentToolAccessPolicy> | undefined,
  policy: EffectiveRunPolicy | undefined,
  host: Pick<ToolHostInputs, 'fileAccessAllowlist'>,
): { enabledToolIds?: string[]; disabledToolIds?: string[]; fileAccessAllowlist?: string[]; maxToolCallsPerTurn?: number } {
  const enabled = Array.isArray(access?.enabledToolIds) ? access.enabledToolIds : undefined;
  const disabled = Array.isArray(access?.disabledToolIds) ? access.disabledToolIds : undefined;
  const fileAccessAllowlist = Array.isArray(access?.fileAccessAllowlist) ? [...access.fileAccessAllowlist] : host.fileAccessAllowlist;
  if (!policy) {
    return {
      enabledToolIds: enabled ? [...enabled] : undefined,
      disabledToolIds: disabled ? [...disabled] : undefined,
      fileAccessAllowlist,
      maxToolCallsPerTurn: undefined,
    };
  }
  return {
    enabledToolIds: policy.activeToolIds.filter(id => !enabled || enabled.includes(id)),
    disabledToolIds: [...new Set([...(disabled ?? []), ...policy.tools.disabledIds])],
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
