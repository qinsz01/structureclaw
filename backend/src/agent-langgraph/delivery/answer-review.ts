/**
 * Final-answer integrity review against structured state (guard layer, docs/agent-architecture.md).
 *
 * Evidence for numbers: the user's messages (inputs), every tool result in the conversation and
 * the saved model, draft, analysis, code-check, report and queried quantities; placeholder-stiffness
 * runs count without their displacements. Claimed actions are supported only by the current state:
 * a current analysis, a report of that run, a passing code check of that run.
 */
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentState } from '../state.js';
import { extractMessageText, getMessageType } from '../message-inspect.js';
import { currentAnalysisError, isRecord, type ModelState } from '../../engineering/model-state.js';
import { withoutPlaceholderDisplacements } from '../../engineering/stiffness-placeholder.js';
import { buildEvidence, derivedInputNumbers, quantitySums, findActionClaims, findUnsupportedNumbers, type ClaimedAction, type UnitNumber } from './answer-integrity.js';

export interface AnswerReview { numbers: UnitNumber[]; actions: Array<{ action: ClaimedAction; text: string }> }

const MAX_LISTED = 8;

export function hasIntegrityIssues(review: AnswerReview): boolean {
  return review.numbers.length > 0 || review.actions.length > 0;
}

const runIdOf = (artifact: unknown): unknown => {
  const record = isRecord(artifact) ? artifact : {};
  const meta = isRecord(record.meta) ? record.meta : isRecord(record.json) && isRecord(record.json.meta) ? record.json.meta : {};
  return meta.runId;
};

function actionSupported(action: ClaimedAction, state: Partial<AgentState>): boolean {
  const runId = currentAnalysisError(state as ModelState) ? undefined : state.analysisResult?.runId;
  if (runId === undefined) return false;
  if (action === 'analysis') return true;
  if (action === 'report') return runIdOf(state.report) === runId;
  return runIdOf(state.codeCheckResult) === runId && state.codeCheckResult?.complianceStatus === 'pass';
}

const presented = (run: unknown) => isRecord(run) ? withoutPlaceholderDisplacements(run) : run;

export function reviewFinalAnswer(input: { text: string; state: Partial<AgentState>; messages: BaseMessage[]; currentTurnMessages: BaseMessage[] }): AnswerReview {
  const { text, state, messages, currentTurnMessages } = input;
  const actions = findActionClaims(text).filter(claim => !actionSupported(claim.action, state));
  const toolBacked = currentTurnMessages.some(message => getMessageType(message) === 'tool')
    || Boolean(state.analysisResult || state.codeCheckResult || state.report);
  if (!toolBacked) return { numbers: [], actions };
  const userTexts = messages.flatMap(message => {
    if (getMessageType(message) === 'human') return [extractMessageText(message)];
    if (getMessageType(message) !== 'tool') return [];
    try {
      const payload = JSON.parse(extractMessageText(message));
      return payload.type === 'clarification_answered' && typeof payload.answer === 'string' ? [payload.answer] : [];
    } catch { return []; }
  });
  const evidence = buildEvidence([
    ...messages.filter(message => ['human', 'tool'].includes(getMessageType(message) ?? '')).map(extractMessageText),
    derivedInputNumbers(userTexts),
    quantitySums(Object.values(state.resultQuantities ?? {}).map(quantity => Number(quantity.value))),
    state.model, state.draftState, presented(state.analysisResult), state.codeCheckResult, state.report,
    state.resultQuantities, Object.values(state.analysisRuns ?? {}).map(presented), state.inputEvidence,
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
    en.push(`these quantities have not yet been verified against tool results or saved results (a derived quantity may still be correct): ${listedNumbers(review, '; ')}`);
    zh.push(`以下数值尚未通过工具结果或已保存结果核实（推导量仍可能正确）：${listedNumbers(review, '；')}`);
  }
  for (const claim of review.actions) {
    en.push(ACTION_TEXT[claim.action].en);
    zh.push(ACTION_TEXT[claim.action].zh);
  }
  return [
    `[StructureClaw answer check] Your final answer was not delivered because ${en.join('; and ')}.`,
    'Verify the quantities before answering: query_results retrieves saved responses; calculate, when available, verifies derived totals, differences, ratios and formulas using user- or tool-backed operands. Preserve a valid derived quantity after verification instead of silently deleting it. Do not claim actions that did not succeed. User inputs may stay. If verification is unavailable, state that limitation. Do not mention this internal check or apologize.',
    `[StructureClaw 回答核对] 最终回答未交付，原因：${zh.join('；')}。`,
    '请先核实再回答：query_results 用于查询已保存响应；calculate 可用时，用用户输入或工具结果作为操作数，核实推导总量、差值、比值及公式。核实后保留合法推导量，不要直接删掉。不要声称未成功执行的操作；用户输入可以保留。无法核实时说明限制，不提及本次内部核对，不道歉。',
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
