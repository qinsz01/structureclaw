/**
 * Final-answer delivery policy for the agent node.
 *
 * Applied to every LLM response before it is written to graph state. It only
 * replaces a response that would otherwise end the turn without a usable answer:
 * an empty final message after tool calls, a run that left requested responses
 * uncomputed, or a code check that is incomplete, failed or limited in scope. An empty final
 * response (with or without tool results this turn) is replaced by a bilingual fallback and
 * recorded as a guard event.
 */
import { AIMessage, type AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import type { Logger } from 'pino';
import type { AgentState } from '../state.js';
import { codeCheckDeliveryNotice } from '../../engineering/code-checks.js';
import { extractMessageText, getMessageType, getToolName } from '../message-inspect.js';
import { recordGuardEvent } from '../../runtime/run-context.js';

export function buildEmptyFinalResponseFallback(
  locale: 'zh' | 'en',
  toolNames: string[],
): string {
  const tools = [...new Set(toolNames)].filter(Boolean).join(', ');
  if (locale === 'zh') {
    return tools
      ? `本轮工具已执行完成（${tools}），但模型没有生成最终说明。为避免会话静默结束，请基于这些工具结果继续检查当前模型、荷载或分析状态。`
      : '模型没有生成有效回复。为避免会话静默结束，请继续说明你希望检查的结构、荷载或分析状态。';
  }
  return tools
    ? `The tools for this turn completed (${tools}), but the model did not produce a final explanation. To avoid a silent stop, continue from these tool results and inspect the current model, loads, or analysis state.`
    : 'The model did not produce a valid response. To avoid a silent stop, please continue with the structure, load, or analysis state you want to inspect.';
}

export function shouldReplaceEmptyFinalResponse(response: BaseMessage, currentTurnMessages: BaseMessage[]): boolean {
  const hasToolCalls = 'tool_calls' in response
    && Array.isArray((response as any).tool_calls)
    && (response as any).tool_calls.length > 0;
  if (hasToolCalls) {
    return false;
  }
  if (extractMessageText(response).trim().length > 0) {
    return false;
  }
  return currentTurnMessages.some((message) => getMessageType(message) === 'tool');
}

/** Returns the message to deliver for this LLM response: the response itself or a policy override. */
export function applyFinalAnswerPolicy(input: {
  response: AIMessage | AIMessageChunk;
  hasToolCalls: boolean;
  currentTurnMessages: BaseMessage[];
  state: AgentState;
  log: Logger;
}): BaseMessage {
  const { response, hasToolCalls, currentTurnMessages, state, log } = input;
  if (shouldReplaceEmptyFinalResponse(response, currentTurnMessages)) {
    const toolNames = currentTurnMessages
      .filter((message) => getMessageType(message) === 'tool')
      .map((message) => getToolName(message))
      .filter((name): name is string => !!name);
    log.warn({ node: 'agent', toolNames }, 'empty final LLM response after tool calls');
    recordGuardEvent('empty-final-answer', { action: 'replaced', afterTools: true });
    return new AIMessage(buildEmptyFinalResponseFallback(state.locale, toolNames));
  }
  if (!hasToolCalls && !extractMessageText(response).trim()) {
    log.warn({ node: 'agent' }, 'empty final LLM response without tool calls');
    recordGuardEvent('empty-final-answer', { action: 'replaced', afterTools: false });
    return new AIMessage(buildEmptyFinalResponseFallback(state.locale, []));
  }

  const check = state.codeCheckResult;
  const data = state.analysisResult?.data as Record<string, unknown> | undefined;
  const analyzedThisTurn = currentTurnMessages.some(message => getMessageType(message) === 'tool' && getToolName(message) === 'run_analysis');
  if (!hasToolCalls && analyzedThisTurn && Array.isArray(data?.missingRequestedResponses) && data.missingRequestedResponses.length) {
    const available = Object.values(state.resultQuantities ?? {}).filter(q => q.runId === state.analysisResult?.runId);
    const values = available.map(q => `${q.component}=${q.value} ${q.unit}`).join('; ');
    const notice = state.locale === 'zh'
      ? `内力/反力已通过平衡计算得到，运行 ${state.analysisResult?.runId}。${values}\n其余所求响应尚未完成：${data.missingRequestedResponses.join('、')}。位移和转角需要对应刚度，应力需要截面资料；缺失值不能填零。请补充所需分析属性后继续。`
      : `Forces/reactions were computed by equilibrium, run ${state.analysisResult?.runId}. ${values}\nOther requested responses remain incomplete: ${data.missingRequestedResponses.join(', ')}. Displacement/rotation needs stiffness; stress needs section data. Missing values are not zero. Supply the required analysis properties to continue.`;
    return new AIMessage({ content: notice, id: response.id,
      response_metadata: response.response_metadata, usage_metadata: response.usage_metadata });
  }
  const checkedThisTurn = currentTurnMessages.some(message => getMessageType(message) === 'tool'
    && !String(message.content).includes('"skipped":true')
    && (getToolName(message) === 'run_code_check' || getToolName(message) === 'generate_report' && !!check));
  if (!hasToolCalls && checkedThisTurn && (!check || check.completionStatus !== 'complete' || check.complianceStatus === 'fail'
    || !!check.checkScope && typeof check.checkScope === 'object' && (check.checkScope as Record<string, unknown>).limited === true)) {
    return new AIMessage({ content: codeCheckDeliveryNotice(check ?? {}, state.locale),
      id: response.id, response_metadata: response.response_metadata,
      usage_metadata: response.usage_metadata });
  }
  return response;
}
