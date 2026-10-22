import { engineeringKnowledge } from '../../../engineering/knowledge.js';
import type { AppLocale } from '../../../shared/locale.js';
import type { DraftState } from '../../../shared/types/agent.js';
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
  const base = [composePromptByIntent('build-structure-model-v2', locale, stateHint, message, conversationHistory),
    engineeringKnowledge(locale, ['loads', 'boundaries', 'combinations', 'validation']),
    locale === 'zh' ? '端释放协议：releases 使用 i/j 下的局部自由度布尔值 ux/uy/uz/rx/ry/rz；不要写成力或弯矩结果字段。纯轴力杆已具有自由转动，不需要另选单元表示；平移释放、偏心与冲突定义不得删除或自行更改。'
      : 'End-release contract: releases uses boolean local DOFs ux/uy/uz/rx/ry/rz under i/j, not force or moment result fields. Axial members already have free rotations; no representation choice is needed. Never remove or guess translational releases, offsets or conflicting definitions.',
  ].filter(Boolean).join('\n');
  if (!currentModel) return base;
  return `${base}\n\n${locale === 'zh'
    ? '当前已确认的完整 V2 模型如下。本轮只改变用户明确指定的对象和字段，保留其余节点、连接、属性、荷载与组合及其 ID；不要按结构名称重建或简化。目标不唯一或关键数据缺失时不得猜测。'
    : 'The complete confirmed V2 model follows. Change only the objects and fields explicitly requested this turn. Preserve all other nodes, connectivity, properties, loads, combinations and IDs; do not rebuild or simplify from the structure name. Never guess an ambiguous target or missing critical value.'}\n${JSON.stringify(currentModel)}`;
}

export function buildRetrySuffix(locale: AppLocale, error: string, candidate: string): string {
  const instruction = locale === 'zh'
    ? '上一候选模型未通过校验。依据下面的实际错误修正字段；保留用户已确认的几何、荷载与属性，不通过删减需求绕过错误。只返回完整 JSON 模型。'
    : 'The previous candidate failed validation. Correct the fields using the actual error below. Preserve confirmed geometry, loads and properties; do not remove requirements to evade validation. Return the complete JSON model only.';
  return `\n${instruction}\n${JSON.stringify({ validationError: error, previousCandidate: candidate })}`;
}
