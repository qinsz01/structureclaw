import type { AppLocale } from '../../../shared/locale.js';
import { getCommonConstraints } from './llm-model-prompt-fragments.js';
import { modelContract, promptContract } from '../../../engineering/draft-contract.js';

type GenericModelPromptIntent = 'build-structure-model-v2';

type PromptIntentConfig = {
  opening: (locale: AppLocale) => string[];
  closing: (locale: AppLocale, stateHint: string, message: string, conversationHistory?: string) => string[];
};

const INTENT_CONFIGS: Record<GenericModelPromptIntent, PromptIntentConfig> = {
  'build-structure-model-v2': {
    opening: (locale) => {
      if (locale === 'zh') {
        return [
          '你是结构建模专家。',
          '请根据用户描述输出可计算的 StructureModel V2 JSON。',
          '只输出 JSON 对象，不要 Markdown。',
          '使用 {"schema_version":"2.2.0"} 和下方正式字段定义。节点、构件、属性及荷载全部依据本次用户资料建立；没有预设算例可复制。',
        ];
      }
      return [
        'You are a structural modeling expert.',
        'Generate a computable StructureModel V2 JSON from the user request.',
        'Return JSON object only, without markdown.',
        'Use {"schema_version":"2.2.0"} and the formal field definitions below. Generate nodes, members, properties and loads from this request; there is no preset example structure to copy.',
      ];
    },
    closing: (locale, stateHint, message, conversationHistory) => {
      const lines: string[] = [];
      if (conversationHistory) {
        lines.push(locale === 'zh' ? `对话历史:\n${conversationHistory}` : `Conversation history:\n${conversationHistory}`);
      }
      if (locale === 'zh') {
        lines.push(`已确认参数: ${stateHint}`);
        lines.push(`用户最新输入: ${message}`);
      } else {
        lines.push(`Confirmed parameters: ${stateHint}`);
        lines.push(`Latest user message: ${message}`);
      }
      return lines;
    },
  },
};

export function composePromptByIntent(
  intent: GenericModelPromptIntent,
  locale: AppLocale,
  stateHint: string,
  message: string,
  conversationHistory?: string,
): string {
  const config = INTENT_CONFIGS[intent];
  const opening = config.opening(locale);
  const constraints = getCommonConstraints(locale);
  const closing = config.closing(locale, stateHint, message, conversationHistory);
  return [...opening, ...constraints,
    `Authoritative model schema / 正式模型字段定义（模板仅为格式示例，不是用户模型）:\n${JSON.stringify(promptContract(modelContract))}`,
    ...closing].join('\n');
}
