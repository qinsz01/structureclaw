import { buildExplicitDraftModel } from './explicit-model.js';
import { templatePropertyIssues } from './template-properties.js';
import { isValidConcreteGrade, isValidRebarGrade, resolveSectionProps } from '../agent-skills/structure-type/concrete-frame/model.js';
import type { AgentSkillPlugin, DraftState, InteractionQuestion, SkillMissingResult } from './types.js';
import type { AppLocale } from '../services/locale.js';

type ReadinessPlugin = Pick<AgentSkillPlugin, 'id' | 'handler'>;

/** One draft readiness decision for extraction, clarification, and formal model creation. */
export function computeDraftMissing(plugin: ReadinessPlugin, state: DraftState, phase: 'interactive' | 'execution'): SkillMissingResult {
  try {
    if (buildExplicitDraftModel(state)) return { critical: [], optional: [] };
  } catch {
    return { critical: ['engineeringDraft'], optional: [] };
  }
  const missing = plugin.handler.computeMissing(state, phase);
  const critical = [...missing.critical];
  if (plugin.id === 'generic') return missing;
  if (plugin.id === 'concrete-frame') {
    if (typeof state.frameConcreteGrade !== 'string' || !isValidConcreteGrade(state.frameConcreteGrade)) critical.push('frameConcreteGrade');
    if (typeof state.frameRebarGrade !== 'string' || !isValidRebarGrade(state.frameRebarGrade)) critical.push('frameRebarGrade');
    for (const field of ['frameBeamSection', 'frameColumnSection'] as const) {
      try {
        if (typeof state[field] !== 'string' || !state[field]) throw new Error('missing');
        resolveSectionProps(state[field] as string, 1);
      } catch { critical.push(field); }
    }
  } else if (['beam', 'frame', 'truss', 'column', 'double-span-beam', 'portal-frame'].includes(plugin.id) && templatePropertyIssues(state).length) {
    critical.push('templateProperties');
  }
  return { critical: [...new Set(critical)], optional: missing.optional.filter((key) => !critical.includes(key)) };
}

export function buildDraftQuestions(plugin: ReadinessPlugin | null | undefined, critical: string[], optional: string[], state: DraftState, locale: AppLocale): InteractionQuestion[] {
  if (!plugin || critical.length === 0) return [];
  const questions = plugin.handler.buildQuestions([...critical, ...optional], critical, state, locale)
    .filter((question) => !['templateProperties', 'engineeringDraft'].includes(question.paramKey));
  const isZh = locale === 'zh';
  if (critical.includes('templateProperties')) {
    questions.push({ paramKey: 'templateProperties', label: isZh ? '材料、截面与构件分配' : 'Materials, sections, and member assignments',
      question: isZh
        ? `请补充材料牌号或完整弹性属性、各类构件截面及其对应关系。${templatePropertyIssues(state).join(' ')}`
        : `Provide a material grade or complete elastic properties, sections, and their member-role assignments. ${templatePropertyIssues(state).join(' ')}`,
      required: true, critical: true });
  }
  if (critical.includes('engineeringDraft')) {
    let detail = '';
    try { buildExplicitDraftModel(state); } catch (error) { detail = error instanceof Error ? error.message : String(error); }
    questions.push({ paramKey: 'engineeringDraft', label: isZh ? '显式模型缺项或冲突' : 'Incomplete or inconsistent explicit model',
      question: detail, required: true, critical: true });
  }
  return questions.filter((question, index) => questions.findIndex((entry) => entry.paramKey === question.paramKey) === index);
}
