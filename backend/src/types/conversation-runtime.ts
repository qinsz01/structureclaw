import type { EffectiveRunPolicy } from '../runtime/run-policy.js';

/** Read-only projection of the checkpoint, its existing usage ledger and analysis receipts. */
export interface ConversationRuntimeSnapshot {
  conversationId: string;
  busy: boolean;
  waitingForReply: boolean;
  question: string | null;
  options: string[];
  modelRevision: number;
  modelPending: boolean;
  policy: EffectiveRunPolicy | null;
  usage: { runId: string; policyHash: string; toolCalls: number; llmCalls: number; recoveries: number } | null;
  /** Actual execution in the current run; absent on servers without this projection. */
  modeling?: {
    routedSkillId: string | null;
    usedSkillIds: string[];
    builder: 'template' | 'llm' | 'explicit' | null;
  };
  analysis: { runId: string | null; resultKey: string | null; current: boolean; reason: string | null };
  report: { current: boolean; runId: string | null };
  jobs: Array<{ requestId: string; kind: string; status: string; runId: string | null; cancellationAvailable: boolean;
    stateHash?: string; ownerAlive?: boolean | null; recoveryAvailable?: boolean; inHistory?: boolean }>;
}
