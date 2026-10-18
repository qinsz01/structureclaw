/**
 * Final-answer integrity review against structured state (guard layer, docs/agent-architecture.md).
 *
 * Evidence for numbers: the user's messages (inputs), every tool result in the conversation and
 * the saved model, draft, analysis, code-check, report and queried quantities. Claimed actions
 * are supported only by a successful tool result in this turn or by the saved artifact.
 */
import type { BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { AgentState } from '../state.js';
import { extractMessageText, getMessageType, getToolName } from '../message-inspect.js';
import { toolMessageFailure } from '../../utils/tool-outcome.js';
import { buildEvidence, derivedInputNumbers, findActionClaims, findUnsupportedNumbers, type ClaimedAction, type UnitNumber } from './answer-integrity.js';

export interface AnswerReview { numbers: UnitNumber[]; actions: Array<{ action: ClaimedAction; text: string }> }

const MAX_LISTED = 8;

export function hasIntegrityIssues(review: AnswerReview): boolean {
  return review.numbers.length > 0 || review.actions.length > 0;
}

function succeededThisTurn(turn: BaseMessage[], tool: string): boolean {
  return turn.some(message => getMessageType(message) === 'tool' && getToolName(message) === tool && !toolMessageFailure(message as ToolMessage));
}

function actionSupported(action: ClaimedAction, state: Partial<AgentState>, turn: BaseMessage[]): boolean {
  if (action === 'report') return succeededThisTurn(turn, 'generate_report') || Boolean(state.report);
  if (action === 'analysis') return succeededThisTurn(turn, 'run_analysis') || Boolean(state.analysisResult && state.analysisResult.success !== false);
  // Per-member statements ("B1 passes") are legitimate even when the overall status is fail.
  return Boolean(state.codeCheckResult);
}

export function reviewFinalAnswer(input: { text: string; state: Partial<AgentState>; messages: BaseMessage[]; currentTurnMessages: BaseMessage[] }): AnswerReview {
  const { text, state, messages, currentTurnMessages } = input;
  const actions = findActionClaims(text).filter(claim => !actionSupported(claim.action, state, currentTurnMessages));
  const toolBacked = currentTurnMessages.some(message => getMessageType(message) === 'tool')
    || Boolean(state.analysisResult || state.codeCheckResult || state.report);
  if (!toolBacked) return { numbers: [], actions };
  const userTexts = messages.filter(message => getMessageType(message) === 'human').map(extractMessageText);
  const evidence = buildEvidence([
    ...messages.filter(message => ['human', 'tool'].includes(getMessageType(message) ?? '')).map(extractMessageText),
    derivedInputNumbers(userTexts),
    state.model, state.draftState, state.analysisResult, state.codeCheckResult, state.report,
    state.resultQuantities, state.analysisRuns, state.inputEvidence,
  ]);
  return { numbers: findUnsupportedNumbers(text, evidence), actions };
}

const ACTION_TEXT: Record<ClaimedAction, { zh: string; en: string }> = {
  report: { zh: '回答称已生成报告，但本轮没有成功生成报告，也没有已保存的报告', en: 'it says a report was generated, but no report was generated successfully in this turn and none is saved' },
  analysis: { zh: '回答称已完成分析，但本轮没有成功的分析，也没有已保存的分析结果', en: 'it says an analysis was run, but no analysis succeeded in this turn and no analysis result is saved' },
  'check-passed': { zh: '回答称校核通过，但没有已保存的通过的规范校核结果', en: 'it says the checks passed, but no saved code-check result supports a pass' },
};

function listedNumbers(review: AnswerReview, separator: string): string {
  return [...new Set(review.numbers.map(item => item.raw))].slice(0, MAX_LISTED).join(separator);
}

/** One-time correction request sent to the LLM (bilingual, not persisted). */
export function buildCorrectionPrompt(review: AnswerReview): string {
  const en: string[] = [], zh: string[] = [];
  if (review.numbers.length) {
    en.push(`these result values match no tool result of this turn and no saved result: ${listedNumbers(review, '; ')}`);
    zh.push(`以下结果数值与本轮工具结果和已保存结果均不一致：${listedNumbers(review, '；')}`);
  }
  for (const claim of review.actions) {
    en.push(ACTION_TEXT[claim.action].en);
    zh.push(ACTION_TEXT[claim.action].zh);
  }
  return [
    `[StructureClaw answer check] Your final answer was not delivered because ${en.join('; and ')}.`,
    'Rewrite the final answer: use only values returned by tools (call query_results if a value is still needed) and do not claim actions that did not succeed. Values the user gave as inputs may stay. Do not mention this check, do not apologize and do not repeat the removed values.',
    `[StructureClaw 回答核对] 最终回答未交付，原因：${zh.join('；')}。`,
    '请重写最终回答：只使用工具返回的数值（仍需数值时调用 query_results），不要声称未成功执行的操作；用户给出的输入值可以保留。不要提及本次核对、不要道歉，也不要复述被删除的数值。',
  ].join('\n');
}

/** Note appended to an answer that still fails the review (locale-selected). */
export function buildIntegrityNote(review: AnswerReview, locale: 'zh' | 'en'): string {
  const lines: string[] = [];
  if (locale === 'zh') {
    if (review.numbers.length) lines.push(`以下数值未能与本轮工具结果或已保存结果核对一致，请勿直接采用：${listedNumbers(review, '、')}。`);
    for (const claim of review.actions) lines.push(`${ACTION_TEXT[claim.action].zh}。`);
    return `\n\n---\n注意（结果核对）：${lines.join('')}`;
  }
  if (review.numbers.length) lines.push(`these values could not be verified against this turn's tool results or saved results; do not rely on them: ${listedNumbers(review, ', ')}.`);
  for (const claim of review.actions) lines.push(`${ACTION_TEXT[claim.action].en}.`);
  return `\n\n---\nNote (result check): ${lines.join(' ')}`;
}
