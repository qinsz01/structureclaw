import { normalizeClarificationOptions } from '../../utils/clarification-options.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { type LangGraphRunnableConfig, interrupt } from '@langchain/langgraph';
import { currentRunPolicy, recordRunEvent } from '../../runtime/run-context.js';
import { getConfigurable } from './shared.js';
import { supportedClarificationOptions } from '../../agent-runtime/template-properties.js';
import { clarificationStateToken } from '../guards/tool-guards.js';

export function createAskUserClarificationTool() {
  return tool(
    async (input: { question: string; optionsJson?: string | unknown[] }, config: LangGraphRunnableConfig) => {
      const proposed = input.optionsJson === undefined ? undefined : normalizeClarificationOptions(input.optionsJson);
      // A choice the template would reject again only restarts the same clarification.
      const options = proposed && supportedClarificationOptions(proposed, getConfigurable(config)?.agentState?.draftState);
      if (input.optionsJson !== undefined && !options?.length) {
        const reason = proposed?.length ? 'NO_SUPPORTED_OPTIONS' : 'INVALID_OR_EMPTY_OPTIONS';
        recordRunEvent({ kind: 'clarification_options_rejected', reason });
        return JSON.stringify({
          success: false, errorCode: 'CLARIFICATION_OPTIONS_INVALID', reason, nextAction: 'resend_clarification',
          message: 'The supplied options could not be delivered; no question was sent to the user. / 所提供的选项无法交付，尚未向用户发送问题。',
          hint: 'Resend a nonempty array or JSON array string of complete supported answers. Include every candidate value in the question text too. Omit optionsJson only for an open-ended question. / 请重发非空数组或 JSON 数组字符串，每项须为完整且受支持的回答；问题正文也必须包含所有候选值。仅开放式问题可省略 optionsJson。',
        });
      }
      if (proposed && options && options.length < proposed.length) recordRunEvent({ kind: 'clarification_options_ignored',
        reason: 'SECTION_DESIGNATION_UNSUPPORTED', options: proposed.filter(option => !options.includes(option)) });

      const stateToken = clarificationStateToken(getConfigurable(config)?.agentState);
      if (currentRunPolicy()?.executionOwner === 'external') {
        return JSON.stringify({ type: 'clarification_needed', question: input.question, options, stateToken,
          nextAction: 'await_user_input', resume: 'Begin a new user turn with the actual user answer; the external host owns dialogue.' });
      }

      const userResponse = interrupt({
        type: 'clarification_needed',
        question: input.question,
        options,
      }) as string;

      const state = getConfigurable(config).agentState;
      const hasCurrentModel = Boolean(state?.model && !state.modelPending);
      return JSON.stringify({
        type: 'clarification_answered',
        question: input.question,
        ...(options ? { options } : {}),
        answer: userResponse,
        stateToken,
        nextAction: hasCurrentModel ? 'query_model' : 'extract_draft_params',
        instruction: hasCurrentModel
          ? 'An existing model is current. Inspect it with query_model; if the answer changes engineering fields, apply only the confirmed changes with edit_model. If those values are already present, continue without rebuilding. / 已有当前模型：用 query_model 确认对象与版本，工程字段的已确认修改通过 edit_model 写入；重复确认已有值时继续执行，不重建草稿。'
          : 'Clarification answers are not merged into draftState automatically. Call extract_draft_params with this exact answer before build_model. / 澄清答案尚未自动合并到草稿；先用原文调用 extract_draft_params，再构建模型。',
      });
    },
    {
      name: 'ask_user_clarification',
      description:
        'Pause execution and ask the user a clarification question. ' +
        'Use this when you cannot proceed without user input. ' +
        'The graph will resume once the user provides an answer. ' +
        'All candidate values, including recalled section dimensions, MUST also appear in the question text, so the user can see exactly what is being confirmed even if options are unavailable. / 所有候选值（包括记忆的截面尺寸）也必须写入问题正文，确保选项不可用时用户仍能看到具体确认内容。',
      schema: z.object({
        question: z.string().trim().min(1).describe('The question to ask the user'),
        optionsJson: z
          .union([z.string(), z.array(z.unknown())])
          .optional()
          .describe('Array or JSON array string of suggested answers; each item must contain the complete answer to send when selected'),
      }),
    },
  );
}
