import type { AppLocale } from '../shared/locale.js';
import type { DraftState, InteractionQuestion } from '../shared/types/agent.js';
import { isRecord } from '../engineering/model-state.js';
import { completeDeclaredGradeMaterials } from './template-properties.js';

export function materialPropertyQuestions(state: DraftState, locale: AppLocale): InteractionQuestion[] {
  const draft = state.engineeringDraft;
  // Template records use the same grade projection as model construction.
  const records = draft?.model?.materials ?? (Array.isArray(draft?.materials) ? completeDeclaredGradeMaterials(draft.materials) : undefined);
  if (!Array.isArray(records)) return [];
  const prefix = draft?.model ? 'model.materials' : 'materials';
  const isZh = locale === 'zh';
  const control = isRecord(draft?.model?.analysis_control) ? draft.model.analysis_control : draft?.analysisControl;
  const densityMass = (draft?.analysis?.type === 'dynamic' || draft?.analysis?.type === 'seismic')
    && !['nodal', 'floor-seismic'].includes(String(control?.mass_source));
  const densityRequired = control?.self_weight !== false || densityMass
    || ['pkpm', 'yjk'].includes(String(draft?.analysis?.engineTarget));
  return records.flatMap((material, index): InteractionQuestion[] => {
    if (!material || typeof material !== 'object') return [];
    const id = typeof material.id === 'string' && material.id.trim() ? material.id : `[${index}]`;
    const fields: Array<[string, string, string, boolean]> = [
      ['id', '材料标识', 'material ID', typeof material.id === 'string' && !!material.id.trim()],
      ['name', '材料名称', 'material name', typeof material.name === 'string' && !!material.name.trim()],
      ['E', '弹性模量 E（MPa，正数）', 'elastic modulus E (MPa, positive)', typeof material.E === 'number' && Number.isFinite(material.E) && material.E > 0],
      ['nu', '泊松比 nu（0 ≤ nu < 0.5）', 'Poisson ratio nu (0 ≤ nu < 0.5)', typeof material.nu === 'number' && Number.isFinite(material.nu) && material.nu >= 0 && material.nu < 0.5],
      ...(densityRequired || material.rho != null ? [['rho', '密度 rho（kg/m³，正数）', 'density rho (kg/m³, positive)', typeof material.rho === 'number' && Number.isFinite(material.rho) && material.rho > 0] as [string, string, string, boolean]] : []),
    ];
    if (material.G != null) fields.push(['G', '剪切模量 G（MPa，正数）', 'shear modulus G (MPa, positive)', typeof material.G === 'number' && Number.isFinite(material.G) && material.G > 0]);
    return fields.filter(([, , , valid]) => !valid).map(([key, zh, en]) => ({
      paramKey: `${prefix}.${id}.${key}`, label: isZh ? `${id}：${zh}` : `${id}: ${en}`,
      question: isZh ? `请补充或修正材料 ${id} 的${zh}。` : `Provide or correct ${en} for material ${id}.`,
      required: true, critical: true,
    }));
  });
}
