/**
 * Final-answer delivery policy for the agent node.
 *
 * Applied to every LLM response before it is written to graph state. It only
 * stops empty replies as explicit failures and reports a code check that is incomplete,
 * failed or limited in scope using its structured execution status.
 */
import { AIMessage, type AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import type { Logger } from 'pino';
import type { AgentState } from '../state.js';
import { codeCheckDeliveryNotice } from '../../engineering/code-checks.js';
import { extractMessageText, getMessageType, getToolName } from '../message-inspect.js';
import { recordGuardEvent } from '../../runtime/run-context.js';

/** Returns the message to deliver for this LLM response: the response itself or a policy override. */
export function applyFinalAnswerPolicy(input: {
  response: AIMessage | AIMessageChunk;
  hasToolCalls: boolean;
  currentTurnMessages: BaseMessage[];
  state: AgentState;
  log: Logger;
}): BaseMessage {
  const { response, hasToolCalls, currentTurnMessages, state, log } = input;
  if (!hasToolCalls && !extractMessageText(response).trim()) {
    const afterTools = currentTurnMessages.some(message => getMessageType(message) === 'tool');
    log.warn({ node: 'agent', afterTools }, 'empty final LLM response');
    recordGuardEvent('empty-final-answer', { action: 'failed', afterTools });
    throw new Error('LLM_EMPTY_RESPONSE: The model returned no usable answer. Completed tool results are retained. / 模型未返回有效回复；已完成的工具结果仍保留。');
  }

  const check = state.codeCheckResult;
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
