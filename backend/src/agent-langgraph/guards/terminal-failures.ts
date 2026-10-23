import type { ToolMessage } from '@langchain/core/messages';
import { toolMessageFailure } from '../../utils/tool-outcome.js';
import { messageRole, messageText } from '../tools/input-message.js';
import { failureCode } from './tool-guards.js';

/** Exhausted semantic operations cannot be replaced with an older draft or another tool. */
const TERMINAL_CODES = new Set([
  'LLM_NOT_CONFIGURED', 'LLM_STRUCTURAL_ROUTER_REQUIRED', 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT',
  'LLM_STRUCTURAL_ROUTER_INFRASTRUCTURE_ERROR', 'LLM_PARAM_EXTRACTOR_CONFIGURATION_ERROR',
  'LLM_PARAM_EXTRACTOR_INVALID_OUTPUT', 'LLM_PARAM_EXTRACTOR_INFRASTRUCTURE_ERROR',
  'LLM_MODEL_BUILDER_REQUIRED', 'LLM_MODEL_BUILDER_INFRASTRUCTURE_ERROR', 'LLM_MODEL_VALIDATION_FAILED', 'LLM_EMPTY_RESPONSE',
  'VISION_MODEL_REQUIRED', 'VISION_MODEL_FAILED', 'VISION_INPUT_UNAVAILABLE',
  'STRUCTURE_TYPE_UNSUPPORTED', 'STRUCTURE_SKILL_UNAVAILABLE', 'FIXED_SKILL_NOT_A_MODELING_PROVIDER', 'FIELD_CONTRACT_UNRESOLVED',
]);

/**
 * Called at the next graph node, after the failed tool result has checkpointed.
 * Current-turn message evidence survives restarts; a new user turn starts fresh.
 */
export function assertNoTerminalSemanticFailure(messages: unknown[] = []): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const role = messageRole(message);
    if (role === 'human' || role === 'user') return;
    if (role !== 'tool') continue;
    const content = messageText(message);
    const status = (message as Partial<ToolMessage>).status;
    const failure = toolMessageFailure({ content, status });
    if (!failure) continue;
    let code = failureCode(failure);
    let detail = failure;
    let exhaustedBuild = false;
    try {
      const payload = JSON.parse(content);
      const tool = message as { name?: string; kwargs?: { name?: string } };
      exhaustedBuild = (tool.name ?? tool.kwargs?.name) === 'build_model' && payload?.terminal === true && payload?.modelBuilt === false;
      if (typeof payload?.errorCode === 'string') code = payload.errorCode;
      else if (typeof payload?.error_code === 'string') code = payload.error_code;
      if (typeof payload?.message === 'string') detail = payload.message;
      else if (typeof payload?.error === 'string') detail = payload.error;
      else if (typeof payload?.supportNote === 'string') detail = payload.supportNote;
    } catch { /* ToolNode plain errors retain their explicit prefix. */ }
    if (exhaustedBuild || TERMINAL_CODES.has(code)) {
      if (code === 'STRUCTURE_TYPE_UNSUPPORTED') {
        throw new Error(`${code}: The requested structure is not supported by the enabled capabilities; this turn was stopped. / 已启用的能力不支持本次结构请求，本轮已停止。 ${detail}`);
      }
      throw new Error(detail.startsWith(`${code}:`) ? detail : `${code}: ${detail}`);
    }
  }
}
