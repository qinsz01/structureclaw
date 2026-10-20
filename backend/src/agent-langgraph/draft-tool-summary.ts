import type { DraftState } from '../shared/types/agent.js';
import { draftChangedFields } from '../agent-runtime/draft/changes.js';

/** Keep draft data in graph state/input-review. Also projects historical payloads without rewriting storage. */
export function compactDraftToolPayload(payload: Record<string, unknown>, before?: DraftState, after?: DraftState): Record<string, unknown> {
  const { nextState, engineeringDraft: _draft, llmDraftPatch: _patch, ...summary } = payload;
  const applied = Array.isArray(payload.applied) ? payload.applied
    : after ? draftChangedFields(before, after) : undefined;
  return { ...summary,
    ...(applied ? { applied, status: applied.length ? (Array.isArray(payload.unapplied) && payload.unapplied.length ? 'partial' : 'applied') : 'no_change',
      ...(applied.length ? {} : {
        nextAction: Array.isArray(payload.criticalMissing) && payload.criticalMissing.length ? 'ask_user_clarification' : 'use_current_draft',
        hint: 'No draft inputs changed. Do not repeat extraction with the same evidence; use the current draft or explain the unapplied fields. / 草稿输入没有变化。不要用相同证据重复提取；请使用现有草稿或说明未应用字段。',
      }) } : {}),
    ...(nextState && !after && !applied ? { stateStored: true } : {}),
  };
}
