import type { AppLocale } from '../../../services/locale.js';
import type { DraftState } from '../../../agent-runtime/types.js';
import { composePromptByIntent } from './llm-model-prompt-intents.js';

const STATE_METADATA_KEYS = new Set([
  'skillId', 'supportLevel', 'supportNote', 'updatedAt', 'structuralTypeKey',
]);

function buildCleanStateHint(state: DraftState): string {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!STATE_METADATA_KEYS.has(key) && value !== undefined) {
      filtered[key] = value;
    }
  }
  return JSON.stringify(filtered);
}

export function buildGenericModelPrompt(
  message: string,
  state: DraftState,
  locale: AppLocale,
  conversationHistory?: string,
  currentModel?: Record<string, unknown>,
): string {
  const stateHint = buildCleanStateHint(state);
  const base = composePromptByIntent('build-structure-model-v2', locale, stateHint, message, conversationHistory);
  if (!currentModel) return base;
  return `${base}\n\n${locale === 'zh'
    ? '当前已确认的完整 V2 模型如下。本轮只改变用户明确指定的对象和字段，保留其余节点、连接、属性、荷载与组合及其 ID；不要按结构名称重建或简化。目标不唯一或关键数据缺失时不得猜测。'
    : 'The complete confirmed V2 model follows. Change only the objects and fields explicitly requested this turn. Preserve all other nodes, connectivity, properties, loads, combinations and IDs; do not rebuild or simplify from the structure name. Never guess an ambiguous target or missing critical value.'}\n${JSON.stringify(currentModel)}`;
}

export function buildRetrySuffix(locale: AppLocale): string {
  return locale === 'zh'
    ? '\n上一轮输出未通过 JSON 校验。请仅返回合法 JSON 对象。'
    : '\nThe previous output did not pass JSON validation. Return a valid JSON object only.';
}
