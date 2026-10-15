import { completeReviewedSectionRecord, reviewedSectionName, reviewedSectionNames, reviewedSectionRecord } from './section-catalog.js';
import type { DraftState } from './types.js';
import { applyDraftAnalysisControl } from './engineering-draft.js';

type FrameMaterialCategory = 'steel' | 'concrete';
type FrameMaterialProps = { E: number; G: number; nu: number; rho: number; category: FrameMaterialCategory; fy?: number; fc?: number };

const STEEL_GRADE_PROPERTIES: Record<string, FrameMaterialProps & { category: 'steel'; fy: number }> = {
  Q235: { E: 206000, G: 79000, nu: 0.3, rho: 7850, category: 'steel', fy: 235 },
  Q345: { E: 206000, G: 79000, nu: 0.3, rho: 7850, category: 'steel', fy: 345 },
  Q355: { E: 206000, G: 79000, nu: 0.3, rho: 7850, category: 'steel', fy: 355 },
  Q390: { E: 206000, G: 79000, nu: 0.3, rho: 7850, category: 'steel', fy: 390 },
  Q420: { E: 206000, G: 79000, nu: 0.3, rho: 7850, category: 'steel', fy: 420 },
  S235: { E: 210000, G: 81000, nu: 0.3, rho: 7850, category: 'steel', fy: 235 },
  S275: { E: 210000, G: 81000, nu: 0.3, rho: 7850, category: 'steel', fy: 275 },
  S355: { E: 210000, G: 81000, nu: 0.3, rho: 7850, category: 'steel', fy: 355 },
  A36: { E: 200000, G: 77000, nu: 0.3, rho: 7850, category: 'steel', fy: 248 },
};

const CONCRETE_GRADE_PROPERTIES: Record<string, FrameMaterialProps & { category: 'concrete'; fc: number }> = {
  C20: { E: 25500, G: 10625, nu: 0.2, rho: 2500, category: 'concrete', fc: 9.6 },
  C25: { E: 28000, G: 11667, nu: 0.2, rho: 2500, category: 'concrete', fc: 11.9 },
  C30: { E: 30000, G: 12500, nu: 0.2, rho: 2500, category: 'concrete', fc: 14.3 },
  C35: { E: 31500, G: 13125, nu: 0.2, rho: 2500, category: 'concrete', fc: 16.7 },
  C40: { E: 32500, G: 13542, nu: 0.2, rho: 2500, category: 'concrete', fc: 19.1 },
  C45: { E: 33500, G: 13958, nu: 0.2, rho: 2500, category: 'concrete', fc: 21.1 },
  C50: { E: 34500, G: 14375, nu: 0.2, rho: 2500, category: 'concrete', fc: 23.1 },
  C55: { E: 35500, G: 14792, nu: 0.2, rho: 2500, category: 'concrete', fc: 25.3 },
  C60: { E: 36000, G: 15000, nu: 0.2, rho: 2500, category: 'concrete', fc: 27.5 },
};

type HSectionShape = { kind: 'H'; H: number; B: number; tw: number; tf: number };
type RectangularSectionShape = { kind: 'rectangular'; H: number; B: number };
type ResolvedFrameMaterialProps = FrameMaterialProps & { resolvedGrade: string };
type SectionProps = {
  name: string;
  type: 'H' | 'rectangular';
  A: number;
  Iy: number;
  Iz: number;
  J: number;
  G: number;
  shape: HSectionShape | RectangularSectionShape;
  width?: number;
  height?: number;
  substituted?: string;
};

export function getDefaultColumnSection(storyCount: number): string {
  if (storyCount > 10) return 'H400X400X13X21';
  if (storyCount > 5) return 'H350X350X12X19';
  return 'H300X300X10X15';
}

export function getDefaultBeamSection(storyCount: number): string {
  if (storyCount > 10) return 'H500X200X10X16';
  if (storyCount > 5) return 'H400X200X8X13';
  return 'H300X150X6.5X9';
}

export function normalizeSteelGrade(raw: string): string {
  const upper = raw.toUpperCase().replace(/\s+/g, '');
  return Object.keys({ ...STEEL_GRADE_PROPERTIES, ...CONCRETE_GRADE_PROPERTIES }).find((grade) => grade === upper) ?? upper;
}

export function normalizeSectionName(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '').replace(/[×x*]/gi, 'X');
}

export function resolveFrameMaterialProps(grade: string | undefined): ResolvedFrameMaterialProps {
  if (!grade) throw new Error('TEMPLATE_PROPERTY_REQUIRED: material grade / 请明确材料牌号或完整材料记录');
  const normalized = normalizeSteelGrade(grade);
  // Quality suffixes do not change the elastic constants; retain the declared grade.
  const baseGrade = normalized.replace(/^(Q235)[ABCD]$|^(Q(?:345|355|390|420))[BCDE]$/, '$1$2');
  if (STEEL_GRADE_PROPERTIES[baseGrade]) {
    return { ...STEEL_GRADE_PROPERTIES[baseGrade]!, resolvedGrade: normalized };
  }
  if (CONCRETE_GRADE_PROPERTIES[normalized]) {
    return { ...CONCRETE_GRADE_PROPERTIES[normalized]!, resolvedGrade: normalized };
  }
  throw new Error(`TEMPLATE_PROPERTY_REQUIRED: unsupported material ${grade} / 未知材料请提供完整材料属性`);
}

function parseCustomHSection(raw: string): { H: number; B: number; tw: number; tf: number } | null {
  const normalized = raw.toUpperCase().replace(/[×X*]/g, 'x').replace(/\s+/g, '');
  const match = normalized.match(/^H(\d+)x(\d+)x([\d.]+)x([\d.]+)$/);
  if (!match) return null;
  const H = parseFloat(match[1]!);
  const B = parseFloat(match[2]!);
  const tw = parseFloat(match[3]!);
  const tf = parseFloat(match[4]!);
  if (H > 2 * tf && B > tw && tw > 0 && tf > 0) return { H, B, tw, tf };
  return null;
}

function computeHSectionProps(H: number, B: number, tw: number, tf: number, G: number) {
  const hw = H - 2 * tf;
  const A = tw * hw + 2 * B * tf;
  const Iy = (tw * hw ** 3) / 12 + (2 * B * tf ** 3) / 12 + 2 * B * tf * ((hw + tf) / 2) ** 2;
  const Iz = (2 * tf * B ** 3) / 12 + (hw * tw ** 3) / 12;
  const J = (2 * B * tf ** 3 + hw * tw ** 3) / 3;
  return { A: A / 1e6, Iy: Iy / 1e12, Iz: Iz / 1e12, J: J / 1e12, G };
}

function parseRectangularSection(raw: string): { B: number; H: number } | null {
  const normalized = normalizeSectionName(raw).replace(/MM$/, '');
  const plain = normalized.match(/^(?:RECT|R)?(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)$/);
  const bh = normalized.match(/^B(\d+(?:\.\d+)?)H(\d+(?:\.\d+)?)$/);
  const match = plain ?? bh;
  if (!match) return null;
  const B = Number.parseFloat(match[1]!);
  const H = Number.parseFloat(match[2]!);
  if (B > 0 && H > 0) return { B, H };
  return null;
}

function computeSolidRectangularTorsionConstant(B: number, H: number) {
  const a = Math.max(B, H);
  const b = Math.min(B, H);
  const aspect = b / a;
  return a * b ** 3 * ((1 / 3) - 0.21 * aspect * (1 - (b ** 4) / (12 * a ** 4)));
}

function computeRectangularSectionProps(B: number, H: number, G: number) {
  const A = B * H;
  const Iy = (B * H ** 3) / 12;
  const Iz = (H * B ** 3) / 12;
  const J = computeSolidRectangularTorsionConstant(B, H);
  return { A: A / 1e6, Iy: Iy / 1e12, Iz: Iz / 1e12, J: J / 1e12, G };
}

export function resolveSectionProps(
  section: string | undefined,
  role: 'column' | 'beam',
  _storyCount: number,
  matG: number,
): SectionProps {
  if (!section) throw new Error(`TEMPLATE_PROPERTY_REQUIRED: ${role} section / 请明确该类构件截面`);
  const normalized = normalizeSectionName(section);
  if (/^H[WN]/.test(normalized)) {
    throw new Error('SECTION_CATALOG_UNVERIFIED: supply reviewed complete section properties or explicit H×B×tw×tf geometry / 型钢目录尚未审定，请提供核定截面属性或明确四项尺寸');
  }
  const custom = section ? parseCustomHSection(section) : null;
  if (custom) {
    const props = computeHSectionProps(custom.H, custom.B, custom.tw, custom.tf, matG);
    const name = `H${custom.H}X${custom.B}X${custom.tw}X${custom.tf}`;
    return {
      name,
      type: 'H',
      ...props,
      shape: { kind: 'H', H: custom.H, B: custom.B, tw: custom.tw, tf: custom.tf },
    };
  }
  const rectangular = section ? parseRectangularSection(section) : null;
  if (rectangular) {
    const props = computeRectangularSectionProps(rectangular.B, rectangular.H, matG);
    const name = `${rectangular.B}X${rectangular.H}`;
    return {
      name,
      type: 'rectangular',
      ...props,
      shape: { kind: 'rectangular', B: rectangular.B, H: rectangular.H },
      width: rectangular.B,
      height: rectangular.H,
    };
  }
  throw new Error(`TEMPLATE_PROPERTY_REQUIRED: unsupported section ${section} / 截面无法解析，请提供完整截面属性`);
}

export function buildMaterialRecord(matProps: ResolvedFrameMaterialProps): Record<string, unknown> {
  return {
    id: '1',
    name: matProps.resolvedGrade,
    grade: matProps.resolvedGrade,
    category: matProps.category,
    E: matProps.E,
    G: matProps.G,
    nu: matProps.nu,
    rho: matProps.rho,
    ...(matProps.fy !== undefined ? { fy: matProps.fy } : {}),
    ...(matProps.fc !== undefined ? { design: { fc: matProps.fc } } : {}),
  };
}

export function buildSectionRecord(id: string, purpose: 'column' | 'beam', props: SectionProps): Record<string, unknown> {
  return {
    id,
    name: props.name,
    type: props.type,
    purpose,
    shape: props.shape,
    ...(props.width !== undefined ? { width: props.width } : {}),
    ...(props.height !== undefined ? { height: props.height } : {}),
    properties: { A: props.A, Iy: props.Iy, Iz: props.Iz, J: props.J },
  };
}

type TemplateRole = 'beam' | 'column' | 'member';
const propertyError = (field: string): never => {
  throw new Error(`TEMPLATE_PROPERTY_REQUIRED: ${field} / 请明确材料、截面与构件角色对应关系后再建模`);
};

/** A template supplies geometry; material and section choices must come from declared inputs. */
export function resolveTemplateProperties(state: DraftState, roles: TemplateRole[]) {
  const draft = state.engineeringDraft;
  const grade = draft?.material?.grade ?? state.frameMaterial as string | undefined;
  const materials = draft?.materials?.length ? structuredClone(draft.materials)
    : [buildMaterialRecord(resolveFrameMaterialProps(grade))];
  const sections = structuredClone(draft?.sectionRecords ?? []);
  const explicitRecords = sections.length > 0;
  for (const section of sections) {
    const completed = completeReviewedSectionRecord(section, reviewedSectionNames(section, draft));
    if (completed) {
      Object.assign(section, completed);
      delete section.shape;
      delete section.dimensions;
    }
    const hasDefinition = ['properties', 'dimensions', 'shape'].some((key) => {
      const value = section[key];
      return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
    });
    if (!hasDefinition) {
      return propertyError(`section ${section.id}: properties, dimensions or shape required`);
    }
  }
  const byRole: Partial<Record<TemplateRole, { materialId: string; sectionId: string }>> = {};
  for (const role of roles) {
    const mapping = draft?.templateAssignments?.[role] ?? draft?.templateAssignments?.member;
    const materialId = mapping?.materialId ?? (materials.length === 1 ? String(materials[0].id) : propertyError(`${role}.materialId`));
    const material = materials.find((entry) => entry.id === materialId);
    if (!material) propertyError(`${role}.materialId=${materialId}`);
    const declaredSection = draft?.sections?.[role] ?? draft?.sections?.member
      ?? (role === 'column' ? state.frameColumnSection as string | undefined
        : role === 'beam' ? state.frameBeamSection as string | undefined : undefined);
    let sectionId = mapping?.sectionId;
    if (explicitRecords) {
      sectionId ??= declaredSection;
      if (!mapping?.sectionId && declaredSection && !sections.some(entry => entry.id === sectionId)) {
        const catalogName = reviewedSectionName(declaredSection);
        const byName = sections.filter(entry => typeof entry.name === 'string'
          && (normalizeSectionName(entry.name.replace(/\s*[（(].*$/, '')) === normalizeSectionName(declaredSection)
            || !!catalogName && (reviewedSectionName(entry.name) === catalogName
              || (entry.extra as { catalogSource?: { recordId?: string } } | undefined)?.catalogSource?.recordId === catalogName)));
        if (byName.length === 1) sectionId = String(byName[0].id);
      }
      // A single section is unambiguous only when geometry has one member role.
      if (!sectionId && roles.length === 1 && sections.length === 1) sectionId = String(sections[0].id);
      if (!sectionId || !sections.some((entry) => entry.id === sectionId)) propertyError(`${role}.sectionId`);
    } else {
      const concreteColumn = role === 'column' && (draft?.material?.family === 'concrete' || state.skillState?.materialFamily === 'concrete');
      const width = Number(state.skillState?.sectionWidthM), depth = Number(state.skillState?.sectionDepthM);
      const sectionName = declaredSection ?? (concreteColumn && width > 0 && depth > 0 ? `${width * 1000}X${depth * 1000}` : undefined);
      const E = Number(material!.E), nu = Number(material!.nu);
      if (!(E > 0) || !Number.isFinite(nu)) propertyError(`${role}.material elastic constants`);
      sectionId = roles.length === 1 || role === 'column' ? '1' : '2';
      const purpose = role === 'column' ? 'column' : 'beam';
      const catalog = sectionName ? reviewedSectionRecord(sectionName, sectionId, purpose) : undefined;
      if (catalog) sections.push(catalog);
      else {
        const props = resolveSectionProps(sectionName, purpose, 0, Number(material!.G ?? E / (2 * (1 + nu))));
        sections.push(buildSectionRecord(sectionId, purpose, props));
      }
    }
    byRole[role] = { materialId, sectionId: sectionId! };
  }
  return { materials, sections, byRole };
}

export function applyTemplateProperties(model: Record<string, unknown>, state: DraftState): Record<string, unknown> {
  const elements = model.elements as Array<Record<string, unknown>>;
  const roleOf = (element: Record<string, unknown>): TemplateRole => element.type === 'column' ? 'column'
    : element.type === 'beam' ? 'beam' : 'member';
  const roles = [...new Set(elements.map(roleOf))];
  const properties = resolveTemplateProperties(state, roles);
  return applyDraftAnalysisControl({ ...model, materials: properties.materials, sections: properties.sections,
    elements: elements.map((element) => {
      const assignment = properties.byRole[roleOf(element)]!;
      return { ...element, material: assignment.materialId, section: assignment.sectionId };
    }),
    ...(state.engineeringDraft?.loadCases ? { load_cases: structuredClone(state.engineeringDraft.loadCases) } : {}),
    ...(state.engineeringDraft?.analysis?.loadCombinations ? { load_combinations: structuredClone(state.engineeringDraft.analysis.loadCombinations) } : {}),
    metadata: { ...(model.metadata as Record<string, unknown> ?? {}),
      inputEvidence: structuredClone(state.engineeringDraft?.inputEvidence ?? []),
      templatePropertyAssignments: properties.byRole },
  }, state.engineeringDraft);
}

export function templatePropertyIssues(state: DraftState): string[] {
  if (state.engineeringDraft?.model || state.engineeringDraft?.topology?.members?.some((member) => member.type || member.material || member.section)) return [];
  const roles: TemplateRole[] = ['frame', 'portal-frame'].includes(String(state.inferredType)) ? ['column', 'beam']
    : state.inferredType === 'column' ? ['column'] : state.inferredType === 'truss' ? ['member'] : ['beam'];
  try { resolveTemplateProperties(state, roles); return []; }
  catch (error) { return [error instanceof Error ? error.message : String(error)]; }
}
