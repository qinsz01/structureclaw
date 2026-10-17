/** Per-turn host settings derived from the request: checkpointed tool access policy and graph recursion limit. */
import type { LangGraphRunInput } from './service-types.js';
import type { AgentToolAccessPolicy } from './state.js';
import { DEFAULT_MAX_TOOL_CALLS_PER_TURN } from '../runtime/limits.js';

export function buildToolAccessPolicy(
  context: LangGraphRunInput['context'] | undefined,
): AgentToolAccessPolicy {
  return {
    enabledToolIds: Array.isArray(context?.enabledToolIds)
      ? [...context.enabledToolIds]
      : null,
    disabledToolIds: Array.isArray(context?.disabledToolIds)
      ? [...context.disabledToolIds]
      : null,
    fileAccessAllowlist: context?.restrictFileAccessToAttachments
      ? (context.attachments ?? []).map((attachment) => attachment.relPath)
      : null,
  };
}

export function getLangGraphRecursionLimit(maxToolCallsPerTurn: number | undefined): number {
  const toolLimit = typeof maxToolCallsPerTurn === 'number' && Number.isFinite(maxToolCallsPerTurn) && maxToolCallsPerTurn > 0
    ? maxToolCallsPerTurn
    : DEFAULT_MAX_TOOL_CALLS_PER_TURN;
  return Math.max(50, toolLimit * 2 + 10);
}
