import { computeDraftMissing, buildDraftQuestions } from '../../agent-runtime/draft-readiness.js';
import type { AgentSkillRuntime } from '../../agent-runtime/index.js';
import { createChatModel, type LlmTokenUsage } from '../../utils/llm.js';
import type { AgentState } from '../state.js';
import type { AgentSkillPlugin, DraftState, InteractionQuestion, StructuralTypeKey, StructuralTypeMatch } from '../../shared/types/agent.js';

export function buildDraftProgress(
  locale: 'zh' | 'en',
  criticalMissing: string[],
): { canProceed: boolean; nextAction: 'ask_user_clarification' | 'build_model'; reason?: string; instruction: string } {
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

function buildPluginUnavailableProgress(
  locale: 'zh' | 'en',
): { canProceed: false; nextAction: 'ask_user_clarification'; reason: string } {
  return {
    canProceed: false,
    nextAction: 'ask_user_clarification',
    reason: locale === 'zh'
      ? '已保留上一版有效草稿，但无法解析对应结构类型插件，不能可靠计算缺失字段或继续建模。请先确认结构类型或恢复可用 skillScope。'
      : 'The previous valid draft was preserved, but its structure-type plugin could not be resolved. Missing fields cannot be computed reliably, so ask the user to confirm the structural type or restore the available skill scope before building a model.',
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

export function hasStableDraftType(state: DraftState | null | undefined): state is DraftState {
  return !!state?.inferredType && state.inferredType !== 'unknown';
}

export function shouldPreserveExistingDraftState(
  existingState: DraftState | null | undefined,
  structuralTypeMatch: StructuralTypeMatch,
  message?: string,
): existingState is DraftState {
  if (!hasStableDraftType(existingState)) {
    return false;
  }
  if (structuralTypeMatch.routingSource === 'llm-suggested') {
    return false;
  }
  if (structuralTypeMatch.key === 'unknown' && structuralTypeMatch.mappedType === 'unknown') {
    return true;
  }
  return isRetryFeedbackMessage(message) && isConflictingStructuralType(existingState, structuralTypeMatch);
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

function isConflictingStructuralType(
  existingState: DraftState,
  structuralTypeMatch: StructuralTypeMatch,
): boolean {
  if (structuralTypeMatch.mappedType !== existingState.inferredType) {
    return false;
  }
  const existingKey = existingState.structuralTypeKey ?? existingState.inferredType;
  const nextKey = structuralTypeMatch.key;
  if (!nextKey || nextKey === 'unknown') return false;
  return nextKey !== existingKey;
}

function buildPreservedStructuralTypeMatch(
  state: DraftState,
  plugin: AgentSkillPlugin | null | undefined,
): StructuralTypeMatch {
  return {
    key: state.structuralTypeKey ?? state.inferredType,
    mappedType: state.inferredType,
    skillId: state.skillId ?? plugin?.id,
    supportLevel: state.supportLevel ?? 'supported',
    supportNote: state.supportNote,
    routingSource: 'current-state',
  };
}

export function buildPreservedDraftExtractionResult(args: {
  existingState: DraftState;
  structuralTypeMatch: StructuralTypeMatch;
  plugin?: AgentSkillPlugin | null;
  locale: 'zh' | 'en';
}): {
  responseJson: Record<string, unknown>;
  stateUpdate: Partial<AgentState>;
} {
  const plugin = args.plugin ?? null;
  const mergedState = plugin
    ? plugin.handler.mergeState(args.existingState, {})
    : args.existingState;
  const nextState = { ...mergedState, routingSource: 'current-state' as const, updatedAt: Date.now() };
  const missing = plugin
    ? computeDraftMissing(plugin, nextState, 'execution')
    : { critical: ['skillPlugin'], optional: [] };
  const progress = plugin
    ? buildDraftProgress(args.locale, missing.critical)
    : buildPluginUnavailableProgress(args.locale);
  const clarificationQuestions = plugin
    ? buildClarificationQuestions(plugin, missing.critical, missing.optional, nextState, args.locale)
    : [];
  const preservedMatch = buildPreservedStructuralTypeMatch(nextState, plugin);
  const preservationWarning = args.locale === 'zh'
    ? '本轮描述未能稳定识别为新的结构类型，已保留上一版有效草稿，避免将状态覆盖为 unknown/generic。'
    : 'The current message was not recognized as a stable new structural type, so the previous valid draft was preserved instead of being overwritten as unknown/generic.';

  return {
    responseJson: {
      nextState,
      criticalMissing: missing.critical,
      optionalMissing: missing.optional,
      clarificationQuestions,
      structuralTypeMatch: preservedMatch,
      rejectedStructuralTypeMatch: args.structuralTypeMatch,
      skillId: preservedMatch.skillId,
      routingSource: preservedMatch.routingSource,
      extractionMode: 'preserved',
      preservationWarning,
      ...progress,
    },
    stateUpdate: {
      draftState: nextState,
      structuralTypeKey: preservedMatch.key,
    },
  };
}

export async function resolveExistingDraftPlugin(
  skillRuntime: AgentSkillRuntime,
  existingState: DraftState,
  skillIds: string[] | undefined,
  fallbackPlugin: AgentSkillPlugin | null,
): Promise<AgentSkillPlugin | null> {
  const pluginBySkill = existingState.skillId
    ? await skillRuntime.resolvePluginForType(existingState.skillId, skillIds)
    : null;
  if (pluginBySkill) {
    return pluginBySkill;
  }

  const pluginByType = await skillRuntime.resolvePluginForType(existingState.inferredType, skillIds);
  if (pluginByType) {
    return pluginByType;
  }

  return fallbackPlugin?.id === 'generic' ? fallbackPlugin : null;
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

export async function resolveDetectedStructuralTypeMatch(
  skillRuntime: Pick<AgentSkillRuntime, 'resolvePluginForType'>,
  structuralTypeKey: string | null | undefined,
  skillIds?: string[],
): Promise<StructuralTypeMatch | null> {
  if (!structuralTypeKey) return null;
  const plugin = await skillRuntime.resolvePluginForType(structuralTypeKey, skillIds);
  if (!plugin) return null;
  return {
    key: structuralTypeKey as StructuralTypeKey,
    mappedType: plugin.structureType,
    skillId: plugin.id,
    supportLevel: 'supported',
    routingSource: 'current-state',
  };
}
