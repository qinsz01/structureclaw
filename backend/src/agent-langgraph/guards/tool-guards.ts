/**
 * Generic guards around LLM tool scheduling (docs/agent-architecture.md, "Guard layer").
 *
 * The LLM decides which tool to call and when to stop. These guards only intervene when that
 * scheduling is unreasonable: the same call keeps failing with the same error, many calls make
 * no state progress, the same clarification is asked again after it was answered, or the call
 * names an unknown tool or carries unparseable arguments. A guarded call is not executed; the
 * LLM receives a structured error that says why and what to change. Repeated guard rejections
 * or a long run without progress end the turn with an honest partial answer.
 *
 * The ledger is per run context (one user turn, or one resumed segment of it) and is not
 * persisted; only guard interventions are written to the run record (`kind: 'guard'`) and
 * counted in `usage.guards`.
 */
import { createHash } from 'node:crypto';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunContext } from '../../runtime/run-context.js';
import { recordGuardEvent } from '../../runtime/run-context.js';
import { extractMessageText, getMessageType, getToolName } from '../message-inspect.js';
import { contentHash } from '../../engineering/model-record.js';
import { hasExtractedCurrentInput } from '../tools/input-message.js';

/** Identical call (tool + normalized arguments) failing with the same error code this many times is not executed again. */
export const REPEATED_FAILURE_LIMIT = 2;
/** Consecutive tool calls without state progress or new information before the turn is ended. */
export const NO_PROGRESS_LIMIT = 8;
/** Guard rejections in one turn before it is ended (1 when automatic repair is disabled). */
export const GUARD_BLOCK_STOP_LIMIT = 2;
/** Marker placed in the arguments of a provider tool call whose arguments were not valid JSON. */
export const MALFORMED_ARGUMENTS_KEY = '__malformedArguments';

export type GuardKind = 'repeated-failure' | 'duplicate-clarification' | 'no-progress' | 'guard-stop'
  | 'unknown-tool' | 'malformed-arguments' | 'missing-tool-call-id' | 'duplicate-extraction';

export interface GuardStop { reason: 'repeated-blocks' | 'no-progress'; calls: number }
interface FailureRecord { tool: string; code: string; count: number }
export interface GuardLedger {
  failures: Map<string, FailureRecord>;
  successSignatures: Set<string>;
  noProgressStreak: number;
  blocked: Array<{ guard: GuardKind; tool: string; code: string }>;
  failed: Array<{ tool: string; code: string }>;
  stop?: GuardStop;
  answerCorrections: number;
  /** A correction was requested and the answer that resolves it has not been delivered yet. */
  answerCorrectionPending: boolean;
}

const ledgers = new WeakMap<RunContext, GuardLedger>();

/** A clarification answer is new evidence; rejection/progress streaks start afresh. */
export function resetClarificationGuards(context: RunContext): void { ledgers.delete(context); }

/** Guard bookkeeping of a run; guards are inactive for direct tool hosts without a run context. */
export function guardLedger(context: RunContext | undefined): GuardLedger | undefined {
  if (!context) return undefined;
  let ledger = ledgers.get(context);
  if (!ledger) {
    ledger = { failures: new Map(), successSignatures: new Set(), noProgressStreak: 0, blocked: [], failed: [], answerCorrections: 0, answerCorrectionPending: false };
    ledgers.set(context, ledger);
  }
  return ledger;
}

function normalizeArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeArgs);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && item !== null && item !== '')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalizeArgs(item)]);
    return Object.fromEntries(entries);
  }
  return typeof value === 'string' ? value.trim() : value;
}

/** Tool name plus semantically normalized arguments (key order, blanks and empty values ignored). */
export function callSignature(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(normalizeArgs(args ?? {}))}`;
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,}\b/;
const SCHEMA_ERROR = 'Received tool input did not match expected schema';

/** Stable error code of a failed tool result: explicit code, a leading CODE token, or a short text hash. */
export function failureCode(failure: string): string {
  const text = failure.replace(/^Error:\s*/, '').trim();
  if (text.includes(SCHEMA_ERROR)) return 'INVALID_TOOL_ARGUMENTS';
  const match = CODE_PATTERN.exec(text);
  if (match) return match[0];
  return `TOOL_FAILED_${createHash('sha1').update(text.slice(0, 200)).digest('hex').slice(0, 8)}`;
}

function guardError(errorCode: string, guard: GuardKind, error: string, hint: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ success: false, errorCode, guard, error, hint, ...extra });
}

function block(ledger: GuardLedger, guard: GuardKind, tool: string, code: string, repairEnabled: boolean, details: Record<string, unknown>,
  countsTowardStop = true): void {
  if (countsTowardStop) ledger.blocked.push({ guard, tool, code });
  ledger.noProgressStreak += 1;
  recordGuardEvent(guard, { action: 'blocked', tool, code, ...details });
  const limit = repairEnabled ? GUARD_BLOCK_STOP_LIMIT : 1;
  if (!ledger.stop && ledger.blocked.length >= limit) {
    ledger.stop = { reason: 'repeated-blocks', calls: ledger.blocked.length };
    recordGuardEvent('guard-stop', { action: 'end-turn', reason: 'repeated-blocks', blocked: ledger.blocked.length });
  }
}

export interface PreflightInput {
  call: { name: string; args?: Record<string, unknown> };
  toolNames: string[];
  messages: BaseMessage[];
  ledger: GuardLedger | undefined;
  repairEnabled: boolean;
  /** clarificationStateToken of the current state; a question asked under another state may be asked again. */
  stateToken?: string;
}

/**
 * `blocked`: a guard refused a call the LLM was told to change (counts toward ending the turn).
 * `rejected`: the call is invalid (unknown tool, malformed arguments) and counts as a failed call.
 * `skipped`: the turn is already being ended; the call is acknowledged without execution.
 */
export interface PreflightRejection { kind: 'blocked' | 'rejected' | 'skipped'; content: string }

/**
 * Structured rejection for a call that must not execute, or undefined to execute it.
 * Unknown tools and malformed arguments are rejected even without a run context.
 */
export function preflightToolCall(input: PreflightInput): PreflightRejection | undefined {
  const { call, toolNames, ledger, repairEnabled } = input;
  if (ledger?.stop) {
    return { kind: 'skipped', content: guardError('TURN_STOPPED_BY_GUARD', 'guard-stop',
      'This turn was stopped by the StructureClaw guard; the call was not executed. / 本轮已被防护机制停止，该调用未执行。',
      'Summarize the available results and what is blocked. / 请总结已有结果和受阻事项。', { skipped: true }) };
  }
  const args = call.args ?? {};
  const previous = ledger?.failures.get(callSignature(call.name, args));
  if (ledger && previous && previous.count >= REPEATED_FAILURE_LIMIT) {
    block(ledger, 'repeated-failure', call.name, previous.code, repairEnabled, { failures: previous.count });
    return { kind: 'blocked', content: guardError('REPEATED_FAILED_CALL', 'repeated-failure',
      `This exact ${call.name} call already failed ${previous.count} times with ${previous.code}; it was not executed again. / 完全相同的 ${call.name} 调用已因 ${previous.code} 失败 ${previous.count} 次，本次未再执行。`,
      'Change the arguments according to the earlier error, use a different tool to obtain what is missing, or stop and tell the user what is blocked. / 请根据先前错误修改参数、改用其他工具获取缺失信息，或停止并向用户说明受阻原因。',
      { previousErrorCode: previous.code, previousFailures: previous.count }) };
  }
  if (typeof args[MALFORMED_ARGUMENTS_KEY] === 'string') {
    recordGuardEvent('malformed-arguments', { action: 'rejected', tool: call.name });
    return { kind: 'rejected', content: guardError('MALFORMED_TOOL_ARGUMENTS', 'malformed-arguments',
      `The arguments of ${call.name} were not valid JSON and the call was not executed. / ${call.name} 的参数不是有效 JSON，调用未执行。`,
      'Resend the call with a complete JSON object that matches the tool schema. / 请按工具参数结构重新发送完整的 JSON 对象。',
      { receivedArguments: String(args[MALFORMED_ARGUMENTS_KEY]).slice(0, 300) }) };
  }
  if (call.name === 'extract_draft_params' && hasExtractedCurrentInput(input.messages)) {
    if (ledger) block(ledger, 'duplicate-extraction', call.name, 'INPUT_ALREADY_EXTRACTED', repairEnabled, {});
    return { kind: 'blocked', content: guardError('INPUT_ALREADY_EXTRACTED', 'duplicate-extraction',
      'This user input was already extracted; no extraction was executed again. / 当前用户输入已提取，本次没有重复执行。',
      'Use the saved draft and its missing-field diagnostics. Ask for missing facts or section confirmation; extraction becomes available with a new user answer. / 请使用已保存草稿及缺项诊断，询问缺少的事实或确认截面；收到新答复后可再次提取。',
      { nextAction: 'use_current_draft' }) };
  }
  if (!toolNames.includes(call.name)) {
    recordGuardEvent('unknown-tool', { action: 'rejected', tool: call.name });
    return { kind: 'rejected', content: guardError('UNKNOWN_TOOL', 'unknown-tool',
      `Tool ${JSON.stringify(call.name)} is not available in this run; nothing was executed. / 本次运行没有工具 ${JSON.stringify(call.name)}，未执行任何操作。`,
      'Use one of availableTools, or answer without a tool. / 请使用 availableTools 中的工具，或不调用工具直接回答。', { availableTools: [...toolNames].sort() }) };
  }
  if (ledger && call.name === 'ask_user_clarification' && typeof args.question === 'string') {
    const answered = findAnsweredClarification(args.question, input.messages, input.stateToken);
    if (answered) {
      // An answer inferred from the next user message (external host) may be a new instruction: no turn stop.
      block(ledger, 'duplicate-clarification', call.name, 'DUPLICATE_CLARIFICATION', repairEnabled, { answerSource: answered.source },
        answered.source === 'tool');
      return { kind: 'blocked', content: guardError('DUPLICATE_CLARIFICATION', 'duplicate-clarification',
        'The user already answered this question; it was not asked again. / 用户已回答过该问题，未重复提问。',
        'Use the stored answer (for example pass it to extract_draft_params or edit_model). If it is insufficient, ask a different, more specific question that names what is still missing. / 请使用已保存的回答（例如传给 extract_draft_params 或 edit_model）；若回答不足，请换一个更具体的问题说明仍缺什么。',
        { previousQuestion: answered.question, storedAnswer: answered.answer }) };
    }
  }
  return undefined;
}

/** Records the outcome of an executed call; sets `ledger.stop` after too many calls without progress. */
export function recordToolResult(ledger: GuardLedger | undefined, call: { name: string; args?: Record<string, unknown> },
  failure: string | undefined, stateChanged: boolean): void {
  if (!ledger) return;
  const signature = callSignature(call.name, call.args);
  let isNewInformation = false;
  if (failure) {
    const code = failureCode(failure);
    const previous = ledger.failures.get(signature);
    ledger.failures.set(signature, { tool: call.name, code, count: previous?.code === code ? previous.count + 1 : 1 });
    ledger.failed.push({ tool: call.name, code });
  } else {
    ledger.failures.delete(signature);
    isNewInformation = call.name !== 'extract_draft_params' && !ledger.successSignatures.has(signature);
    ledger.successSignatures.add(signature);
  }
  // A state change can remove the cause of earlier failures: identical retries become legitimate again.
  if (stateChanged) {
    const own = failure ? ledger.failures.get(signature) : undefined;
    ledger.failures.clear();
    if (own) ledger.failures.set(signature, { ...own, count: 1 });
  }
  ledger.noProgressStreak = stateChanged || isNewInformation ? 0 : ledger.noProgressStreak + 1;
  if (!ledger.stop && ledger.noProgressStreak >= NO_PROGRESS_LIMIT) {
    ledger.stop = { reason: 'no-progress', calls: ledger.noProgressStreak };
    recordGuardEvent('no-progress', { action: 'end-turn', calls: ledger.noProgressStreak, lastTool: call.name });
  }
}

// ---------------------------------------------------------------------------
// Duplicate clarification
// ---------------------------------------------------------------------------

const DUPLICATE_SIMILARITY = 0.8;

function normalizeQuestion(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    result.set(pair, (result.get(pair) ?? 0) + 1);
  }
  return result;
}

/** Dice coefficient of character bigrams on normalized text (1 = identical). */
export function questionSimilarity(a: string, b: string): number {
  const left = normalizeQuestion(a), right = normalizeQuestion(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftPairs = bigrams(left), rightPairs = bigrams(right);
  let overlap = 0;
  for (const [pair, count] of leftPairs) overlap += Math.min(count, rightPairs.get(pair) ?? 0);
  const total = Math.max(left.length - 1, 0) + Math.max(right.length - 1, 0);
  return total ? 2 * overlap / total : 0;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** Start of the previous user turn: duplicates are checked within the current and the previous turn. */
function previousTurnStart(messages: BaseMessage[]): number {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (getMessageType(messages[index]!) === 'human' && ++seen === 2) return index;
  }
  return 0;
}

/** Model revision and draft a clarification was asked under (recorded in the clarification tool result). */
export function clarificationStateToken(state: { modelRevision?: number; draftState?: { inferredType?: unknown; engineeringDraft?: unknown } | null } | undefined): string {
  return contentHash({ modelRevision: state?.modelRevision ?? 0, inferredType: state?.draftState?.inferredType ?? null,
    engineeringDraft: state?.draftState?.engineeringDraft ?? null });
}

/**
 * An earlier clarification with a non-empty answer whose question matches `question`. When both the
 * earlier result and the caller give a state token and they differ, the model or draft changed since
 * that question, so it is not a duplicate.
 */
export function findAnsweredClarification(question: string, messages: BaseMessage[], stateToken?: string): { question: string; answer: string; source: 'tool' | 'next-message' } | undefined {
  const start = previousTurnStart(messages);
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index]!;
    if (getMessageType(message) !== 'tool' || getToolName(message) !== 'ask_user_clarification') continue;
    const payload = parseJson(extractMessageText(message));
    if (!payload || typeof payload.question !== 'string') continue;
    if (questionSimilarity(payload.question, question) < DUPLICATE_SIMILARITY) continue;
    if (stateToken && typeof payload.stateToken === 'string' && payload.stateToken !== stateToken) return undefined;
    let answer = payload.type === 'clarification_answered' && typeof payload.answer === 'string' ? payload.answer : '';
    if (payload.type === 'clarification_needed') {
      // Externally hosted dialogue: the answer arrives as the next user message.
      const reply = messages.slice(index + 1).find(item => getMessageType(item) === 'human');
      answer = reply ? extractMessageText(reply) : '';
    }
    if (answer.trim()) {
      // An answered question is not necessarily a satisfied requirement. Inspect the
      // extraction of this answer, stopping at the next answer/turn boundary.
      let externalReplySeen = payload.type !== 'clarification_needed';
      for (const next of messages.slice(index + 1)) {
        if (getMessageType(next) === 'human') {
          if (externalReplySeen) break;
          externalReplySeen = true;
        }
        if (getMessageType(next) !== 'tool') continue;
        if (getToolName(next) === 'ask_user_clarification') break;
        if (getToolName(next) !== 'extract_draft_params') continue;
        const result = parseJson(extractMessageText(next));
        if (result?.status === 'no_change' || Array.isArray(result?.unapplied) && result.unapplied.length) return undefined;
      }
      return { question: payload.question, answer: answer.trim(), source: payload.type === 'clarification_answered' ? 'tool' : 'next-message' };
    }
  }
  return undefined;
}
