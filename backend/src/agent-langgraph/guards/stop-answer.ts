/**
 * Honest partial answer delivered when a guard ends the turn (tool-guards.ts): what completed,
 * which results are available now, and what is blocked. Built from structured state and the
 * guard ledger only; nothing is inferred from model prose.
 */
import type { BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { AgentState } from '../state.js';
import { getMessageType, getToolName } from '../message-inspect.js';
import { toolMessageFailure } from '../../utils/tool-outcome.js';
import type { GuardLedger, GuardStop } from './tool-guards.js';

type Locale = 'zh' | 'en';

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function completedTools(messages: BaseMessage[]): string[] {
  return unique(messages.filter(message => getMessageType(message) === 'tool' && !toolMessageFailure(message as ToolMessage))
    .map(message => getToolName(message) ?? ''));
}

function availableResults(state: Partial<AgentState>, locale: Locale): string[] {
  const items: string[] = [];
  const zh = locale === 'zh';
  if (state.model && !state.modelPending) items.push(zh ? `模型（版本 ${state.modelRevision ?? 0}）` : `model (revision ${state.modelRevision ?? 0})`);
  const runId = state.analysisResult && typeof state.analysisResult.runId === 'string' ? state.analysisResult.runId : undefined;
  if (runId) items.push(zh ? `分析结果（运行 ${runId}）` : `analysis results (run ${runId})`);
  if (state.report) items.push(zh ? '报告' : 'report');
  const check = state.codeCheckResult;
  if (check) items.push(zh ? `规范校核（${String(check.completionStatus ?? '-')}/${String(check.complianceStatus ?? '-')}）`
    : `code check (${String(check.completionStatus ?? '-')}/${String(check.complianceStatus ?? '-')})`);
  return items;
}

function blockedItems(ledger: GuardLedger): string[] {
  const failures = [...ledger.blocked, ...ledger.failed].map(item => `${item.tool} (${item.code})`);
  return unique(failures).slice(0, 8);
}

/** Bilingual (locale-selected) partial answer for a guard-ended turn. */
export function buildGuardStopAnswer(stop: GuardStop, ledger: GuardLedger, state: Partial<AgentState>,
  currentTurnMessages: BaseMessage[], locale: Locale): string {
  const done = completedTools(currentTurnMessages);
  const available = availableResults(state, locale);
  const blocked = blockedItems(ledger);
  if (locale === 'zh') {
    const reason = stop.reason === 'no-progress'
      ? `连续 ${stop.calls} 次工具调用没有产生新的模型、分析、报告或查询结果`
      : '失败或已回答的操作被重复请求，已被拦截';
    return [
      `本轮已自动停止：${reason}。`,
      `已成功完成的步骤：${done.length ? done.join('、') : '无'}。`,
      `当前可用结果：${available.length ? available.join('、') : '无'}。`,
      `受阻事项：${blocked.length ? blocked.join('；') : '无'}。`,
      '已有结果均已保留，未作任何回退。请根据受阻原因补充或修改信息后继续。',
    ].join('\n');
  }
  const reason = stop.reason === 'no-progress'
    ? `${stop.calls} consecutive tool calls produced no new model, analysis, report or query result`
    : 'a failed or already answered operation was requested again and was blocked';
  return [
    `This turn was stopped automatically: ${reason}.`,
    `Completed steps: ${done.length ? done.join(', ') : 'none'}.`,
    `Available results: ${available.length ? available.join(', ') : 'none'}.`,
    `Blocked: ${blocked.length ? blocked.join('; ') : 'none'}.`,
    'Existing results are kept unchanged. Supply or correct the blocked information to continue.',
  ].join('\n');
}
