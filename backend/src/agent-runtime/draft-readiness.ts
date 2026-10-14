import { buildExplicitDraftModel } from './explicit-model.js';
import { templatePropertyIssues } from './template-properties.js';
import { isValidConcreteGrade, isValidRebarGrade, resolveSectionProps } from '../agent-skills/structure-type/concrete-frame/model.js';
import type { AgentSkillPlugin, DraftState, InteractionQuestion, SkillMissingResult } from './types.js';
import type { AppLocale } from '../services/locale.js';

type ReadinessPlugin = Pick<AgentSkillPlugin, 'id' | 'handler'>;

function materialPropertyQuestions(state: DraftState, locale: AppLocale): InteractionQuestion[] {
  const draft = state.engineeringDraft;
  const records = draft?.model?.materials ?? draft?.materials;
  if (!Array.isArray(records)) return [];
  const prefix = draft?.model ? 'model.materials' : 'materials';
  const isZh = locale === 'zh';
  return records.flatMap((material, index): InteractionQuestion[] => {
    if (!material || typeof material !== 'object') return [];
    const id = typeof material.id === 'string' && material.id.trim() ? material.id : `[${index}]`;
    const fields: Array<[string, string, string, boolean]> = [
      ['id', '材料标识', 'material ID', typeof material.id === 'string' && !!material.id.trim()],
      ['name', '材料名称', 'material name', typeof material.name === 'string' && !!material.name.trim()],
      ['E', '弹性模量 E（MPa，正数）', 'elastic modulus E (MPa, positive)', typeof material.E === 'number' && Number.isFinite(material.E) && material.E > 0],
      ['nu', '泊松比 nu（0 ≤ nu < 0.5）', 'Poisson ratio nu (0 ≤ nu < 0.5)', typeof material.nu === 'number' && Number.isFinite(material.nu) && material.nu >= 0 && material.nu < 0.5],
      ['rho', '密度 rho（kg/m³，正数）', 'density rho (kg/m³, positive)', typeof material.rho === 'number' && Number.isFinite(material.rho) && material.rho > 0],
    ];
    if (material.G !== undefined) fields.push(['G', '剪切模量 G（MPa，正数）', 'shear modulus G (MPa, positive)', typeof material.G === 'number' && Number.isFinite(material.G) && material.G > 0]);
    return fields.filter(([, , , valid]) => !valid).map(([key, zh, en]) => ({
      paramKey: `${prefix}.${id}.${key}`, label: isZh ? `${id}：${zh}` : `${id}: ${en}`,
      question: isZh ? `请补充或修正材料 ${id} 的${zh}。` : `Provide or correct ${en} for material ${id}.`,
      required: true, critical: true,
    }));
  });
}

/** One draft readiness decision for extraction, clarification, and formal model creation. */
export function computeDraftMissing(plugin: ReadinessPlugin, state: DraftState, phase: 'interactive' | 'execution'): SkillMissingResult {
  const propertyMissing = materialPropertyQuestions(state, 'en').map((question) => question.paramKey);
  if (propertyMissing.length) return { critical: propertyMissing, optional: [] };
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
        resolveSectionProps(state[field] as string);
      } catch { critical.push(field); }
    }
  } else if (['beam', 'frame', 'truss', 'column', 'double-span-beam', 'portal-frame'].includes(plugin.id) && templatePropertyIssues(state).length) {
    critical.push('templateProperties');
  }
  return { critical: [...new Set(critical)], optional: missing.optional.filter((key) => !critical.includes(key)) };
}

export function buildDraftQuestions(plugin: ReadinessPlugin | null | undefined, critical: string[], optional: string[], state: DraftState, locale: AppLocale): InteractionQuestion[] {
  if (!plugin || critical.length === 0) return [];
  const propertyQuestions = materialPropertyQuestions(state, locale).filter((question) => critical.includes(question.paramKey));
  const questions = plugin.handler.buildQuestions([...critical, ...optional], critical, state, locale)
    .filter((question) => !['templateProperties', 'engineeringDraft'].includes(question.paramKey)
      && !propertyQuestions.some((property) => property.paramKey === question.paramKey));
  questions.push(...propertyQuestions);
  const isZh = locale === 'zh';
  if (critical.includes('templateProperties')) {
    const details = templatePropertyIssues(state).map((issue) => {
      const parts = issue.replace(/^[A-Z_]+:\s*/, '').split(' / ');
      return isZh ? parts.at(-1) : parts[0];
    }).join(' ');
    questions.push({ paramKey: 'templateProperties', label: isZh ? '材料、截面与构件分配' : 'Materials, sections, and member assignments',
      question: isZh
        ? `请补充材料牌号或完整弹性属性、各类构件截面及其对应关系。${details}`
        : `Provide a material grade or complete elastic properties, sections, and their member-role assignments. ${details}`,
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
