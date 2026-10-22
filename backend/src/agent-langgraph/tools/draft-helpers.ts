import { buildDraftQuestions } from '../../agent-runtime/draft-readiness.js';
import type { AgentSkillRuntime } from '../../agent-runtime/index.js';
import { createChatModel, type LlmTokenUsage } from '../../utils/llm.js';
import type { AgentSkillPlugin, DraftState, InteractionQuestion, StructuralTypeMatch } from '../../shared/types/agent.js';
import type { MissingInputNextAction } from '../../runtime/ablation-profiles.js';
import { nextActionForMissingInput } from './shared.js';

export function buildDraftProgress(
  locale: 'zh' | 'en',
  criticalMissing: string[],
): { canProceed: boolean; nextAction: MissingInputNextAction | 'build_model'; reason?: string; instruction: string } {
  if (criticalMissing.length === 0) {
    return {
      canProceed: true,
      nextAction: 'build_model',
      instruction: locale === 'zh'
        ? 'criticalMissing 为空。下一步调用 build_model；不要因为可默认或非关键的 draftIssues 先追问。'
        : 'criticalMissing is empty. Call build_model next; do not ask for clarification first just because defaultable or non-critical draftIssues are present.',
    };
  }
  const missingText = criticalMissing.join(', ');
  const nextAction = nextActionForMissingInput();
  if (nextAction === 'report_missing_inputs') {
    return {
      canProceed: false,
      nextAction,
      instruction: locale === 'zh'
        ? '存在关键缺失字段。本次运行不提供澄清工具：在最终回复中列出这些缺失输入并结束本轮；不得编造数值，不要调用 build_model。'
        : 'Critical fields are missing. Clarification is not available in this run: list these missing inputs in your final reply and end the turn; never invent values and do not call build_model.',
      reason: locale === 'zh'
        ? `草稿仍缺少关键参数：${missingText}。需要向用户说明缺失项，不能直接构建模型或写入 memory。`
        : `The draft is still missing critical parameters: ${missingText}. Report them to the user; do not build the model or store draft values in memory.`,
    };
  }
  return {
    canProceed: false,
    nextAction: 'ask_user_clarification',
    instruction: locale === 'zh'
      ? '存在关键缺失字段。下一步调用 ask_user_clarification；不要调用 build_model。'
      : 'Critical fields are missing. Call ask_user_clarification next; do not call build_model.',
    reason: locale === 'zh'
      ? `草稿仍缺少关键参数：${missingText}。需要继续向用户澄清，不能直接构建模型或写入 memory。`
      : `The draft is still missing critical parameters: ${missingText}. Continue by asking the user for clarification; do not build the model or store draft values in memory.`,
  };
}

export function buildClarificationQuestions(
  plugin: AgentSkillPlugin | null | undefined,
  criticalMissing: string[],
  optionalMissing: string[],
  state: DraftState,
  locale: 'zh' | 'en',
): InteractionQuestion[] {
  return buildDraftQuestions(plugin, criticalMissing, optionalMissing, state, locale);
}

function isRetryFeedbackMessage(message: string | undefined): boolean {
  const text = message?.trim();
  if (!text) return false;
  return /^上次尝试失败[:：]/.test(text) || /^Previous attempt failed[:：]/i.test(text);
}

export function resolveRetryTaskMessage(message: string | undefined): string {
  const text = message?.trim();
  if (!text || !isRetryFeedbackMessage(text)) {
    return text || '';
  }
  const split = text.split(/\r?\n\s*\r?\n/);
  if (split.length < 2) {
    return text;
  }
  const taskMessage = split.slice(1).join('\n\n').trim();
  return taskMessage || text;
}

export function detectStructuralTypeWithConfiguredLlm(
  skillRuntime: AgentSkillRuntime,
  args: {
    message: string;
    locale: 'zh' | 'en';
    currentState?: DraftState;
    skillIds?: string[];
    signal?: AbortSignal;
    onUsage?: (usage: LlmTokenUsage) => void;
  },
): Promise<StructuralTypeMatch> {
  const routerLlm = createChatModel(0, { disableStreaming: true });
  return skillRuntime.detectStructuralTypeWithLlm(
    routerLlm,
    args.message,
    args.locale,
    args.currentState,
    args.skillIds,
    args.signal,
    args.onUsage,
  );
}

/** Exhausted semantic operations fail explicitly; the outer agent must not invent another path. */
export function semanticFailurePayload(message: string): Record<string, unknown> | undefined {
  const errorCode = message.slice(0, message.indexOf(':'));
  if (!['LLM_PARAM_EXTRACTOR_CONFIGURATION_ERROR', 'LLM_PARAM_EXTRACTOR_INVALID_OUTPUT',
    'LLM_PARAM_EXTRACTOR_INFRASTRUCTURE_ERROR', 'LLM_STRUCTURAL_ROUTER_REQUIRED',
    'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT', 'LLM_STRUCTURAL_ROUTER_INFRASTRUCTURE_ERROR',
    'STRUCTURE_SKILL_UNAVAILABLE'].includes(errorCode)) return undefined;
  return { success: false, errorCode, message, canProceed: false, nextAction: 'report_internal_error',
    instruction: 'The semantic operation failed; the saved draft is unchanged. Explain this failure and stop. Do not retry through another skill, generic fallback or rule parser. / 语义操作失败，原有草稿未修改。请说明错误并停止，不得改用其他技能、通用回退或规则解析。' };
}
