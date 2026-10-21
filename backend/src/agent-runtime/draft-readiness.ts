import { materialPropertyQuestions } from './material-readiness.js';
import { buildExplicitDraftModel } from './explicit-model.js';
import { sectionRequiresNumericDefinition, templatePropertyIssues } from './template-properties.js';
import type { AgentSkillPlugin, DraftState, InteractionQuestion, SkillMissingResult } from '../shared/types/agent.js';
import type { AppLocale } from '../shared/locale.js';
import { missingInputReason, type RequestScope } from '../engineering/request-scope.js';
import { isRecord } from '../engineering/model-state.js';
import { isDesignDraftField } from './draft-guidance.js';
import { currentDraftDiagnostics, unresolvedDraftFields } from './draft-diagnostics.js';
import { currentRunPolicy } from '../runtime/run-context.js';
import { sectionConfirmationCandidates } from '../engineering/section-provenance.js';

type ReadinessPlugin = Pick<AgentSkillPlugin, 'id' | 'handler'>;


export function draftSectionConfirmations(state: DraftState): Record<string, unknown>[] {
  const draft = state.engineeringDraft;
  const sections = draft?.model?.sections ?? draft?.sectionRecords;
  const pending = sectionConfirmationCandidates(sections);
  const records = Array.isArray(sections) ? sections.filter(isRecord) : [];
  return [...pending, ...records.filter(section => !pending.some(candidate => candidate.id === section.id)
    && sectionRequiresNumericDefinition(section, draft)).map(section => ({
    id: section.id, name: section.name, fields: ['shape'], requiresNumericDefinition: true,
  }))];
}

/** Keep confirmation alongside other missing inputs, including for explicit and LLM-built models. */
export function computeDraftMissing(plugin: ReadinessPlugin, state: DraftState, phase: 'interactive' | 'execution'): SkillMissingResult {
  const missing = computeOtherDraftMissing(plugin, state, phase);
  return { ...missing, critical: [...new Set([...missing.critical,
    ...(draftSectionConfirmations(state).length ? ['sectionConfirmation'] : [])])] };
}

function computeOtherDraftMissing(plugin: ReadinessPlugin, state: DraftState, phase: 'interactive' | 'execution'): SkillMissingResult {
  if (plugin.id === 'generic') {
    const missing = plugin.handler.computeMissing(state, phase);
    return { critical: missing.critical.filter(field => !isDesignDraftField(field)), optional: missing.optional.filter(field => !isDesignDraftField(field)) };
  }
  state = currentDraftDiagnostics(state);
  const scope = state.requestScope as RequestScope | undefined;
  if (currentRunPolicy()?.builder === 'llm') {
    // Templates describe one geometry recipe, not what the LLM must ask users.
    // Actual unresolved evidence still blocks; the generated model must pass the
    // same formal/physical validation as every other model before execution.
    return { critical: unresolvedDraftFields(state).filter(field => !isDesignDraftField(field)), optional: [] };
  }
  const propertyMissing = materialPropertyQuestions(state, 'en').map((question) => question.paramKey);
  if (propertyMissing.length) return { critical: propertyMissing, optional: [] };
  try {
    if (buildExplicitDraftModel(state)) return { critical: [], optional: [] };
  } catch {
    return { critical: ['engineeringDraft'], optional: [] };
  }
  const missing = plugin.handler.computeMissing(state, phase);
  // Design inputs never block or prompt the analysis workflow; an explicitly requested code check
  // reports them itself. An absent rebar grade is such an input: elastic analysis never needs it.
  const critical = missing.critical.filter(field => !isDesignDraftField(field) && (field !== 'frameRebarGrade' || !!state.frameRebarGrade));
  const optional = [...new Set(missing.optional.filter(field => !isDesignDraftField(field)))];
  // Skill-specific design prerequisites come from the resolved handler (e.g. concrete-frame grades/sections).
  const designMissing = scope?.design !== false ? plugin.handler.computeDesignMissing?.(state) : undefined;
  if (designMissing) {
    critical.push(...designMissing);
  } else if (['beam', 'frame', 'concrete-frame', 'truss', 'column', 'double-span-beam', 'portal-frame'].includes(plugin.id) && templatePropertyIssues(state).length) {
    critical.push('templateProperties');
  }
  return { critical: [...new Set(critical)], optional: optional.filter((key) => !critical.includes(key)) };
}

export function buildDraftQuestions(plugin: ReadinessPlugin | null | undefined, critical: string[], optional: string[], state: DraftState, locale: AppLocale): InteractionQuestion[] {
  if (!plugin || critical.length === 0) return [];
  const propertyQuestions = materialPropertyQuestions(state, locale).filter((question) => critical.includes(question.paramKey));
  const questions = plugin.handler.buildQuestions([...critical, ...optional], critical, state, locale)
    .filter((question) => !['templateProperties', 'engineeringDraft', 'sectionConfirmation'].includes(question.paramKey)
      && !propertyQuestions.some((property) => property.paramKey === question.paramKey));
  questions.push(...propertyQuestions);
  const isZh = locale === 'zh';
  if (critical.includes('sectionConfirmation')) {
    questions.push({ paramKey: 'sectionConfirmation', label: isZh ? '确认截面尺寸' : 'Confirm section dimensions',
      question: isZh ? '请提供或确认截面尺寸；助手记忆的标准表值，请核对。请与其他确实缺少的输入合并询问一次，确认前不得计算。'
        : 'Provide or confirm the section dimensions; assistant-recalled table value, please verify. Ask once together with other genuinely missing inputs; do not calculate before confirmation.',
      suggestedValue: draftSectionConfirmations(state), required: true, critical: true });
  }
  if (critical.includes('templateProperties')) {
    const details = templatePropertyIssues(state).map((issue) => {
      const parts = issue.replace(/^[A-Z_]+:\s*/, '').split(' / ');
      return isZh ? parts.at(-1) : parts[0];
    }).join(' ');
    questions.push({ paramKey: 'templateProperties', label: isZh ? '材料、截面与构件分配' : 'Materials, sections, and member assignments',
      question: isZh
        ? `请补充材料牌号或完整弹性属性、各类构件截面及其对应关系。${details} ${missingInputReason('templateProperties', state.requestScope as RequestScope | undefined, locale)}`
        : `Provide a material grade or complete elastic properties, sections, and their member-role assignments. ${details} ${missingInputReason('templateProperties', state.requestScope as RequestScope | undefined, locale)}`,
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

/** Critical fields with their blocking reason, so the agent sees why a template cannot be built. */
export function describeCriticalMissing(critical: string[], state: DraftState): string[] {
  return critical.map(field => {
    if (field !== 'templateProperties') return field;
    const issues = templatePropertyIssues(state).map(issue => issue.replace(/^[A-Z_]+:\s*/, ''));
    return issues.length ? `${field} (${issues.join('; ')})` : field;
  });
}
