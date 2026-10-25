import { capabilityNotice } from '../capability-notice.js';
import { messageRole, messageText } from './input-message.js';
import { normalizeClarificationOptions } from '../../utils/clarification-options.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { type LangGraphRunnableConfig, interrupt } from '@langchain/langgraph';
import { currentRunPolicy, recordRunEvent } from '../../runtime/run-context.js';
import { getConfigurable } from './shared.js';
import { supportedClarificationOptions } from '../../agent-runtime/template-properties.js';
import { clarificationStateToken } from '../guards/tool-guards.js';
import { draftSectionConfirmations } from '../../agent-runtime/draft-readiness.js';
import { contentHash, isRecord } from '../../engineering/model-record.js';
import { quantities } from '../../engineering/section-user-evidence.js';

export function createAskUserClarificationTool() {
  return tool(
    async (input: { question: string; optionsJson?: string | unknown[];
      candidateOptions?: Array<{ sectionId: string; field: string; optionIndex: number; values?: Record<string, number> }> }, config: LangGraphRunnableConfig) => {
      const messages = getConfigurable(config)?.agentState?.messages ?? [];
      for (const message of [...messages].reverse()) {
        if (['human', 'user'].includes(messageRole(message) ?? '')) break;
        if (messageRole(message) === 'tool' && message.name === 'extract_draft_params') {
          let result: Record<string, unknown> = {};
          try { result = JSON.parse(messageText(message)); } catch { /* Non-JSON results cannot establish a contract fault. */ }
          if (result.errorCode === 'FIELD_CONTRACT_UNRESOLVED') return JSON.stringify(result);
          break;
        }
      }
      const notice = capabilityNotice(messages);
      if (notice && !input.question.includes(notice)) input = { ...input, question: `${notice}\n\n${input.question}` };
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
      const clarificationId = `clarification:${contentHash({ question: input.question, options, stateToken })}`;
      const draftState = getConfigurable(config)?.agentState?.draftState;
      const offered = (input.candidateOptions ?? []).filter(binding => binding.values).map(binding => ({
        id: binding.sectionId, fields: [binding.field], [binding.field]: binding.values,
      }));
      const sectionCandidates = [...(draftState ? draftSectionConfirmations(draftState) : []), ...offered].flatMap(section => {
        return (Array.isArray(section.fields) ? section.fields : []).flatMap(field => {
          const values = section[String(field)];
          if (!isRecord(values)) return [];
          const numbers = Object.values(values).filter(value => typeof value === 'number');
          const contains = (text: string) => numbers.length > 0 && numbers.every(value => quantities(text).some(item => item.value === value));
          const inQuestion = contains(input.question);
          const bindings = (input.candidateOptions ?? []).filter(binding => binding.sectionId === section.id && binding.field === field);
          const optionIds = (options ?? []).flatMap((option, index) => (bindings.length ? bindings.some(
            binding => binding.optionIndex === index && (inQuestion || contains(option))
              && (!binding.values || contentHash(binding.values) === contentHash(Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === 'number'))))) : contains(option))
            ? [`option-${index + 1}`] : []);
          if (!inQuestion && !optionIds.length) return [];
          const candidate = { sectionId: section.id, field, values };
          return [{ ...candidate, id: `candidate:${contentHash(candidate)}`, optionIds }];
        });
      });
      // Candidate declarations are structural, never inferred from question text.
      // General questions may repeat confirmed dimensions without proposing a section.
      // Unbound proposals still cannot become confirmed input at the evidence boundary.
      if (input.candidateOptions !== undefined && !sectionCandidates.length) {
        recordRunEvent({ kind: 'clarification_options_rejected', reason: 'SECTION_CANDIDATES_REQUIRED' });
        return JSON.stringify({ success: false, errorCode: 'SECTION_CANDIDATES_REQUIRED', nextAction: 'resend_clarification',
          message: 'No question was sent: numeric section proposals need stored candidates. / 尚未发送问题：数值截面建议必须先保存候选。',
          hint: 'Resend with candidateOptions containing sectionId, field, optionIndex and values for every proposed section. Preserve those IDs when extracting the answer. / 请重发，并用 candidateOptions 为每个建议截面提供 sectionId、field、optionIndex、values；提取回答时保留这些标识。' });
      }
      if (currentRunPolicy()?.executionOwner === 'external') {
        return JSON.stringify({ type: 'clarification_needed', question: input.question, options, stateToken, clarificationId, sectionCandidates,
          nextAction: 'await_user_input', resume: 'Begin a new user turn with the actual user answer; the external host owns dialogue.' });
      }

      const userResponse = interrupt({
        type: 'clarification_needed',
        question: input.question,
        options,
        clarificationId,
        sectionCandidates,
      }) as string;

      const state = getConfigurable(config).agentState;
      const hasCurrentModel = Boolean(state?.model && !state.modelPending);
      return JSON.stringify({
        type: 'clarification_answered',
        question: input.question,
        ...(options ? { options } : {}),
        answer: userResponse,
        stateToken,
        clarificationId,
        sectionCandidates,
        ...(options?.includes(userResponse) ? { selectedOptionId: `option-${options.indexOf(userResponse) + 1}` } : {}),
        nextAction: hasCurrentModel ? 'query_model' : 'extract_draft_params',
        instruction: hasCurrentModel
          ? 'An existing model is current. Inspect it with query_model; apply local confirmed changes with edit_model. If the user authorized complete reconstruction, extract the exact answer with all confirmed inputs, then call build_model with mode="rebuild" and the latest queried baseRevision. A repeated confirmation alone does not authorize a rebuild. / 已有当前模型：用 query_model 确认对象与版本，局部已确认修改通过 edit_model 写入。用户明确授权整体重建时，结合全部已确认输入提取回答原文，再以 mode="rebuild" 和最新查询的 baseRevision 调用 build_model；单纯重复确认已有值不代表授权重建。'
          : 'Clarification answers are not merged into draftState automatically. Call extract_draft_params with this exact answer before build_model. / 澄清答案尚未自动合并到草稿；先用原文调用 extract_draft_params，再构建模型。',
      });
    },
    {
      name: 'ask_user_clarification',
      description:
        'Pause execution and ask the user a clarification question. ' +
        'Use this when you cannot proceed without user input. ' +
        'The graph will resume once the user provides an answer. ' +
        'Declare EVERY new numeric section proposal with candidateOptions containing stable sectionId, field, zero-based optionIndex and flat numeric values in this FIRST call. Unbound proposals cannot become confirmed calculation input. For general questions, omit candidateOptions; merely repeating confirmed dimensions does not propose a section. / 新数值截面建议首次调用须通过candidateOptions声明稳定sectionId、field、从0开始的optionIndex及平铺数值values；未绑定建议不能成为已确认计算输入。普通问题省略candidateOptions，复述已确认尺寸不代表提出截面建议。 ' +
        'All candidate values, including recalled section dimensions, MUST also appear in the question text, so the user can see exactly what is being confirmed even if options are unavailable. / 所有候选值（包括记忆的截面尺寸）也必须写入问题正文，确保选项不可用时用户仍能看到具体确认内容。',
      schema: z.object({
        question: z.string().trim().min(1).describe('The question to ask the user'),
        optionsJson: z
          .union([z.string(), z.array(z.unknown())])
          .optional()
          .describe('Array or JSON array string of suggested answers; each item must contain the complete answer to send when selected'),
        candidateOptions: z.array(z.object({ sectionId: z.string(), field: z.enum(['shape', 'dimensions', 'properties']),
          optionIndex: z.number().int().nonnegative(), values: z.record(z.string(), z.number().finite()).optional().describe('Flat numeric fields only, e.g. {H:200,B:100,tw:7,tf:11.4}; omit shape kind/type, names and nested prefixes. / 仅平铺数值字段，不含截面类型、名称或嵌套前缀。') })).optional()
          .describe('Bind a short acceptance option to section candidates displayed in the question. Supply values for newly offered candidates not yet in the draft (shape/dimensions in mm, properties in SI). Zero-based optionIndex. / 将简短确认选项绑定到问题中展示的截面候选；尚未入草稿的新候选须提供values（尺寸mm、属性SI），optionIndex从0开始。'),
      }),
    },
  );
}
