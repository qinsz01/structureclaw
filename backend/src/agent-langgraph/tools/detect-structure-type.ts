import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentSkillRuntime } from '../../agent-runtime/index.js';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { getLogger, logToolCall } from '../../utils/agent-logger.js';
import type { AgentState } from '../state.js';
import type { AgentConfigurable } from '../configurable.js';
import { resolveRetryTaskMessage, detectStructuralTypeWithConfiguredLlm } from './draft-helpers.js';
import { resolveToolInputMessage } from './input-message.js';
import { getConfigurable, getToolCallId, toolResult, nestedLlmUsageCollector } from './shared.js';

export function createDetectStructureTypeTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: { message?: string; locale?: string }, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);
      const skillIds = configurable.skillScope;
        const locale = (input.locale ?? state?.locale ?? 'zh') as 'en' | 'zh';
      const message = resolveToolInputMessage(input.message, state?.lastUserMessage, state?.messages);
      const detectionMessage = resolveRetryTaskMessage(message);
      const nestedUsage = nestedLlmUsageCollector();
      try {
        const match = await detectStructuralTypeWithConfiguredLlm(skillRuntime, {
          message: detectionMessage,
          locale,
          currentState: state?.draftState || undefined,
          skillIds,
          signal: config.signal,
          onUsage: nestedUsage.onUsage,
        });
        const unsupported = match.supportLevel === 'unsupported';
        const result = {
          key: match.key,
          mappedType: match.mappedType,
          skillId: match.skillId,
          routingSource: match.routingSource,
          supportLevel: match.supportLevel,
          supportNote: match.supportNote,
          nextAction: unsupported ? 'explain_capability_boundary' : 'extract_draft_params',
          instruction: unsupported
            ? (locale === 'zh'
              ? '当前技能或适配器不支持该请求。不得继续提取参数、构建模型或运行分析；请明确说明具体能力边界，并询问用户是否改用当前明确支持的替代工作流。'
              : 'The current skills or adapters do not support this request. Do not extract parameters, build a model, or run analysis. Explain the specific capability boundary and ask whether the user wants a currently supported alternative workflow.')
            : (locale === 'zh'
              ? '结构类型已识别。若用户请求建模、分析或报告，下一步调用 extract_draft_params；不要只输出结构类型后停止。'
              : 'Structural type detected. If the user requested modeling, analysis, or reporting, call extract_draft_params next; do not stop after reporting the type.'),
        };
        const stateUpdate: Partial<AgentState> = {};
        if (match.key) stateUpdate.structuralTypeKey = match.key;
        logToolCall(log, { tool: 'detect_structure_type', durationMs: Date.now() - start, extra: { matchedKey: match.key, skillId: match.skillId, routingSource: match.routingSource } });
        return toolResult(
          toolCallId,
          'detect_structure_type',
          JSON.stringify(result),
          stateUpdate,
          nestedUsage.total(),
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logToolCall(log, { tool: 'detect_structure_type', durationMs: Date.now() - start, success: false, extra: { error: errorMessage } });
        if (
          errorMessage.startsWith('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT:')
        ) {
          return toolResult(
            toolCallId,
            'detect_structure_type',
            JSON.stringify({
              success: false,
              errorCode: 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT',
              message: errorMessage,
              nextAction: 'retry_detection',
            }),
            undefined,
            nestedUsage.total(),
          );
        }
        throw error;
      }
    },
    {
      name: 'detect_structure_type',
      description:
        'Detect the structural type (beam, truss, frame, portal-frame, etc.) from a user description. ' +
        'Returns the matched type key, mapped model type, and the skill ID to use for further processing.',
      schema: z.object({
        message: z.string().describe('The user message describing the structure').optional(),
        locale: z.enum(['zh', 'en']).optional().describe('User locale (defaults to session locale)'),
      }),
    },
  );
}
