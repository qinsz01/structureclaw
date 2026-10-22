import type { AppLocale } from '../shared/locale.js';
import { currentRunPolicy } from '../runtime/run-context.js';
import { llmContentText } from '../utils/llm-content.js';
import {
  extractLlmTokenUsage,
  type LlmTokenUsage,
  type StructureClawChatModel,
} from '../utils/llm.js';
import { buildStructuralTypeMatch } from './plugin-helpers.js';
import type {
  AgentSkillPlugin,
  DraftState,
  InferredModelType,
  StructuralTypeKey,
  StructuralTypeMatch,
  StructuralTypeSupportLevel,
} from '../shared/types/agent.js';

type StructuralRouterAction = 'continue_current' | 'switch_skill' | 'unsupported' | 'generic' | 'ask';
type RouterLlm = Pick<StructureClawChatModel, 'invoke'>;

interface StructuralRouterDecision {
  action?: StructuralRouterAction;
  skillId?: string;
  structuralTypeKey?: StructuralTypeKey;
  mappedType?: InferredModelType;
  supportLevel?: StructuralTypeSupportLevel;
  confidence?: number;
  reason?: string;
}

interface StructuralRouterInput {
  llm: RouterLlm;
  message: string;
  locale: AppLocale;
  currentState?: DraftState;
  currentPlugin?: AgentSkillPlugin | null;
  plugins: AgentSkillPlugin[];
  signal?: AbortSignal;
  onUsage?: (usage: LlmTokenUsage) => void;
}

const MIN_ROUTER_CONFIDENCE = 0.55;
const ROUTER_OUTPUT_SCHEMA = '{ "action": "continue_current|switch_skill|unsupported|generic|ask", "skillId": string, "structuralTypeKey": string, "mappedType": string, "supportLevel": "supported|unsupported", "confidence": number, "reason": string }';
const PROMPT_METADATA_KEYS = new Set([
  'updatedAt',
  'coordinateSemantics',
  'supportNote',
  'routingSource',
]);
const STRUCTURAL_TYPE_KEYS = new Set<StructuralTypeKey>([
  'beam',
  'column',
  'truss',
  'portal-frame',
  'double-span-beam',
  'frame',
  'steel-frame',
  'concrete-frame',
  'reinforced-concrete-frame',
  'portal',
  'girder',
  'space-frame',
  'plate-slab',
  'shell',
  'tower',
  'bridge',
  'unknown',
]);
const MODEL_TYPES = new Set<InferredModelType>([
  'beam',
  'column',
  'truss',
  'portal-frame',
  'double-span-beam',
  'frame',
  'unknown',
]);
const SUPPORT_LEVELS = new Set<StructuralTypeSupportLevel>(['supported', 'unsupported']);
const ACTIONS = new Set<StructuralRouterAction>(['continue_current', 'switch_skill', 'unsupported', 'generic', 'ask']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const direct = tryParseJsonObject(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const parsedFence = tryParseJsonObject(fenced[1]);
    if (parsedFence) return parsedFence;
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return tryParseJsonObject(trimmed.slice(first, last + 1));
  }
  return null;
}

function tryParseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cleanStateForPrompt(value: unknown, keyPath: string[] = []): unknown {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) => cleanStateForPrompt(item, keyPath))
      .filter((item) => item !== undefined);
    return cleaned.length > 0 ? cleaned : undefined;
  }
  if (isRecord(value)) {
    const key = keyPath[keyPath.length - 1];
    const entries = Object.entries(value)
      .filter(([entryKey]) => !PROMPT_METADATA_KEYS.has(entryKey))
      .filter(([entryKey]) => !(key === 'skillState' && entryKey === 'invalidDraftFields'))
      .map(([entryKey, item]) => [entryKey, cleanStateForPrompt(item, [...keyPath, entryKey])] as const)
      .filter(([, item]) => item !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return 0;
}

function normalizeDecision(parsed: Record<string, unknown>): StructuralRouterDecision | null {
  const actionValue = getString(parsed.action);
  const keyValue = getString(parsed.structuralTypeKey ?? parsed.key);
  const mappedTypeValue = getString(parsed.mappedType ?? parsed.inferredType);
  const supportLevelValue = getString(parsed.supportLevel);
  if (!actionValue || !ACTIONS.has(actionValue as StructuralRouterAction)
    || (parsed.supportLevel !== undefined && (!supportLevelValue || !SUPPORT_LEVELS.has(supportLevelValue as StructuralTypeSupportLevel)))
    || ((parsed.structuralTypeKey ?? parsed.key) !== undefined && (!keyValue || !STRUCTURAL_TYPE_KEYS.has(keyValue as StructuralTypeKey)))
    || ((parsed.mappedType ?? parsed.inferredType) !== undefined && (!mappedTypeValue || !MODEL_TYPES.has(mappedTypeValue as InferredModelType)))) return null;
  return {
    action: actionValue && ACTIONS.has(actionValue as StructuralRouterAction)
      ? actionValue as StructuralRouterAction
      : undefined,
    skillId: getString(parsed.skillId),
    structuralTypeKey: keyValue && STRUCTURAL_TYPE_KEYS.has(keyValue as StructuralTypeKey)
      ? keyValue as StructuralTypeKey
      : undefined,
    mappedType: mappedTypeValue && MODEL_TYPES.has(mappedTypeValue as InferredModelType)
      ? mappedTypeValue as InferredModelType
      : undefined,
    supportLevel: supportLevelValue && SUPPORT_LEVELS.has(supportLevelValue as StructuralTypeSupportLevel)
      ? supportLevelValue as StructuralTypeSupportLevel
      : undefined,
    confidence: getConfidence(parsed.confidence),
    reason: getString(parsed.reason),
  };
}

function pluginForDecision(decision: StructuralRouterDecision, plugins: AgentSkillPlugin[]): AgentSkillPlugin | undefined {
  const key = decision.structuralTypeKey;
  // An explicit unavailable skill must not be replaced by another provider sharing its type.
  const plugin = decision.skillId
    ? plugins.find((candidate) => candidate.id === decision.skillId)
    : key ? plugins.find((candidate) => candidate.manifest.structuralTypeKeys.includes(key)) : undefined;
  if (!plugin || (key && !plugin.manifest.structuralTypeKeys.includes(key))
    || (decision.mappedType && decision.mappedType !== plugin.structureType)) return undefined;
  return plugin;
}

function buildCurrentStateMatch(
  state: DraftState,
  plugin: AgentSkillPlugin,
  supportNote?: string,
): StructuralTypeMatch | null {
  const key = state.structuralTypeKey ?? plugin.manifest.structuralTypeKeys[0];
  if ((state.skillId && state.skillId !== plugin.id) || !key
    || !plugin.manifest.structuralTypeKeys.includes(key)
    || (plugin.id !== 'generic' && state.inferredType !== plugin.structureType)) return null;
  return {
    key,
    mappedType: plugin.structureType,
    skillId: plugin.id,
    supportLevel: 'supported',
    supportNote,
    routingSource: 'llm-suggested',
  };
}

function buildGenericMatch(locale: AppLocale, plugins: AgentSkillPlugin[], reason?: string): StructuralTypeMatch | null {
  const genericPlugin = plugins.find((plugin) => plugin.id === 'generic');
  if (!genericPlugin) return null;
  return buildStructuralTypeMatch('unknown', 'unknown', 'generic', 'supported', locale, {
    zh: reason || '大模型判断当前描述不应被旧结构草稿锁定，先交给通用结构类型 skill 继续澄清。',
    en: reason || 'The LLM router decided this request should not be locked to the prior draft, so it will continue through the generic structure-type skill.',
  }, 'llm-suggested');
}

function resolveRouterMatch(
  decision: StructuralRouterDecision,
  input: StructuralRouterInput,
): StructuralTypeMatch | null {
  if ((decision.confidence ?? 0) < MIN_ROUTER_CONFIDENCE) {
    return null;
  }

  const action = decision.action;
  if (action !== 'unsupported' && decision.supportLevel === 'unsupported') return null;

  if (action === 'continue_current') {
    if (!input.currentState?.inferredType || !input.currentPlugin
      || !input.plugins.some(plugin => plugin.id === input.currentPlugin?.id)
      || (decision.skillId && decision.skillId !== input.currentPlugin.id)
      || (decision.structuralTypeKey && !input.currentPlugin.manifest.structuralTypeKeys.includes(decision.structuralTypeKey))
      || (decision.mappedType && decision.mappedType !== input.currentPlugin.structureType)) {
      return null;
    }
    return buildCurrentStateMatch(input.currentState, input.currentPlugin, decision.reason);
  }

  if (action === 'generic' || action === 'ask') {
    if ((decision.skillId && decision.skillId !== 'generic')
      || (decision.structuralTypeKey && decision.structuralTypeKey !== 'unknown')
      || (decision.mappedType && decision.mappedType !== 'unknown')) return null;
    return buildGenericMatch(input.locale, input.plugins, decision.reason);
  }

  if (action === 'unsupported') {
    if (!decision.structuralTypeKey || decision.structuralTypeKey === 'unknown'
      || decision.skillId || (decision.mappedType && decision.mappedType !== 'unknown')
      || decision.supportLevel === 'supported') {
      return null;
    }
    return {
      key: decision.structuralTypeKey,
      mappedType: 'unknown',
      supportLevel: 'unsupported',
      supportNote: decision.reason,
      routingSource: 'llm-suggested',
    };
  }

  if (action !== 'switch_skill') {
    return null;
  }

  if (decision.supportLevel === 'unsupported') return null;

  const plugin = pluginForDecision(decision, input.plugins);
  if (!plugin) {
    return null;
  }
  if (plugin.id === 'generic') {
    return buildGenericMatch(input.locale, input.plugins, decision.reason);
  }

  const key = decision.structuralTypeKey
    ?? plugin.manifest.structuralTypeKeys[0]
    ?? plugin.structureType;
  const mappedType = decision.mappedType ?? plugin.structureType;
  return buildStructuralTypeMatch(
    key as StructuralTypeKey,
    mappedType,
    plugin.id,
    'supported',
    input.locale,
    decision.reason ? { zh: decision.reason, en: decision.reason } : undefined,
    'llm-suggested',
  );
}

function buildPluginSummary(plugin: AgentSkillPlugin): Record<string, unknown> {
  return {
    id: plugin.id,
    structureType: plugin.structureType,
    structuralTypeKeys: plugin.manifest.structuralTypeKeys,
    name: plugin.name,
    ...(currentRunPolicy()?.knowledge !== 'disabled' ? { description: plugin.description, triggers: plugin.triggers } : {}),
  };
}

function buildRouterPrompt(input: StructuralRouterInput): string {
  const stateJson = JSON.stringify(cleanStateForPrompt(input.currentState) ?? {}, null, 2);
  const skillsJson = JSON.stringify(input.plugins.map(buildPluginSummary), null, 2);
  const currentSkill = input.currentPlugin
    ? JSON.stringify(buildPluginSummary(input.currentPlugin), null, 2)
    : 'null';

  if (input.locale === 'zh') {
    return [
      '你是结构工程对话的结构类型路由器。请直接判断本轮用户消息应该继续当前 draft，切换到某个结构 skill，还是进入 generic 澄清。',
      '',
      '不要因为存在 current draft 就自动继续；只有用户是在修改、补充、回答追问或明确引用当前模型时才 continue_current。',
      '如果最新消息像一个新的结构描述，尤其是从构件级草稿转到办公楼、柱网、楼层、体系描述，不要被旧 draft 锁定。',
      '“梁上荷载”里的梁通常是框架构件上下文，不一定要切到 beam；“柱网/柱距”里的柱通常不是单柱。',
      '澄清问题、未选选项和助手建议是未确认上下文；只依据用户真实回答判断，不把未选候选当作用户请求。',
      '只能选择可用 skills 中的准确 skillId；不能把未启用的技能静默替换为另一个技能。',
      '',
      '只输出 JSON，不要 markdown。Schema:',
      ROUTER_OUTPUT_SCHEMA,
      '',
      'action 说明：',
      '- continue_current: 本轮是在继续修改已有 draft。',
      '- switch_skill: 本轮明确应使用某个可用 structure-type skill。',
      '- unsupported: 本轮明确要求当前可用 skills 不支持的结构类型；输出具体 structuralTypeKey、mappedType="unknown"、supportLevel="unsupported"，不要填写 skillId。',
      '- generic: 描述有结构意图，但不宜由具体 skill 硬判，先交给 generic。',
      '- ask: 信息不足以稳定判断，交给 generic 追问。',
      '',
      '可用 skills:',
      skillsJson,
      '',
      `当前 skill:\n${currentSkill}`,
      '',
      `当前 draftState:\n${stateJson}`,
      '',
      '',
      `用户最新消息:\n${input.message}`,
    ].join('\n');
  }

  return [
    'You are the structural-type router for a structural engineering conversation. Decide whether the latest user message should continue the current draft, switch to a structure skill, or go to generic clarification.',
    '',
    'Do not continue the current draft just because it exists; continue only when the user is editing, supplementing, answering a clarification, or explicitly referring to the current model.',
    'If the latest message looks like a new structural description, especially a shift from a member draft to a building/grid/story/system description, do not lock it to the old draft.',
    'A beam mentioned in "load on the beam" may be member context inside a frame; a column mentioned in "column grid/spacing" is usually not a standalone column.',
    'Clarification questions, unselected options and assistant suggestions are unconfirmed context. Route the actual user answer, not unselected alternatives.',
    'Select an exact skillId from the available skills. Do not silently replace a disabled skill with a different skill.',
    '',
    'Return JSON only, no markdown. Schema:',
    ROUTER_OUTPUT_SCHEMA,
    '',
    'Use action="unsupported" when the requested structural type is clearly outside the available skills. Provide its structuralTypeKey, mappedType="unknown", supportLevel="unsupported", and omit skillId.',
    '',
    'Available skills:',
    skillsJson,
    '',
    `Current skill:\n${currentSkill}`,
    '',
    `Current draftState:\n${stateJson}`,
    '',
    '',
    `Latest user message:\n${input.message}`,
  ].join('\n');
}

export async function invokeStructuralTypeRouter(input: StructuralRouterInput): Promise<StructuralTypeMatch | null> {
  let result: Awaited<ReturnType<RouterLlm['invoke']>>;
  try {
    result = await input.llm.invoke(buildRouterPrompt(input), { signal: input.signal });
  } catch (error) {
    throw new Error(
        `LLM_STRUCTURAL_ROUTER_INFRASTRUCTURE_ERROR: The LLM request failed; structural interpretation stopped. / 大模型请求失败，结构语义判断已停止。 ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
  }
  const usage = extractLlmTokenUsage(result);
  if (usage) input.onUsage?.(usage);
  const content = llmContentText(result.content);
  const parsed = parseJsonObject(content);
  const decision = parsed ? normalizeDecision(parsed) : null;
  const match = decision ? resolveRouterMatch(decision, input) : null;
  return match;
}
