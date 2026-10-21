import { genericMissing, genericQuestions } from '../../../agent-runtime/generic-readiness.js';
import { ingestGenericDraft, mergeGenericDraftState } from '../../../agent-runtime/draft/boundary.js';
import { buildStructuralTypeMatch } from '../../../agent-runtime/plugin-helpers.js';
import type {
  SkillHandler,
  SkillReportNarrativeInput,
} from '../../../shared/types/agent.js';

function buildGenericReportNarrative(input: SkillReportNarrativeInput): string {
  const metricCount = Object.keys(input.keyMetrics || {}).length;
  if (input.locale === 'zh') {
    const lines = [
      '已完成通用结构流程的分析汇总。',
      `分析类型：${input.analysisType}。`,
      `执行状态：${input.analysisSuccess ? '成功' : '失败'}。`,
      input.summary ? `结果摘要：${input.summary}` : '结果摘要：请结合结构化结果查看详细信息。',
    ];
    if (metricCount > 0) {
      lines.push(`已提取 ${metricCount} 项关键指标，请结合结构化输出核对。`);
    }
    if (input.codeCheckText?.trim()) {
      lines.push('已包含规范校核文本结果。');
    }
    return lines.join('\n');
  }

  const lines = [
    'The generic structural workflow summary is complete.',
    `Analysis type: ${input.analysisType}.`,
    `Execution status: ${input.analysisSuccess ? 'success' : 'failed'}.`,
    input.summary
      ? `Summary: ${input.summary}`
      : 'Summary: review the structured outputs for detailed engineering values.',
  ];
  if (metricCount > 0) {
    lines.push(`${metricCount} key metric entries were extracted from the analysis output.`);
  }
  if (input.codeCheckText?.trim()) {
    lines.push('Code-check text output is included in this report context.');
  }
  return lines.join('\n');
}

export const handler: SkillHandler = {
  // Whether a message is a structural request is the agent's and the LLM router's decision; the
  // generic skill is the advisory fallback whenever no specific skill matches.
  detectStructuralType({ locale, currentState }) {
    if (currentState?.skillId === 'generic') {
      return buildStructuralTypeMatch(
        currentState.structuralTypeKey ?? 'unknown',
        currentState.inferredType,
        'generic',
        currentState.supportLevel ?? 'fallback',
        locale,
        {
          zh: '继续使用通用结构类型 skill 处理当前对话。',
          en: 'Continue using the generic structure-type skill for the current conversation.',
        },
        'current-state',
      );
    }

    return buildStructuralTypeMatch('unknown', 'unknown', 'generic', 'fallback', locale, {
      zh: '已切换到通用结构类型 skill，先接住当前问题并继续补参。',
      en: 'Switched to the generic structure-type skill to catch the request and continue clarification.',
    }, 'generic-fallback');
  },

  parseProvidedValues(values) {
    return ingestGenericDraft(values);
  },

  extractDraft({ llmDraftPatch, currentState, message }) {
    return ingestGenericDraft(llmDraftPatch, currentState, message);
  },

  mergeState(existing, patch) {
    return mergeGenericDraftState(existing, patch);
  },

  computeMissing(state) {
    return { critical: genericMissing(state), optional: [] };
  },

  mapLabels(keys, locale) {
    return genericQuestions(keys, undefined, locale).map(question => question.label);
  },

  buildQuestions(keys, _criticalMissing, state, locale) {
    return genericQuestions(keys, state, locale);
  },

  buildDefaultProposals() {
    return [];
  },

  buildReportNarrative(input: SkillReportNarrativeInput) {
    return buildGenericReportNarrative(input);
  },

  buildModel() {
    return undefined;
  },

  resolveStage(_missingKeys, state) {
    return genericMissing(state).length ? 'intent' : 'model';
  },
};

export default handler;
