import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EffectiveRunPolicy } from './run-policy.js';

export interface RunUsage {
  runId: string; policyHash: string; toolCalls: number; llmCalls: number; recoveries: number;
  /** Internal fallbacks since the latest user answer; recoveries remains a cumulative audit count. */
  recoveriesUsed?: number;
  pendingFailures: Record<string, string>; startedToolCallIds: string[];
  events: Array<Record<string, unknown>>;
  /** Guard interventions per guard kind (agent-langgraph/guards); absent until a guard fires. */
  guards?: Record<string, number>;
}
export interface RunContext { policy: EffectiveRunPolicy; usage: RunUsage; journalPath?: string }
const storage = new AsyncLocalStorage<RunContext>();
export function currentRunContext(): RunContext | undefined { return storage.getStore(); }
export function currentRunPolicy(): EffectiveRunPolicy | undefined { return storage.getStore()?.policy; }
export function snapshotRunUsage(context: RunContext): RunUsage { return structuredClone(context.usage); }
/** Reading status must not create a run, reset counters or rewrite the ledger. */
export function readRunUsage(policy: EffectiveRunPolicy, saved: RunUsage, journalDir: string): RunUsage {
  if (!/^[a-zA-Z0-9_-]+$/.test(saved.runId)) throw new Error('INVALID_RUN_ID');
  const journalPath = path.join(journalDir, `${saved.runId}.json`);
  if (!fs.existsSync(journalPath)) return structuredClone(saved);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  if (journal.policy?.policyHash !== policy.policyHash || journal.usage?.runId !== saved.runId
    || journal.usage?.policyHash !== policy.policyHash || journal.usage.toolCalls < saved.toolCalls
    || journal.usage.llmCalls < saved.llmCalls || journal.usage.recoveries < saved.recoveries) throw new Error('RUN_POLICY_RESUME_CONFLICT');
  return structuredClone(journal.usage);
}
function freezePolicy<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezePolicy(child);
    Object.freeze(value);
  }
  return value;
}
export function createRunContext(policy: EffectiveRunPolicy, options: { runId?: string; usage?: RunUsage; journalDir?: string; resume?: boolean } = {}): RunContext {
  const runId = options.runId ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('INVALID_RUN_ID');
  const journalPath = options.journalDir ? path.join(options.journalDir, `${runId}.json`) : undefined;
  let usage = options.usage ? structuredClone(options.usage) : { runId, policyHash: policy.policyHash, toolCalls: 0, llmCalls: 0, recoveries: 0, pendingFailures: {}, startedToolCallIds: [], events: [] };
  if (options.resume && journalPath && fs.existsSync(journalPath)) {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (journal.policy.policyHash !== policy.policyHash) throw new Error('RUN_POLICY_RESUME_CONFLICT');
    usage = journal.usage;
  }
  if (usage.runId !== runId || usage.policyHash !== policy.policyHash) throw new Error('RUN_POLICY_RESUME_CONFLICT');
  const context = { policy: freezePolicy(structuredClone(policy)), usage, journalPath };
  persist(context);
  return context;
}
function persist(context: RunContext): void {
  if (!context.journalPath) return;
  fs.mkdirSync(path.dirname(context.journalPath), { recursive: true });
  const temporary = `${context.journalPath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ policy: context.policy, usage: context.usage }), { mode: 0o600 });
  fs.renameSync(temporary, context.journalPath);
}
export function withRunContext<T>(context: RunContext | undefined, action: () => T): T { return context ? storage.run(context, action) : action(); }
export function recordRunEvent(event: Record<string, unknown>): void {
  const context = storage.getStore();
  if (!context) return;
  context.usage.events.push({ at: new Date().toISOString(), ...event });
  persist(context);
}
/** A guard intervened (blocked a call, ended the turn, corrected or flagged an answer): counted and logged. */
export function recordGuardEvent(guard: string, details: Record<string, unknown>): void {
  const context = storage.getStore();
  if (!context) return;
  context.usage.guards = { ...context.usage.guards, [guard]: (context.usage.guards?.[guard] ?? 0) + 1 };
  recordRunEvent({ kind: 'guard', guard, ...details });
}
export function requestRecovery(reason: string): void {
  const context = storage.getStore();
  if (!context) return;
  const used = context.usage.recoveriesUsed ?? context.usage.recoveries;
  if (!context.policy.repair.enabled || used >= context.policy.repair.maxRecoveriesPerTurn) {
    throw new Error('RECOVERY_BUDGET_EXHAUSTED: LLM-only hint: stop automatic fallbacks. Describe the blocked operation and the specific input needed. Never mention budgets or ask for a new message. / 仅供模型：停止自动回退，说明受阻操作及所需具体输入，不提预算或要求另发消息。');
  }
  context.usage.recoveries++;
  context.usage.recoveriesUsed = used + 1;
  recordRunEvent({ kind: 'recovery', reason, recovery: context.usage.recoveries });
}
export function canRecover(): boolean {
  const context = storage.getStore();
  return !context || context.policy.repair.enabled && (context.usage.recoveriesUsed ?? context.usage.recoveries) < context.policy.repair.maxRecoveriesPerTurn;
}

/** New user evidence permits fresh fallback attempts without erasing the run's audit totals. */
export function resetClarificationRecovery(context: RunContext): void {
  context.usage.recoveriesUsed = 0;
  context.usage.pendingFailures = Object.fromEntries(Object.entries(context.usage.pendingFailures)
    .filter(([, value]) => value.includes('SOLVER_OUTCOME_UNKNOWN')));
  withRunContext(context, () => recordRunEvent({ kind: 'clarification_resume', recoveriesUsed: 0 }));
}
export function reserveLlmCall(model: string): string | undefined {
  const context = storage.getStore();
  if (!context) return undefined;
  const limit = context.policy.budgets.maxLlmCallsPerTurn;
  if (limit !== null && context.usage.llmCalls >= limit) throw new Error('LLM_CALL_BUDGET_EXHAUSTED');
  context.usage.llmCalls++;
  const callId = randomUUID();
  recordRunEvent({ kind: 'llm_started', callId, model });
  return callId;
}
function recoveryGroup(tool: string): string {
  if (['detect_structure_type', 'extract_draft_params', 'build_model', 'validate_model', 'edit_model', 'undo_model'].includes(tool)) return 'model';
  return tool;
}
export function reserveToolCall(name: string, callId: string): void {
  const context = storage.getStore();
  if (!context) return;
  if (!context.policy.activeToolIds.includes(name)) throw new Error(`TOOL_NOT_ALLOWED: ${name}`);
  if (context.usage.startedToolCallIds.includes(callId)) {
    if (name === 'ask_user_clarification') return;
    throw new Error('TOOL_OUTCOME_UNKNOWN: an already started operation cannot be automatically reissued');
  }
  if (context.usage.toolCalls >= context.policy.budgets.maxToolCallsPerTurn) throw new Error('TOOL_CALL_BUDGET_EXHAUSTED');
  const group = recoveryGroup(name);
  if (context.usage.pendingFailures.model && ['run_analysis', 'run_code_check', 'generate_report'].includes(name)) throw new Error('UNRESOLVED_MODEL_FAILURE');
  if (['run_analysis', 'run_code_check'].includes(group) && Object.values(context.usage.pendingFailures).some(value => value.includes('SOLVER_OUTCOME_UNKNOWN'))) throw new Error('SOLVER_OUTCOME_UNKNOWN: inspect the recorded job before starting another solve');
  // A failed solve or query cannot be "repaired" by switching to a modeling tool.
  // Read-only inspection and clarification remain available in this same run;
  // only a new user turn creates a fresh failure ledger.
  if (!context.policy.repair.enabled && Object.keys(context.usage.pendingFailures).length > 0
    && (context.usage.pendingFailures[group] || group === 'model' || ['review_input', 'set_session_config', 'run_analysis', 'run_code_check'].includes(name))) {
    throw new Error('RECOVERY_BUDGET_EXHAUSTED: automatic repair is disabled; after a failure, inspect existing state or ask the user before changing the model/settings or starting another calculation. / 自动纠错已关闭；本回合发生失败后，只可检查已有状态或请求用户补充，不能自动修改模型、设置或重新计算。');
  }
  // Tool feedback is ordinary agent work. Only system-triggered fallbacks call
  // requestRecovery; identical failing calls are limited by the tool guard.
  delete context.usage.pendingFailures[group];
  context.usage.toolCalls++;
  context.usage.startedToolCallIds.push(callId);
  recordRunEvent({ kind: 'tool_started', name, callId });
}
export function recordToolOutcome(name: string, callId: string, failure?: string): void {
  const context = storage.getStore();
  if (!context) return;
  if (failure) context.usage.pendingFailures[recoveryGroup(name)] = failure;
  recordRunEvent({ kind: 'tool_finished', name, callId, success: !failure, ...(failure ? { failure } : {}) });
}
