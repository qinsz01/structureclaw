import { normalizeClarificationOptions } from '../../utils/clarification-options.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { type LangGraphRunnableConfig, interrupt } from '@langchain/langgraph';
import { currentRunPolicy, recordRunEvent } from '../../runtime/run-context.js';
import { getConfigurable } from './shared.js';
import { supportedClarificationOptions } from '../../agent-runtime/template-properties.js';

export function createAskUserClarificationTool() {
  return tool(
    async (input: { question: string; optionsJson?: string }, config: LangGraphRunnableConfig) => {
      const proposed = input.optionsJson === undefined ? undefined : normalizeClarificationOptions(input.optionsJson);
      if (input.optionsJson && !proposed?.length) recordRunEvent({ kind: 'clarification_options_ignored', reason: 'OPTIONAL_CHOICES_UNAVAILABLE' });
      // A choice the template would reject again only restarts the same clarification.
      const options = proposed && supportedClarificationOptions(proposed, getConfigurable(config)?.agentState?.draftState);
      if (proposed && options && options.length < proposed.length) recordRunEvent({ kind: 'clarification_options_ignored',
        reason: 'SECTION_DESIGNATION_UNSUPPORTED', options: proposed.filter(option => !options.includes(option)) });

      if (currentRunPolicy()?.executionOwner === 'external') {
        return JSON.stringify({ type: 'clarification_needed', question: input.question, options,
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
        'The graph will resume once the user provides an answer.',
      schema: z.object({
        question: z.string().trim().min(1).describe('The question to ask the user'),
        optionsJson: z
          .string()
          .optional()
          .describe('JSON array of suggested answer strings; each string must contain the complete answer to send when selected'),
      }),
    },
  );
}
