/**
 * Final-answer guard: integrity review with one correction chance, then an honest flag.
 *
 * Runs only on an LLM-written final answer (no tool calls, not replaced by the delivery policy).
 * Unsupported result numbers or claimed actions trigger one correction request to the LLM when
 * automatic repair is enabled (`repair.enabled`; the no-repair profile goes straight to the flag).
 * If the corrected answer still fails, a note listing the unverified values is appended. An
 * answer cut off by the provider's output limit gets a truncation note.
 */
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { Logger } from 'pino';
import type { AgentState } from '../state.js';
import { extractMessageText } from '../message-inspect.js';
import { recordGuardEvent } from '../../runtime/run-context.js';
import type { GuardLedger } from '../guards/tool-guards.js';
import { buildCorrectionPrompt, buildIntegrityNote, hasIntegrityIssues, reviewFinalAnswer, type AnswerReview } from './answer-review.js';

/** One correction request per turn. */
export const MAX_ANSWER_CORRECTIONS = 1;
const TRUNCATION_REASONS = new Set(['length', 'max_tokens', 'MAX_TOKENS']);

export interface FinalReviewInput {
  response: BaseMessage;
  finishReason?: string;
  state: AgentState;
  messages: BaseMessage[];
  currentTurnMessages: BaseMessage[];
  ledger: GuardLedger | undefined;
  repairEnabled: boolean;
  log: Logger;
  /** Ask the LLM again with the draft answer and the correction prompt appended (not persisted). */
  reinvoke: (draft: BaseMessage, prompt: string) => Promise<{ response: BaseMessage; finishReason?: string }>;
  /** Tool-call repair plus the delivery policy for a new response; returns the message to deliver. */
  deliver: (response: BaseMessage) => { message: BaseMessage; final: boolean };
}

function withText(source: BaseMessage, content: string): AIMessage {
  const fields = source as unknown as Record<string, unknown>;
  return new AIMessage({ content,
    ...(typeof fields.id === 'string' ? { id: fields.id } : {}),
    ...(fields.response_metadata ? { response_metadata: fields.response_metadata as Record<string, unknown> } : {}),
    ...(fields.usage_metadata ? { usage_metadata: fields.usage_metadata as AIMessage['usage_metadata'] } : {}) });
}

function truncationNote(locale: 'zh' | 'en'): string {
  return locale === 'zh'
    ? '\n\n（注意：模型输出达到长度上限，以上回答可能不完整。）'
    : '\n\n(Note: the model output reached its length limit; the answer above may be incomplete.)';
}

function finish(message: BaseMessage, finishReason: string | undefined, locale: 'zh' | 'en', extra = ''): BaseMessage {
  const truncated = finishReason !== undefined && TRUNCATION_REASONS.has(finishReason);
  if (truncated) recordGuardEvent('truncated-final-answer', { action: 'noted', finishReason });
  if (!truncated && !extra) return message;
  return withText(message, `${extractMessageText(message)}${extra}${truncated ? truncationNote(locale) : ''}`);
}

function summary(review: AnswerReview): Record<string, unknown> {
  return { numbers: review.numbers.map(item => item.raw).slice(0, 8), actions: review.actions.map(item => item.action) };
}

export async function reviewAndDeliverFinalAnswer(input: FinalReviewInput): Promise<BaseMessage> {
  const { state, ledger, log } = input;
  const locale = state.locale === 'en' ? 'en' : 'zh';
  const review = (text: string) => reviewFinalAnswer({ text, state, messages: input.messages, currentTurnMessages: input.currentTurnMessages });
  const draft = extractMessageText(input.response);
  const first = review(draft);
  if (!hasIntegrityIssues(first)) {
    // The correction went through tool calls (e.g. query_results) before this clean answer.
    if (ledger?.answerCorrectionPending) {
      ledger.answerCorrectionPending = false;
      recordGuardEvent('answer-integrity', { action: 'corrected' });
    }
    return finish(input.response, input.finishReason, locale);
  }

  let current = { response: input.response, finishReason: input.finishReason, review: first };
  const canCorrect = Boolean(ledger) && input.repairEnabled && (ledger?.answerCorrections ?? 0) < MAX_ANSWER_CORRECTIONS;
  if (canCorrect && ledger) {
    ledger.answerCorrections += 1;
    ledger.answerCorrectionPending = true;
    recordGuardEvent('answer-integrity', { action: 'correction-requested', ...summary(first) });
    log.warn({ node: 'agent', ...summary(first) }, 'final answer integrity: correction requested');
    let retried: { response: BaseMessage; finishReason?: string } | undefined;
    try {
      retried = await input.reinvoke(input.response, buildCorrectionPrompt(first));
    } catch (error) {
      // The correction is advisory: a provider or budget failure keeps the draft, flagged below.
      log.warn({ node: 'agent', err: error }, 'final answer integrity: correction request failed');
    }
    const retriedText = retried ? extractMessageText(retried.response).trim() : '';
    const delivered = retried ? input.deliver(retried.response) : undefined;
    // A tool call (e.g. query_results) continues the turn; a policy notice ends it normally.
    // An empty retry keeps the original draft (flagged) instead of the generic empty-answer fallback.
    if (retried && delivered && (!delivered.final || (retriedText && delivered.message !== retried.response))) return delivered.message;
    const second = retried && retriedText ? review(retriedText) : first;
    if (retried && retriedText && !hasIntegrityIssues(second)) {
      ledger.answerCorrectionPending = false;
      recordGuardEvent('answer-integrity', { action: 'corrected' });
      return finish(retried.response, retried.finishReason, locale);
    }
    if (retried && retriedText) current = { response: retried.response, finishReason: retried.finishReason, review: second };
  }
  if (ledger) ledger.answerCorrectionPending = false;
  recordGuardEvent('answer-integrity', { action: 'flagged', ...summary(current.review) });
  log.warn({ node: 'agent', ...summary(current.review) }, 'final answer integrity: unverified content flagged');
  return finish(current.response, current.finishReason, locale, buildIntegrityNote(current.review, locale));
}
