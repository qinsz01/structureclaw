import type { AppLocale } from '../shared/locale.js';
import type { DraftState, InteractionQuestion } from '../shared/types/agent.js';
import { isRecord } from '../engineering/model-state.js';
import { completeDeclaredGradeMaterials, resolveTemplateMaterials, sectionRequiresNumericDefinition, stiffnessPlaceholderUses } from './template-properties.js';
import { materialPropertyQuestions } from './material-readiness.js';

const PHYSICS = {
  geometry: { en: 'Geometry and connections', zh: '几何与连接关系',
    question: { en: 'Provide the dimensions and member connectivity, or describe the complete geometry to be generated.', zh: '请提供尺寸与构件连接关系，或完整描述需要生成的几何。' } },
  supports: { en: 'Supports', zh: '支座约束',
    question: { en: 'Specify the support locations and restrained directions.', zh: '请明确支座位置及约束方向。' } },
  loads: { en: 'Load targets and directions', zh: '荷载目标与方向',
    question: { en: 'Specify all load magnitudes, directions and targets, or explicitly confirm that there are no applied loads.', zh: '请一次给出所有荷载的数值、方向与施加位置，或明确没有外荷载。' } },
  properties: { en: 'Analysis properties', zh: '分析属性',
    question: { en: 'Provide the missing material constants or grade and the member sections with dimensions or evidenced properties. Forces alone may use labelled unit stiffness.', zh: '请提供缺少的材料常数或牌号，以及各构件截面的尺寸或有依据的属性；仅求内力时可使用标注的单位刚度。' } },
} as const;

/** Free-form readiness is about physical facts, never a recognised template name. */
export function genericMissing(state: DraftState): string[] {
  const draft = state.engineeringDraft;
  const model = isRecord(draft?.model) ? draft.model : undefined;
  const nodes = model?.nodes ?? draft?.topology?.nodes;
  const members = model?.elements ?? draft?.topology?.members;
  const description = draft?.metadata;
  const missing: string[] = [];
  const geometry = Array.isArray(nodes) && nodes.length >= 2 && Array.isArray(members) && members.length > 0
    || Object.values(draft?.geometry ?? {}).some(value => value !== undefined)
    || typeof description?.geometryDescription === 'string' && !!description.geometryDescription.trim();
  if (!geometry) missing.push('geometry');
  const supported = Array.isArray(nodes) && nodes.some(node => isRecord(node) && Array.isArray(node.restraints) && node.restraints.some(value => value === true))
    || Object.values(draft?.boundary ?? {}).some(value => value !== undefined)
    || typeof description?.supportDescription === 'string' && !!description.supportDescription.trim();
  if (!supported) missing.push('supports');
  const cases = model?.load_cases ?? draft?.loadCases;
  if (!(Array.isArray(cases) || draft?.loads?.length || description?.zeroLoads === true)) missing.push('loads');
  const placeholder = stiffnessPlaceholderUses(state);
  let materials = Array.isArray(model?.materials) ? completeDeclaredGradeMaterials(model.materials.filter(isRecord)) : [];
  if (!materials.length) { try { materials = resolveTemplateMaterials(state); } catch { /* Missing or unknown grade. */ } }
  const materialReady = placeholder.material || materials.length > 0 && materials.every(material => Number(material.E) > 0 && Number.isFinite(material.nu));
  const sections = model?.sections ?? draft?.sectionRecords;
  const sectionReady = placeholder.section || Array.isArray(sections) && sections.length > 0
    && sections.every(section => isRecord(section) && !sectionRequiresNumericDefinition(section, draft))
    || Object.values(draft?.sections ?? {}).some(value => typeof value === 'string' && !!value.trim());
  const materialMissing = materialPropertyQuestions(state, 'en').map(question => question.paramKey);
  missing.push(...materialMissing);
  if (!materialReady && !materialMissing.length || !sectionReady) missing.push('properties');
  const issues = state.draftIssues?.flatMap(issue => issue.field ? [issue.field] : []) ?? [];
  const invalid = Array.isArray(state.skillState?.invalidDraftFields) ? state.skillState.invalidDraftFields.filter((field): field is string => typeof field === 'string') : [];
  return [...new Set([...missing, ...issues, ...invalid])];
}

export function genericQuestions(keys: string[], state: DraftState | undefined, locale: AppLocale): InteractionQuestion[] {
  return keys.map(paramKey => {
    const material = state ? materialPropertyQuestions(state, locale).find(question => question.paramKey === paramKey) : undefined;
    if (material) return material;
    const rule = PHYSICS[paramKey as keyof typeof PHYSICS];
    const issue = state?.draftIssues?.find(item => item.field === paramKey);
    return { paramKey, label: rule?.[locale] ?? paramKey,
      question: issue?.question ?? rule?.question[locale] ?? issue?.reason ?? paramKey, required: true, critical: true };
  });
}
