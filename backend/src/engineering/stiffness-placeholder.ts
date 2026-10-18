/**
 * Placeholder stiffness for force-only requests that give no material or section.
 *
 * Reactions and internal forces of a statically determinate structure do not depend on stiffness, and an
 * indeterminate structure whose members all share one EI distributes forces by geometry alone. The
 * solver still needs numbers, so a clearly labelled unit material/section is used. Displacements from
 * such a run are meaningless and are never presented; a later displacement or design request must
 * supply the real material and section.
 */
import { isRecord, type ModelRecord } from './model-state.js';

export const PLACEHOLDER_LABEL = {
  zh: '仅用于内力计算的单位刚度',
  en: 'unit stiffness for force analysis only',
} as const;

const PLACEHOLDER_NAME = `${PLACEHOLDER_LABEL.en} / ${PLACEHOLDER_LABEL.zh}`;

/** Unit elastic modulus (MPa). Self-weight is impossible without real data, so no density is given. */
export function placeholderMaterialRecord(id = '1'): ModelRecord {
  return { id, name: PLACEHOLDER_NAME, category: 'other', E: 1, nu: 0.3, extra: { stiffnessPlaceholder: true } };
}

/**
 * Unit bending stiffness for every member. The large area makes axial deformation negligible, as in
 * classical force analysis, so frame moments follow the equal-EI distribution.
 */
export function placeholderSectionRecord(id = '1', purpose: 'beam' | 'column' = 'beam'): ModelRecord {
  return { id, name: PLACEHOLDER_NAME, type: 'custom', purpose,
    properties: { A: 1e4, Iy: 1, Iz: 1, J: 1 }, extra: { stiffnessPlaceholder: true } };
}

export interface StiffnessPlaceholder {
  material: boolean;
  section: boolean;
  /** Degree of static indeterminacy; null when the member mix does not allow a simple count. */
  staticIndeterminacy: number | null;
  /** Forces depend on an assumed equal EI (indeterminate, or not provably determinate, with placeholder sections). */
  equalStiffnessAssumed: boolean;
  notice: { zh: string; en: string };
}

const ACTIVE_2D_DOFS = [0, 2, 4];
const FRAME_TYPES = new Set(['beam', 'column', 'brace']);

/** Count r + member unknowns - joint equations for rigid frames or pin-jointed trusses; null otherwise. */
export function staticIndeterminacy(model: ModelRecord): number | null {
  const nodes = Array.isArray(model.nodes) ? model.nodes.filter(isRecord) : [];
  const elements = Array.isArray(model.elements) ? model.elements.filter(isRecord) : [];
  if (!nodes.length || !elements.length) return null;
  const declared = isRecord(model.coordinate_system) ? model.coordinate_system.dimension
    : isRecord(model.metadata) ? model.metadata.frameDimension : undefined;
  const dimension = declared === '3d' ? '3d' : '2d';
  const frame = elements.every(element => FRAME_TYPES.has(String(element.type ?? 'beam')) && !element.releases);
  const truss = elements.every(element => element.type === 'truss');
  if (!frame && !truss) return null;
  const connected = new Set(elements.flatMap(element => Array.isArray(element.nodes) ? element.nodes.map(String) : []));
  const dofs = dimension === '3d' ? [0, 1, 2, 3, 4, 5] : ACTIVE_2D_DOFS;
  const translational = dofs.filter(index => index < 3);
  const reactions = nodes.filter(node => connected.has(String(node.id))).reduce((sum, node) => {
    const restraints = Array.isArray(node.restraints) ? node.restraints : [];
    return sum + (truss ? translational : dofs).filter(index => restraints[index] === true).length;
  }, 0);
  const joints = connected.size;
  if (truss) return elements.length + reactions - translational.length * joints;
  return dofs.length * elements.length + reactions - dofs.length * joints;
}

function placeholderNotice(plan: Pick<StiffnessPlaceholder, 'material' | 'section' | 'staticIndeterminacy' | 'equalStiffnessAssumed'>) {
  if (plan.equalStiffnessAssumed) {
    const degree = plan.staticIndeterminacy;
    return {
      zh: `结构为超静定${degree ? `（${degree}次）` : ''}且未给出材料截面：按所有构件 EI 相同（忽略轴向变形）计算内力，回答中必须明确说明此假定。位移未计算；如需挠度/位移或规范验算，请提供实际材料和截面。`,
      en: `The structure is statically indeterminate${degree ? ` (degree ${degree})` : ''} and no material/section was given: forces assume every member has the same EI (axial deformation neglected); state this assumption prominently in the answer. Displacements were not computed; deflection/displacement or a code check needs the real material and section.`,
    };
  }
  return {
    zh: '静定结构的反力和内力与刚度无关；仅为求解使用了标注的单位刚度占位材料/截面。位移未计算；如需挠度/位移或规范验算，请提供实际材料和截面。',
    en: 'Reactions and internal forces of this statically determinate structure do not depend on stiffness; a labelled unit-stiffness placeholder was used only to run the solver. Displacements were not computed; deflection/displacement or a code check needs the real material and section.',
  };
}

/** Metadata recorded on a model whose material and/or sections are placeholders. */
export function describeStiffnessPlaceholder(model: ModelRecord, uses: { material: boolean; section: boolean }): StiffnessPlaceholder {
  const degree = staticIndeterminacy(model);
  const equalStiffnessAssumed = uses.section && degree !== 0;
  const plan = { ...uses, staticIndeterminacy: degree, equalStiffnessAssumed };
  return { ...plan, notice: placeholderNotice(plan) };
}

/** Placeholder metadata of a model, a saved run (via its model snapshot or meta) or undefined. */
export function stiffnessPlaceholderOf(source: unknown): StiffnessPlaceholder | undefined {
  if (!isRecord(source)) return undefined;
  const candidates = [source.metadata, isRecord(source.modelSnapshot) ? source.modelSnapshot.metadata : undefined,
    isRecord(source.meta) ? { stiffnessPlaceholder: source.meta.stiffnessPlaceholder } : undefined];
  for (const metadata of candidates) {
    if (isRecord(metadata) && isRecord(metadata.stiffnessPlaceholder)) return metadata.stiffnessPlaceholder as unknown as StiffnessPlaceholder;
  }
  return undefined;
}

const DISPLACEMENT_COMPONENTS = new Set(['ux', 'uy', 'uz', 'rx', 'ry', 'rz']);
const DISPLACEMENT_FIELDS = ['displacements', 'nodeDisplacements', 'rotations'];
const DISPLACEMENT_ENVELOPE_KEYS = ['maxAbsDisplacement', 'controlNodeDisplacement', 'controlElementDisplacement', 'maxAbsRotation'];

export const PLACEHOLDER_DISPLACEMENT_ERROR = 'STIFFNESS_PLACEHOLDER_DISPLACEMENT_UNAVAILABLE: this run used unit placeholder stiffness for forces only; displacement/deflection was not computed. Ask for the real material and section, extract them, rebuild and reanalyze. / 本次运行仅为内力计算使用了单位刚度占位，未计算位移/挠度；请询问实际材料和截面，提取后重新建模分析。';

export function isDisplacementSelection(field: unknown, component: unknown): boolean {
  return (typeof field === 'string' && (DISPLACEMENT_FIELDS.includes(field)))
    || (typeof component === 'string' && DISPLACEMENT_COMPONENTS.has(component));
}

/** A member response sample without its displacement/rotation components. */
export function withoutDisplacementComponents<T>(value: T): T {
  if (!isRecord(value)) return value;
  const sample = isRecord(value.sample) ? { ...value, sample: Object.fromEntries(Object.entries(value.sample)
    .filter(([key]) => !DISPLACEMENT_COMPONENTS.has(key))) } : { ...value };
  return Object.fromEntries(Object.entries(sample).filter(([key]) => !DISPLACEMENT_COMPONENTS.has(key)
    && !['displacement', 'displacements'].includes(key))) as T;
}

function stripData(data: ModelRecord): ModelRecord {
  const copy: ModelRecord = Object.fromEntries(Object.entries(data).filter(([key]) => !DISPLACEMENT_FIELDS.includes(key)));
  if (isRecord(data.envelope)) copy.envelope = Object.fromEntries(Object.entries(data.envelope).filter(([key]) => !DISPLACEMENT_ENVELOPE_KEYS.includes(key)));
  if (isRecord(data.segmentResults)) {
    copy.segmentResults = Object.fromEntries(Object.entries(data.segmentResults).filter(([key]) => !DISPLACEMENT_FIELDS.includes(key)));
  }
  if (Array.isArray(data.memberResponses)) {
    copy.memberResponses = data.memberResponses.map(member => isRecord(member) && Array.isArray(member.samples)
      ? { ...member, samples: member.samples.map(sample => withoutDisplacementComponents(sample)) } : member);
  }
  if (isRecord(data.memberResponseExtrema) && isRecord(data.memberResponseExtrema.values)) {
    copy.memberResponseExtrema = { ...data.memberResponseExtrema, values: Object.fromEntries(Object.entries(data.memberResponseExtrema.values)
      .filter(([component]) => !DISPLACEMENT_COMPONENTS.has(component))) };
  }
  copy.responseDefinition = placeholderResponseDefinition(data.responseDefinition);
  return copy;
}

/** Response definition of a placeholder run: forces and reactions only. */
export function placeholderResponseDefinition(definition: unknown): ModelRecord {
  const base = isRecord(definition) ? definition : {};
  return { ...base, stiffnessPlaceholder: true, available: ['forces', 'reactions'],
    unavailable: [...new Set([...(Array.isArray(base.unavailable) ? base.unavailable : []), 'displacements', 'rotations', 'stress', 'design'])] };
}

/**
 * Presentation copy of an analysis result whose model used placeholder stiffness: nodal displacements,
 * displacement envelopes and member displacement components are removed. The saved run keeps its
 * solver data, because force recovery along members reads it.
 */
export function withoutPlaceholderDisplacements(result: ModelRecord, placeholder = stiffnessPlaceholderOf(result)): ModelRecord {
  if (!placeholder) return result;
  const strip = (record: ModelRecord): ModelRecord => isRecord(record.data) ? { ...record, data: stripData(record.data) } : stripData(record);
  const copy = strip(result);
  if (isRecord(result.results)) {
    copy.results = Object.fromEntries(Object.entries(result.results).map(([key, value]) => [key, isRecord(value) ? strip(value) : value]));
  }
  return copy;
}

const isPlaceholderRecord = (record: unknown): boolean => isRecord(record) && isRecord(record.extra) && record.extra.stiffnessPlaceholder === true;
const REAL_STIFFNESS_KEYS: Record<string, string[]> = { materials: ['E'], sections: ['properties', 'shape', 'A', 'Iy', 'Iz'] };

/**
 * After a model edit: a placeholder material/section the edit gave real stiffness loses its placeholder
 * label. Once no member uses a placeholder record, the unused placeholder records and
 * metadata.stiffnessPlaceholder are removed; otherwise the model stays a force-only placeholder model.
 */
export function settlePlaceholderStiffness(model: ModelRecord, edits: Array<{ operation: string; collection: string; id: string; values?: Record<string, unknown> }>): ModelRecord {
  if (!stiffnessPlaceholderOf(model)) return model;
  const realized = new Set(edits.filter(edit => edit.operation === 'update' && edit.values
    && (REAL_STIFFNESS_KEYS[edit.collection] ?? []).some(key => key in edit.values!)).map(edit => `${edit.collection}:${edit.id}`));
  const settle = (collection: 'materials' | 'sections') => (Array.isArray(model[collection]) ? model[collection] as unknown[] : []).map(record => {
    if (!isRecord(record) || !isPlaceholderRecord(record) || !realized.has(`${collection}:${String(record.id)}`)) return record;
    const { stiffnessPlaceholder: _flag, ...extra } = record.extra as ModelRecord;
    const { extra: _extra, ...rest } = record;
    return { ...rest, ...(Object.keys(extra).length ? { extra } : {}), ...(rest.name === PLACEHOLDER_NAME ? { name: String(record.id) } : {}) };
  });
  const materials = settle('materials'), sections = settle('sections');
  const ids = (records: unknown[]) => new Set(records.filter(isPlaceholderRecord).map(record => String((record as ModelRecord).id)));
  const placeholderMaterials = ids(materials), placeholderSections = ids(sections);
  const elements = Array.isArray(model.elements) ? model.elements.filter(isRecord) : [];
  if (elements.some(element => placeholderMaterials.has(String(element.material)) || placeholderSections.has(String(element.section)))) {
    return { ...model, materials, sections };
  }
  const { stiffnessPlaceholder: _placeholder, ...metadata } = isRecord(model.metadata) ? model.metadata : {};
  return { ...model, materials: materials.filter(record => !isPlaceholderRecord(record)),
    sections: sections.filter(record => !isPlaceholderRecord(record)), metadata };
}
