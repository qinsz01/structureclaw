import { mergeInputEvidence } from '../engineering/input-evidence.js';
import { isDeepStrictEqual } from 'node:util';
import type {
  DraftExtraction,
  DraftFloorLoad,
  DraftLoadPosition,
  DraftLoadType,
  DraftSupportType,
  DraftWindParams,
  AgentAnalysisType,
  EngineeringDraft,
  EngineeringDraftLoad,
  EngineeringDraftLoadCaseType,
  EngineeringDraftLoadCombination,
  EngineeringDraftLoadDirection,
  EngineeringDraftLoadKind,
  EngineeringDraftLoadUnit,
  EngineeringDraftTopology,
  EngineeringDraftTopologyMember,
  EngineeringDraftTopologyNode,
  FrameBaseSupportType,
  InferredModelType,
  MaterialFamily,
} from './types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function firstPositiveNumber(candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    const parsed = positiveNumber(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = positiveNumber(value);
  return parsed === undefined ? undefined : Math.max(1, Math.round(parsed));
}

function positiveNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((item) => positiveNumber(item))
    .filter((item): item is number => item !== undefined);
  return values.length ? values : undefined;
}

function nonNegativeNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((item) => finiteNumber(item))
    .filter((item): item is number => item !== undefined && item >= 0);
  return values.length ? values : undefined;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeTopologyNode(value: unknown): EngineeringDraftTopologyNode | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const id = normalizeString(raw.id);
  const x = finiteNumber(raw.x);
  const y = finiteNumber(raw.y);
  const z = finiteNumber(raw.z);
  if (!id || x === undefined || y === undefined || z === undefined) return undefined;
  const restraints = Array.isArray(raw.restraints)
    && raw.restraints.length === 6
    && raw.restraints.every((item) => typeof item === 'boolean')
    ? [...raw.restraints] as boolean[]
    : undefined;
  if (raw.restraints !== undefined && !restraints) {
    throw new Error(`INVALID_EXPLICIT_TOPOLOGY: node '${id}' needs six boolean restraints / 节点约束必须为六个布尔值`);
  }
  return { ...structuredClone(raw), id, x, y, z, restraints };
}

function normalizeTopologyMember(value: unknown): EngineeringDraftTopologyMember | undefined {
  const raw = asRecord(value);
  if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length !== 2) return undefined;
  const start = normalizeString(raw.nodes[0]);
  const end = normalizeString(raw.nodes[1]);
  if (!start || !end || start === end) return undefined;
  return {
    ...structuredClone(raw),
    id: normalizeString(raw.id),
    nodes: [start, end],
    ...(raw.type !== undefined && { type: raw.type as EngineeringDraftTopologyMember['type'] }),
    ...(raw.material !== undefined && { material: normalizeString(raw.material) }),
    ...(raw.section !== undefined && { section: normalizeString(raw.section) }),
    ...(raw.rotation_angle !== undefined && { rotation_angle: finiteNumber(raw.rotation_angle) }),
    ...(asRecord(raw.releases) && { releases: structuredClone(asRecord(raw.releases)!) }),
    ...(asRecord(raw.offsets) && { offsets: structuredClone(asRecord(raw.offsets)!) as Record<string, number> }),
  };
}

function normalizeEngineeringTopology(value: unknown): EngineeringDraftTopology | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.map(normalizeTopologyNode).filter((node): node is EngineeringDraftTopologyNode => node !== undefined)
    : undefined;
  const members = Array.isArray(raw.members)
    ? raw.members.map(normalizeTopologyMember).filter((member): member is EngineeringDraftTopologyMember => member !== undefined)
    : undefined;
  if ((Array.isArray(raw.nodes) && nodes?.length !== raw.nodes.length)
    || (Array.isArray(raw.members) && members?.length !== raw.members.length)) {
    throw new Error('INVALID_EXPLICIT_TOPOLOGY: invalid nodes or member endpoints / 显式节点或构件端点无效，不能丢弃后继续建模');
  }
  return nodes?.length || members?.length ? { nodes, members } : undefined;
}

function normalizeMaterialFamily(value: unknown): MaterialFamily | undefined {
  const raw = normalizeString(value)?.toLowerCase();
  if (!raw) return undefined;
  if (['steel', 'concrete', 'composite', 'timber', 'masonry', 'generic'].includes(raw)) {
    return raw as MaterialFamily;
  }
  return undefined;
}

function normalizeSupportType(value: unknown): DraftSupportType | undefined {
  const raw = normalizeString(value);
  if (
    raw === 'cantilever'
    || raw === 'simply-supported'
    || raw === 'fixed-fixed'
    || raw === 'fixed-pinned'
  ) {
    return raw;
  }
  return undefined;
}

function normalizeFrameBaseSupportType(value: unknown): FrameBaseSupportType | undefined {
  const raw = normalizeString(value);
  return raw === 'fixed' || raw === 'pinned' ? raw : undefined;
}

function normalizeAnalysisType(value: unknown): AgentAnalysisType | undefined {
  const raw = normalizeString(value);
  return raw === 'static' || raw === 'dynamic' || raw === 'seismic' || raw === 'nonlinear'
    ? raw
    : undefined;
}

function normalizeEngineTarget(value: unknown): 'opensees' | 'pkpm' | 'yjk' | undefined {
  const raw = normalizeString(value)?.toLowerCase();
  return raw === 'opensees' || raw === 'pkpm' || raw === 'yjk' ? raw : undefined;
}

function normalizeWindTerrainRoughness(value: unknown): DraftWindParams['terrainRoughness'] | undefined {
  const raw = normalizeString(value)?.toUpperCase().replace(/类$/, '');
  return raw === 'A' || raw === 'B' || raw === 'C' || raw === 'D' ? raw : undefined;
}

function normalizeWindParams(value: unknown): DraftWindParams | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const wind: DraftWindParams = {
    ...(positiveNumber(raw.basicPressureKNM2 ?? raw.basic_pressure ?? raw.basicPressure ?? raw.windPressure) !== undefined && {
      basicPressureKNM2: positiveNumber(raw.basicPressureKNM2 ?? raw.basic_pressure ?? raw.basicPressure ?? raw.windPressure),
    }),
    ...(normalizeWindTerrainRoughness(raw.terrainRoughness ?? raw.terrain_roughness) !== undefined && {
      terrainRoughness: normalizeWindTerrainRoughness(raw.terrainRoughness ?? raw.terrain_roughness),
    }),
    ...(positiveNumber(raw.shapeFactor ?? raw.shape_factor) !== undefined && {
      shapeFactor: positiveNumber(raw.shapeFactor ?? raw.shape_factor),
    }),
    ...(positiveNumber(raw.heightVariationFactor ?? raw.height_variation_factor) !== undefined && {
      heightVariationFactor: positiveNumber(raw.heightVariationFactor ?? raw.height_variation_factor),
    }),
  };
  return Object.keys(wind).length ? wind : undefined;
}

function normalizeLoadKind(value: unknown): EngineeringDraftLoadKind | undefined {
  const raw = normalizeString(value)?.toLowerCase();
  if (!raw) return undefined;
  if (raw === 'point' || raw === 'nodal' || raw === 'area' || raw === 'distributed') {
    return raw;
  }
  if (raw === 'line' || raw === 'uniform' || raw === 'udl') {
    return 'line';
  }
  return undefined;
}

function normalizeLoadUnit(value: unknown, _kind: EngineeringDraftLoadKind): EngineeringDraftLoadUnit {
  const raw = normalizeString(value)?.toLowerCase().replace(/\s+/g, '');
  if (raw === 'kn/m2' || raw === 'kn/m^2' || raw === 'kn/㎡' || raw === 'kn/m²') {
    return 'kN/m2';
  }
  if (raw === 'kn/m') {
    return 'kN/m';
  }
  if (raw === 'kn') {
    return 'kN';
  }
  if (raw === 'n') return 'kN';
  if (raw === 'n/m') return 'kN/m';
  if (raw === 'n/m2' || raw === 'n/m^2' || raw === 'n/m²' || raw === 'kpa') return 'kN/m2';
  throw new Error('LOAD_UNIT_REQUIRED: load units must be explicit and supported / 荷载单位必须明确且受支持');
}

function normalizeLoadDirection(value: unknown): EngineeringDraftLoadDirection | undefined {
  const raw = normalizeString(value)?.toLowerCase();
  if (!raw) return undefined;
  if (raw === 'gravity' || raw === 'vertical' || raw === 'downward') return 'gravity';
  if (raw === 'globalx' || raw === 'x' || raw === 'fx') return 'globalX';
  if (raw === 'globaly' || raw === 'y' || raw === 'fy') return 'globalY';
  if (raw === 'globalz' || raw === 'z' || raw === 'fz') return 'globalZ';
  throw new Error('LOAD_DIRECTION_INVALID: declare gravity or globalX/globalY/globalZ / 荷载方向不明确');
}

function normalizeLoadCaseType(value: unknown): EngineeringDraftLoadCaseType | undefined {
  const raw = normalizeString(value)?.toLowerCase();
  if (!raw) return undefined;
  if (raw === 'dead' || raw === 'live' || raw === 'wind' || raw === 'seismic' || raw === 'other') {
    return raw;
  }
  return undefined;
}

function normalizeLoadLocation(value: unknown): EngineeringDraftLoad['location'] | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const location = {
    xM: finiteNumber(raw.xM ?? raw.x ?? raw.positionM),
    spanIndex: positiveInteger(raw.spanIndex ?? raw.span),
    story: positiveInteger(raw.story ?? raw.storyIndex ?? raw.level),
    nodeRole: normalizeString(raw.nodeRole ?? raw.node),
  };
  return location.xM !== undefined
    || location.spanIndex !== undefined
    || location.story !== undefined
    || location.nodeRole !== undefined
    ? location
    : undefined;
}

function normalizeEngineeringLoad(value: unknown): EngineeringDraftLoad | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const kind = normalizeLoadKind(raw.kind ?? raw.type ?? raw.loadType);
  const magnitude = finiteNumber(raw.magnitude ?? raw.value ?? raw.loadKN ?? raw.forceKN ?? raw.intensity);
  if (!kind || magnitude === undefined) return undefined;
  const sourceUnit = normalizeString(raw.unit)?.toLowerCase().replace(/\s+/g, '');
  const forceScale = sourceUnit && /^n(?:\/m(?:2|\^2|²)?)?$/.test(sourceUnit) ? 0.001 : 1;
  return {
    ...(normalizeString(raw.id) && { id: normalizeString(raw.id) }),
    kind,
    magnitude: magnitude * forceScale,
    unit: normalizeLoadUnit(raw.unit, kind),
    direction: normalizeLoadDirection(raw.direction ?? raw.axis),
    target: normalizeString(raw.target),
    location: normalizeLoadLocation(raw.location),
    caseId: normalizeString(raw.caseId ?? raw.loadCaseId),
    caseType: normalizeLoadCaseType(raw.caseType ?? raw.loadCaseType),
  };
}

function normalizeLoadCombination(value: unknown): EngineeringDraftLoadCombination | undefined {
  const raw = asRecord(value);
  const id = normalizeString(raw?.id);
  const rawFactors = asRecord(raw?.factors);
  if (!id || !rawFactors) return undefined;
  const factors: Record<string, number> = {};
  for (const [rawCaseId, rawFactor] of Object.entries(rawFactors)) {
    const caseId = rawCaseId.trim();
    const factor = finiteNumber(rawFactor);
    if (caseId && factor !== undefined) factors[caseId] = factor;
  }
  return Object.keys(factors).length ? { id, factors } : undefined;
}

function normalizeMezzanineHeight(rawGeometry: Record<string, unknown>): number | undefined {
  const direct = firstPositiveNumber([
    rawGeometry.mezzanineHeightM,
    rawGeometry.mezzanineHeight,
    rawGeometry.mezzanineLevelM,
    rawGeometry.mezzanineElevationM,
    rawGeometry.platformHeightM,
    rawGeometry.intermediateFloorHeightM,
  ]);
  if (direct !== undefined) return direct;

  const mezzanine = asRecord(rawGeometry.mezzanine);
  const platform = asRecord(rawGeometry.platform);
  const intermediateFloor = asRecord(rawGeometry.intermediateFloor);
  return firstPositiveNumber([
    mezzanine?.heightM,
    mezzanine?.height,
    mezzanine?.elevationM,
    platform?.heightM,
    platform?.height,
    platform?.elevationM,
    intermediateFloor?.heightM,
    intermediateFloor?.height,
    intermediateFloor?.elevationM,
  ]);
}

function normalizeMezzanineLength(rawGeometry: Record<string, unknown>): number | undefined {
  const direct = firstPositiveNumber([
    rawGeometry.mezzanineLengthM,
    rawGeometry.mezzanineLength,
    rawGeometry.platformLengthM,
  ]);
  if (direct !== undefined) return direct;

  const mezzanine = asRecord(rawGeometry.mezzanine);
  const platform = asRecord(rawGeometry.platform);
  return firstPositiveNumber([
    mezzanine?.lengthM,
    mezzanine?.length,
    platform?.lengthM,
    platform?.length,
  ]);
}

export function normalizeEngineeringDraft(value: unknown): EngineeringDraft | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;

  const rawGeometry = asRecord(raw.geometry);
  const geometry = rawGeometry ? {
    lengthM: positiveNumber(rawGeometry.lengthM),
    heightM: positiveNumber(rawGeometry.heightM),
    mezzanineHeightM: normalizeMezzanineHeight(rawGeometry),
    mezzanineLengthM: normalizeMezzanineLength(rawGeometry),
    spanLengthsM: positiveNumberArray(rawGeometry.spanLengthsM),
    storyHeightsM: positiveNumberArray(rawGeometry.storyHeightsM),
    bayWidthsM: positiveNumberArray(rawGeometry.bayWidthsM),
    bayWidthsXM: positiveNumberArray(rawGeometry.bayWidthsXM),
    bayWidthsYM: positiveNumberArray(rawGeometry.bayWidthsYM),
  } : undefined;

  const rawMaterial = asRecord(raw.material);
  const material = rawMaterial ? {
    family: normalizeMaterialFamily(rawMaterial.family),
    grade: normalizeString(rawMaterial.grade),
    rebarGrade: normalizeString(rawMaterial.rebarGrade),
  } : undefined;

  const rawSections = asRecord(raw.sections);
  const sections = rawSections ? {
    beam: normalizeString(rawSections.beam),
    column: normalizeString(rawSections.column),
    member: normalizeString(rawSections.member),
  } : undefined;

  const rawBoundary = asRecord(raw.boundary);
  const boundary = rawBoundary ? {
    supportType: normalizeSupportType(rawBoundary.supportType),
    frameBaseSupportType: normalizeFrameBaseSupportType(rawBoundary.frameBaseSupportType),
    supportPositionsM: nonNegativeNumberArray(rawBoundary.supportPositionsM),
  } : undefined;

  const loads = Array.isArray(raw.loads)
    ? raw.loads.map(normalizeEngineeringLoad).filter((load): load is EngineeringDraftLoad => load !== undefined)
    : undefined;
  if (raw.loads !== undefined && (!Array.isArray(raw.loads) || raw.loads.length !== loads?.length)) {
    throw new Error('INVALID_ENGINEERING_LOAD: every load needs supported type, finite signed magnitude and explicit unit / 每条荷载需有效类型、带符号有限数值及单位');
  }

  const rawAnalysis = asRecord(raw.analysis);
  const analysis = rawAnalysis ? {
    type: normalizeAnalysisType(rawAnalysis.type),
    engineTarget: normalizeEngineTarget(rawAnalysis.engineTarget),
    loadCombinations: Array.isArray(rawAnalysis.loadCombinations)
      ? rawAnalysis.loadCombinations
        .map(normalizeLoadCombination)
        .filter((combination): combination is EngineeringDraftLoadCombination => combination !== undefined)
      : undefined,
  } : undefined;

  const wind = normalizeWindParams(raw.wind ?? raw.windParams);
  const analysisControl = raw.analysisControl;
  if (analysisControl !== undefined && !asRecord(analysisControl)) {
    throw new Error('INVALID_ANALYSIS_CONTROL: object required / 分析控制必须是对象');
  }

  const draft: EngineeringDraft = {
    structureType: normalizeString(raw.structureType) as EngineeringDraft['structureType'],
    geometry,
    topology: normalizeEngineeringTopology(raw.topology),
    materials: normalizeRecordArray(raw.materials, 'materials'),
    sectionRecords: normalizeRecordArray(raw.sectionRecords ?? (Array.isArray(raw.sections) ? raw.sections : undefined), 'sections'),
    templateAssignments: normalizeTemplateAssignments(raw.templateAssignments),
    loadCases: normalizeRecordArray(raw.loadCases ?? raw.load_cases, 'loadCases'),
    model: asRecord(raw.model) ? structuredClone(asRecord(raw.model)!) : undefined,
    inputEvidence: normalizeRecordArray(raw.inputEvidence, 'inputEvidence'),
    material,
    sections,
    boundary,
    loads,
    wind,
    analysis,
    analysisControl: analysisControl === undefined ? undefined : structuredClone(asRecord(analysisControl)!),
  };

  return Object.values(draft).some((item) => item !== undefined) ? omitUndefined(draft) : undefined;
}

function normalizeTemplateAssignments(value: unknown): EngineeringDraft['templateAssignments'] {
  if (value === undefined || value === null) return undefined;
  const mappings = asRecord(value);
  if (!mappings) throw new Error('INVALID_TEMPLATE_ASSIGNMENTS: object required / 请提供构件角色属性映射');
  const normalized: NonNullable<EngineeringDraft['templateAssignments']> = {};
  for (const [role, raw] of Object.entries(mappings)) {
    if (['beam', 'column', 'member'].includes(role) && raw == null) continue;
    const entry = asRecord(raw);
    if (!['beam', 'column', 'member'].includes(role) || !entry
      || Object.keys(entry).some(key => !['materialId', 'sectionId'].includes(key))
      || ['materialId', 'sectionId'].some(key => entry[key] != null && typeof entry[key] !== 'string')) {
      throw new Error(`INVALID_TEMPLATE_ASSIGNMENTS: ${role} requires an object with nonempty supplied materialId/sectionId / 角色映射只接受明确的材料或截面ID`);
    }
    const materialId = normalizeString(entry.materialId), sectionId = normalizeString(entry.sectionId);
    if (materialId || sectionId) normalized[role as keyof typeof normalized] = { ...(materialId ? { materialId } : {}), ...(sectionId ? { sectionId } : {}) };
  }
  return normalized;
}

function normalizeRecordArray(value: unknown, label: string): Array<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !asRecord(item))) {
    throw new Error(`INVALID_EXPLICIT_MODEL: ${label} must contain complete records / 必须提供完整对象记录`);
  }
  return structuredClone(value) as Array<Record<string, unknown>>;
}

/** A partial update must not overwrite confirmed nested fields with undefined. */
function omitUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(omitUndefined) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, omitUndefined(item)])) as T;
}

function mergeDraftRecord(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = structuredClone(existing);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const before = asRecord(merged[key]);
    const after = asRecord(value);
    merged[key] = before && after ? mergeDraftRecord(before, after) : structuredClone(value);
  }
  return merged;
}

/** Clarification patches amend draft records by ID; an explicit [] still clears the collection. */
function mergeDraftPropertyRecords(existing: Array<Record<string, unknown>> | undefined,
  patch: Array<Record<string, unknown>> | undefined, sections = false): Array<Record<string, unknown>> | undefined {
  if (!patch) return existing;
  if (!patch.length || !existing?.length) return structuredClone(patch);
  const updated = structuredClone(existing);
  const seen = new Set<string>();
  for (const record of patch) {
    const id = typeof record.id === 'string' ? record.id : undefined;
    if (id && seen.has(id)) throw new Error(`DUPLICATE_DRAFT_RECORD_ID: ${id} / 草稿属性记录 ID 重复`);
    if (id) seen.add(id);
    const matches = id ? updated.flatMap((item, index) => item.id === id ? [index] : []) : [];
    if (matches.length > 1) throw new Error(`AMBIGUOUS_DRAFT_RECORD_ID: ${id} / 无法唯一定位草稿属性记录`);
    const index = matches[0];
    if (index === undefined) { updated.push(structuredClone(record)); continue; }
    const previous = updated[index]!;
    const beforeShape = asRecord(previous.shape), afterShape = asRecord(record.shape);
    if (sections && beforeShape?.kind && afterShape?.kind && beforeShape.kind !== afterShape.kind) {
      // A different physical shape replaces its geometry and derived properties;
      // old rectangular dimensions must not survive a change to a circular section.
      const metadata = { ...previous };
      for (const key of ['shape', 'dimensions', 'properties', 'width', 'height', 'diameter', 'thickness', 'standard_steel_name', 'type']) delete metadata[key];
      updated[index] = mergeDraftRecord(metadata, { type: afterShape.kind, ...record });
    } else {
      updated[index] = mergeDraftRecord(previous, record);
    }
  }
  return updated;
}

export function mergeEngineeringDraft(
  existing: EngineeringDraft | undefined,
  patch: EngineeringDraft | undefined,
): EngineeringDraft | undefined {
  if (!existing && !patch) return undefined;
  if (!patch) return existing;
  if (!existing) {
    return {
      ...patch,
      loads: mergeEngineeringDraftLoads(undefined, patch.loads, {
        structureType: patch.structureType,
        geometry: patch.geometry,
        analysis: patch.analysis,
      }),
    };
  }
  const structureType = patch.structureType ?? existing.structureType;
  const geometry = { ...(existing.geometry ?? {}), ...(patch.geometry ?? {}) };
  const analysis = { ...(existing.analysis ?? {}), ...(patch.analysis ?? {}) };
  const wind = existing.wind || patch.wind
    ? { ...(existing.wind ?? {}), ...(patch.wind ?? {}) }
    : undefined;
  const loads = mergeEngineeringDraftLoads(existing.loads, patch.loads, {
    structureType,
    geometry,
    analysis,
  });
  return {
    structureType,
    geometry,
    topology: { ...(existing.topology ?? {}), ...(patch.topology ?? {}) },
    materials: mergeDraftPropertyRecords(existing.materials, patch.materials),
    sectionRecords: mergeDraftPropertyRecords(existing.sectionRecords, patch.sectionRecords, true),
    templateAssignments: Object.fromEntries([...new Set([...Object.keys(existing.templateAssignments ?? {}), ...Object.keys(patch.templateAssignments ?? {})])]
      .map(role => { const key = role as keyof NonNullable<EngineeringDraft['templateAssignments']>;
        return [role, { ...existing.templateAssignments?.[key], ...patch.templateAssignments?.[key] }]; })),
    loadCases: patch.loadCases ?? existing.loadCases,
    model: patch.model ?? existing.model,
    inputEvidence: mergeInputEvidence(existing.inputEvidence, patch.inputEvidence),
    material: { ...(existing.material ?? {}), ...(patch.material ?? {}) },
    sections: { ...(existing.sections ?? {}), ...(patch.sections ?? {}) },
    boundary: { ...(existing.boundary ?? {}), ...(patch.boundary ?? {}) },
    loads,
    wind,
    analysis,
    analysisControl: mergeAnalysisControl(existing.analysisControl, patch.analysisControl),
  };
}

function mergeAnalysisControl(existing: Record<string, unknown> | undefined, patch: Record<string, unknown> | undefined,
  rejectConflicts = false, field = 'analysis_control'): Record<string, unknown> | undefined {
  if (!existing && !patch) return undefined;
  const merged = structuredClone(existing ?? {});
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    const before = merged[key];
    if (asRecord(before) && asRecord(value)) merged[key] = mergeAnalysisControl(asRecord(before), asRecord(value), rejectConflicts, `${field}.${key}`);
    else {
      if (rejectConflicts && before !== undefined && !isDeepStrictEqual(before, value)) {
        throw new Error(`ANALYSIS_CONTROL_CONFLICT: ${field}.${key} / 显式模型与草稿的分析控制冲突`);
      }
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

/** Confirmed controls are projected once; generated candidates cannot silently omit them. */
export function applyDraftAnalysisControl(model: Record<string, unknown>, draft: EngineeringDraft | undefined,
  preserveExplicitModel = false): Record<string, unknown> {
  if (draft?.analysisControl === undefined) return model;
  if (!asRecord(draft.analysisControl) || (model.analysis_control != null && !asRecord(model.analysis_control))) {
    throw new Error('INVALID_ANALYSIS_CONTROL: object required / 分析控制必须是对象');
  }
  return { ...model, analysis_control: mergeAnalysisControl(asRecord(model.analysis_control), draft.analysisControl, preserveExplicitModel) };
}

function stableJson(value: unknown): string {
  if (value === undefined) return '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const record = value as Record<string, unknown>;
  return JSON.stringify(Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = record[key];
    return acc;
  }, {}));
}

function isSingleSpanBeam(draft: Pick<EngineeringDraft, 'structureType' | 'geometry'>): boolean {
  if (draft.structureType !== 'beam') return false;
  const spans = draft.geometry?.spanLengthsM;
  return !spans?.length || spans.length === 1;
}

function loadLocationMergeValue(
  load: EngineeringDraftLoad,
  draft: Pick<EngineeringDraft, 'structureType' | 'geometry'>,
): EngineeringDraftLoad['location'] {
  const location = load.location;
  if (!location || !isSingleSpanBeam(draft) || location.spanIndex !== 1) {
    return location;
  }
  const { spanIndex: _spanIndex, ...rest } = location;
  return Object.values(rest).some((value) => value !== undefined) ? rest : undefined;
}

export function engineeringLoadMergeKey(
  load: EngineeringDraftLoad,
  draft: Pick<EngineeringDraft, 'structureType' | 'geometry' | 'analysis'>,
): string {
  if (load.id) return `id:${load.id}`;
  const location = loadLocationMergeValue(load, draft);
  const hasStructuredPointLocation = isPointLikeLoad(load)
    && Boolean(
      location?.nodeRole
      || location?.xM !== undefined
      || location?.story !== undefined,
    );
  const hasPlanarLineLocation = isLineLoad(load)
    && Boolean(location)
    && !(draft.geometry?.bayWidthsYM?.length);
  const normalizedTarget = hasStructuredPointLocation || hasPlanarLineLocation
    ? ''
    : load.target?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
  const caseIds = new Set(
    draft.analysis?.loadCombinations
      ?.flatMap((combination) => Object.keys(combination.factors)) ?? [],
  );
  const soleCaseId = caseIds.size === 1 ? Array.from(caseIds)[0] : undefined;
  const caseKey = load.caseId?.trim().toLowerCase()
    ?? soleCaseId?.trim().toLowerCase()
    ?? load.caseType
    ?? '';
  return [
    isLineLoad(load) ? 'line' : isPointLikeLoad(load) ? 'point' : load.kind,
    load.unit,
    load.direction ?? '',
    caseKey,
    normalizedTarget,
    stableJson(location),
  ].join('|');
}

function mergeEngineeringDraftLoads(
  existing: EngineeringDraftLoad[] | undefined,
  patch: EngineeringDraftLoad[] | undefined,
  draft: Pick<EngineeringDraft, 'structureType' | 'geometry' | 'analysis'>,
): EngineeringDraftLoad[] | undefined {
  if (!existing?.length && !patch?.length) return undefined;
  const merged = new Map<string, EngineeringDraftLoad>();
  for (const load of existing ?? []) {
    merged.set(engineeringLoadMergeKey(load, draft), load);
  }
  for (const load of patch ?? []) {
    const key = engineeringLoadMergeKey(load, draft);
    let prior = merged.get(key);
    // Supplying a previously omitted direction refines one existing load.
    // It must not append a second force at the same location. Explicit IDs,
    // distinct cases and two explicitly different directions stay distinct.
    if (!prior && !load.id) {
      const undirectedKey = engineeringLoadMergeKey({ ...load, direction: undefined }, draft);
      const candidates = Array.from(merged.entries()).filter(([, candidate]) =>
        !candidate.id && (candidate.direction === undefined || load.direction === undefined)
        && engineeringLoadMergeKey({ ...candidate, direction: undefined }, draft) === undirectedKey);
      if (candidates.length === 1) {
        const [priorKey, candidate] = candidates[0];
        prior = candidate;
        merged.delete(priorKey);
      }
    }
    const next = prior ? { ...prior, ...load,
      direction: load.direction ?? prior.direction,
      location: load.location ?? prior.location } : load;
    merged.set(engineeringLoadMergeKey(next, draft), next);
  }
  return Array.from(merged.values());
}

function isLineLoad(load: EngineeringDraftLoad): boolean {
  return load.kind === 'line' || load.kind === 'distributed' || load.unit === 'kN/m';
}

function isPointLikeLoad(load: EngineeringDraftLoad): boolean {
  return load.kind === 'point' || load.kind === 'nodal' || load.unit === 'kN';
}

function legacyLoadType(load: EngineeringDraftLoad): DraftLoadType {
  return isLineLoad(load) ? 'distributed' : 'point';
}

function legacyLoadPosition(load: EngineeringDraftLoad): DraftLoadPosition {
  if (isLineLoad(load)) return 'full-span';
  const role = load.location?.nodeRole?.toLowerCase();
  if (role?.includes('top')) return 'top-nodes';
  if (load.location?.xM !== undefined) return 'free-joint';
  return 'midspan';
}

function targetIncludes(load: EngineeringDraftLoad, text: string): boolean {
  const targetText = [load.target, load.location?.nodeRole]
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .join(' ')
    .toLowerCase();
  return targetText.includes(text.toLowerCase());
}

function targetMatches(load: EngineeringDraftLoad, terms: readonly string[]): boolean {
  return terms.some((term) => targetIncludes(load, term));
}

function isClearPortalTarget(load: EngineeringDraftLoad, includeTerms: readonly string[], excludeTerms: readonly string[]): boolean {
  return targetMatches(load, includeTerms) && !targetMatches(load, excludeTerms);
}

const PORTAL_ROOF_TARGETS = ['roof', 'rafter', 'eave', '屋面', '屋顶', '檐梁'];
const PORTAL_MEZZANINE_TARGETS = ['mezzanine', 'platform', 'intermediate floor', '夹层', '平台'];
const PORTAL_CRANE_TARGETS = ['crane', '吊车'];

function modelLoadDirection(load: EngineeringDraftLoad): 'fx' | 'fy' | 'fz' {
  if (load.direction === 'globalX') return 'fx';
  if (load.direction === 'globalY') return 'fy';
  return 'fz';
}

function signedNodalComponent(load: EngineeringDraftLoad): Record<string, number> {
  const component = modelLoadDirection(load);
  const sign = component === 'fz' && load.direction !== 'globalZ' ? -1 : 1;
  return { [`${component}KN`]: sign * load.magnitude };
}

function firstLoad(loads: EngineeringDraftLoad[] | undefined): EngineeringDraftLoad | undefined {
  return loads?.find((load) => isLineLoad(load)) ?? loads?.find((load) => isPointLikeLoad(load));
}

function sumPositive(values: number[] | undefined): number | undefined {
  if (!values?.length) return undefined;
  const total = values.reduce((acc, value) => acc + value, 0);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

function framePlanAreaM2(patch: DraftExtraction): number | undefined {
  const totalSpanX = sumPositive(patch.bayWidthsXM);
  const totalSpanY = sumPositive(patch.bayWidthsYM);
  if (totalSpanX !== undefined && totalSpanY !== undefined) {
    return totalSpanX * totalSpanY;
  }
  const totalSpan2d = sumPositive(patch.bayWidthsM) ?? totalSpanX;
  return totalSpan2d !== undefined ? totalSpan2d * totalSpan2d : undefined;
}

function frameLoadTotalKN(load: EngineeringDraftLoad, patch: DraftExtraction): number | undefined {
  if (load.unit === 'kN') return load.magnitude;
  if (load.unit === 'kN/m') {
    return undefined;
  }
  if (load.unit === 'kN/m2') {
    const areaM2 = framePlanAreaM2(patch);
    return areaM2 !== undefined ? load.magnitude * areaM2 : undefined;
  }
  return undefined;
}

function isTopStoryTarget(target: string): boolean {
  const trimmed = target.trim();
  const text = trimmed.toLowerCase();
  return text.includes('roof')
    || /屋面|屋顶|楼顶|顶层|顶楼/u.test(trimmed)
    || trimmed === '顶';
}

export function isLocalizedFramePointLoad(load: EngineeringDraftLoad): boolean {
  if (!isPointLikeLoad(load)) return false;
  return load.location?.story !== undefined && Boolean(load.location.nodeRole?.trim());
}

export function hasIncompleteFramePointLoadLocation(load: EngineeringDraftLoad): boolean {
  if (!isPointLikeLoad(load)) return false;
  const hasStory = load.location?.story !== undefined;
  const hasNodeRole = Boolean(load.location?.nodeRole?.trim());
  return hasStory !== hasNodeRole;
}

function parseStoryOrdinal(target: string | undefined, storyCount: number): number | undefined {
  if (!target) return undefined;
  const text = target.toLowerCase();
  if (isTopStoryTarget(target)) return storyCount;
  const numericMatch = text.match(/(?:floor|story|level)\s*([0-9]+)/i)
    ?? target.match(/第?\s*([0-9]+)\s*层/u);
  if (numericMatch?.[1]) {
    const parsed = Number.parseInt(numericMatch[1], 10);
    return parsed >= 1 && parsed <= storyCount ? parsed : undefined;
  }
  const chineseMatch = target.match(/第?\s*([一二两三四五六七八九十廿]+)\s*层/u);
  if (!chineseMatch?.[1]) return undefined;
  const table: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
    廿: 20,
  };
  const raw = chineseMatch[1];
  let parsed: number | undefined;
  if (raw === '十' || raw === '廿') {
    parsed = table[raw];
  } else if (raw.startsWith('十')) {
    parsed = 10 + (table[raw[1]] ?? 0);
  } else if (raw.startsWith('廿')) {
    parsed = 20 + (table[raw[1]] ?? 0);
  } else if (raw.endsWith('十')) {
    parsed = (table[raw[0]] ?? 1) * 10;
  } else if (raw.includes('十')) {
    const [tens, ones] = raw.split('十');
    parsed = (table[tens] ?? 1) * 10 + (table[ones] ?? 0);
  } else {
    parsed = table[raw];
  }
  return parsed !== undefined && parsed >= 1 && parsed <= storyCount ? parsed : undefined;
}

function resolveFrameLoadStory(load: EngineeringDraftLoad, storyCount: number): number | undefined {
  const locationStory = load.location?.story;
  if (
    typeof locationStory === 'number'
    && Number.isInteger(locationStory)
    && locationStory >= 1
    && locationStory <= storyCount
  ) {
    return locationStory;
  }
  return parseStoryOrdinal(load.target, storyCount);
}

function hasFloorLoadValues(floorLoads: DraftFloorLoad[] | undefined): boolean {
  return Boolean(floorLoads?.some((load) => (
    load.verticalKN !== undefined
    || load.liveLoadKN !== undefined
    || load.lateralXKN !== undefined
    || load.lateralYKN !== undefined
  )));
}

export function mergeFrameFloorLoadValues(
  current: DraftFloorLoad[] | undefined,
  incoming: DraftFloorLoad[] | undefined,
): DraftFloorLoad[] | undefined {
  if (!current?.length) return incoming;
  if (!incoming?.length) return current;
  const merged = new Map<number, DraftFloorLoad>();
  for (const load of current) {
    merged.set(load.story, { ...load });
  }
  for (const load of incoming) {
    const existing = merged.get(load.story);
    merged.set(load.story, {
      story: load.story,
      verticalKN: load.verticalKN ?? existing?.verticalKN,
      liveLoadKN: load.liveLoadKN ?? existing?.liveLoadKN,
      lateralXKN: load.lateralXKN ?? existing?.lateralXKN,
      lateralYKN: load.lateralYKN ?? existing?.lateralYKN,
    });
  }
  return Array.from(merged.values()).sort((left, right) => left.story - right.story);
}

function storyHeightsForWind(patch: DraftExtraction): number[] | undefined {
  const explicit = patch.storyHeightsM?.filter((height) => Number.isFinite(height) && height > 0);
  if (explicit?.length) return explicit;
  const storyCount = patch.storyCount;
  if (!storyCount || !patch.heightM || patch.heightM <= 0) return undefined;
  return Array.from({ length: storyCount }, () => patch.heightM! / storyCount);
}

export function projectWindPressureToFloorLoads(
  wind: DraftWindParams | undefined,
  patch: DraftExtraction,
): DraftFloorLoad[] | undefined {
  const pressure = positiveNumber(wind?.basicPressureKNM2);
  if (pressure === undefined) return undefined;
  const storyHeights = storyHeightsForWind(patch);
  if (!storyHeights?.length) return undefined;
  const exposedWidthM = sumPositive(patch.bayWidthsYM)
    ?? sumPositive(patch.bayWidthsM)
    ?? sumPositive(patch.bayWidthsXM);
  if (exposedWidthM === undefined) return undefined;
  const factor = (wind?.shapeFactor ?? 1) * (wind?.heightVariationFactor ?? 1);
  return storyHeights.map((height, index) => ({
    story: index + 1,
    lateralXKN: Number((pressure * factor * exposedWidthM * height).toFixed(6)),
  }));
}

function assignFloorLoadValue(
  floorLoadsByStory: Map<number, DraftFloorLoad>,
  story: number,
  field: 'verticalKN' | 'lateralXKN' | 'lateralYKN',
  value: number,
): void {
  const current = floorLoadsByStory.get(story) ?? { story };
  const previous = current[field] ?? 0;
  floorLoadsByStory.set(story, {
    ...current,
    [field]: previous + value,
  });
}

function frameFloorLoadField(load: EngineeringDraftLoad): 'verticalKN' | 'lateralXKN' | 'lateralYKN' {
  if (load.direction === 'globalX') return 'lateralXKN';
  if (load.direction === 'globalY') return 'lateralYKN';
  return 'verticalKN';
}

type ConvertibleFrameLoad = {
  load: EngineeringDraftLoad;
  index: number;
  totalKN: number;
};

function projectFrameFloorLoads(loads: EngineeringDraftLoad[], patch: DraftExtraction): DraftFloorLoad[] | undefined {
  const storyCount = patch.storyCount ?? patch.storyHeightsM?.length;
  if (!storyCount) return undefined;

  const floorLoadsByStory = new Map<number, DraftFloorLoad>();
  const convertibleLoads: ConvertibleFrameLoad[] = loads
    .map((load, index) => ({ load, index, totalKN: frameLoadTotalKN(load, patch) }))
    .filter((item): item is ConvertibleFrameLoad => (
      item.totalKN !== undefined
      && Number.isFinite(item.totalKN)
      && !isLocalizedFramePointLoad(item.load)
      && !hasIncompleteFramePointLoadLocation(item.load)
    ));

  const comparableLoads: ConvertibleFrameLoad[] = convertibleLoads.filter((item) => (
    item.load.direction === 'gravity'
    || item.load.direction === 'globalZ'
    || item.load.direction === 'globalX'
    || item.load.direction === 'globalY'
    || item.load.direction === undefined
  ));

  for (const { load, index, totalKN } of comparableLoads) {
    const field = frameFloorLoadField(load);
    let stories: number[];
    const explicitStory = resolveFrameLoadStory(load, storyCount);
    if (explicitStory !== undefined) {
      stories = [explicitStory];
    } else {
      const sameFieldUntargetedLoads: ConvertibleFrameLoad[] = comparableLoads.filter((item) => (
        frameFloorLoadField(item.load) === field
        && resolveFrameLoadStory(item.load, storyCount) === undefined
      ));
      const untargetedIndex = sameFieldUntargetedLoads.findIndex((item) => item.index === index);
      if (sameFieldUntargetedLoads.length > 1) {
        stories = untargetedIndex >= 0 && untargetedIndex < storyCount ? [untargetedIndex + 1] : [];
      } else {
        stories = Array.from({ length: storyCount }, (_, storyIndex) => storyIndex + 1);
      }
    }

    for (const story of stories) {
      assignFloorLoadValue(floorLoadsByStory, story, field, Number((load.direction === 'globalZ' ? -totalKN : totalKN).toFixed(6)));
    }
  }

  return floorLoadsByStory.size
    ? Array.from(floorLoadsByStory.values()).sort((left, right) => left.story - right.story)
    : undefined;
}

function sectionDimensionsM(section: string | undefined): { sectionWidthM?: number; sectionDepthM?: number } {
  if (!section) return {};
  const match = section.match(/([0-9]+(?:\.[0-9]+)?)\s*[xX×*]\s*([0-9]+(?:\.[0-9]+)?)/u);
  if (!match?.[1] || !match[2]) return {};
  const width = Number(match[1]);
  const depth = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(depth) || width <= 0 || depth <= 0) return {};
  const scale = width > 20 || depth > 20 ? 1000 : 1;
  return {
    sectionWidthM: width / scale,
    sectionDepthM: depth / scale,
  };
}

export function projectEngineeringDraftToLegacyPatch(
  patch: DraftExtraction,
  inferredType: InferredModelType,
): DraftExtraction {
  const engineeringDraft = patch.engineeringDraft;
  if (!engineeringDraft) return patch;

  const loads = engineeringDraft.loads ?? [];
  const primaryLoad = firstLoad(loads);
  const spanLengths = engineeringDraft.geometry?.spanLengthsM;
  const skillState: Record<string, unknown> = {
    ...(patch.skillState ?? {}),
    engineeringDraft,
    extractionSource: 'engineering-draft',
  };
  const next: DraftExtraction = {
    ...patch,
    inferredType,
    engineeringDraft,
    skillState,
  };

  if (engineeringDraft.geometry?.lengthM !== undefined) next.lengthM = next.lengthM ?? engineeringDraft.geometry.lengthM;
  if (engineeringDraft.geometry?.heightM !== undefined) next.heightM = next.heightM ?? engineeringDraft.geometry.heightM;
  if (engineeringDraft.boundary?.supportType !== undefined) next.supportType = next.supportType ?? engineeringDraft.boundary.supportType;
  if (engineeringDraft.boundary?.frameBaseSupportType !== undefined) {
    next.frameBaseSupportType = next.frameBaseSupportType ?? engineeringDraft.boundary.frameBaseSupportType;
  }
  if (primaryLoad && inferredType !== 'frame' && inferredType !== 'portal-frame') {
    next.loadKN = next.loadKN ?? primaryLoad.magnitude;
    next.loadType = next.loadType ?? legacyLoadType(primaryLoad);
    next.loadPosition = next.loadPosition ?? legacyLoadPosition(primaryLoad);
    if (primaryLoad.location?.xM !== undefined) {
      next.loadPositionM = next.loadPositionM ?? primaryLoad.location.xM;
    }
  }

  if (inferredType === 'beam') {
    if (next.lengthM === undefined && spanLengths?.length) {
      next.lengthM = spanLengths.reduce((total, span) => total + span, 0);
    }
    skillState.beamLoads = loads.map((load) => ({
      kind: isLineLoad(load) ? 'distributed' : 'point',
      magnitude: load.magnitude,
      unit: load.unit,
      direction: load.direction,
      target: load.target,
      xM: load.location?.xM,
      spanIndex: load.location?.spanIndex,
    }));
  }

  if (inferredType === 'truss') {
    if (next.lengthM === undefined && spanLengths?.length) {
      next.lengthM = spanLengths.reduce((total, span) => total + span, 0);
    }
    if (engineeringDraft.geometry?.heightM !== undefined) {
      next.heightM = next.heightM ?? engineeringDraft.geometry.heightM;
    }
    if (next.bayCount === undefined && spanLengths?.length) {
      next.bayCount = spanLengths.length;
    }
  }

  if (inferredType === 'frame') {
    const geometry = engineeringDraft.geometry;
    if (geometry?.storyHeightsM?.length) {
      next.storyHeightsM = next.storyHeightsM ?? geometry.storyHeightsM;
      next.storyCount = next.storyCount ?? geometry.storyHeightsM.length;
    }
    if (geometry?.bayWidthsM?.length) {
      next.bayWidthsM = next.bayWidthsM ?? geometry.bayWidthsM;
      next.bayCount = next.bayCount ?? geometry.bayWidthsM.length;
      next.frameDimension = next.frameDimension ?? '2d';
    }
    if (geometry?.bayWidthsXM?.length && geometry?.bayWidthsYM?.length) {
      next.bayWidthsXM = next.bayWidthsXM ?? geometry.bayWidthsXM;
      next.bayCountX = next.bayCountX ?? geometry.bayWidthsXM.length;
      next.frameDimension = next.frameDimension ?? '3d';
    } else if (geometry?.bayWidthsXM?.length && !next.bayWidthsM?.length) {
      next.bayWidthsM = geometry.bayWidthsXM;
      next.bayCount = next.bayCount ?? geometry.bayWidthsXM.length;
      next.frameDimension = next.frameDimension ?? '2d';
    }
    if (geometry?.bayWidthsYM?.length) {
      next.bayWidthsYM = next.bayWidthsYM ?? geometry.bayWidthsYM;
      next.bayCountY = next.bayCountY ?? geometry.bayWidthsYM.length;
      next.frameDimension = next.frameDimension ?? '3d';
    }
    if (!next.bayWidthsM?.length && spanLengths?.length) {
      next.bayWidthsM = spanLengths;
      next.bayCount = spanLengths.length;
      next.frameDimension = next.frameDimension ?? '2d';
    }
    if (engineeringDraft.material?.family === 'concrete' && engineeringDraft.material.grade) {
      next.frameConcreteGrade = engineeringDraft.material.grade;
    } else if (engineeringDraft.material?.grade) {
      next.frameMaterial = engineeringDraft.material.grade;
    }
    if (engineeringDraft.material?.rebarGrade) {
      next.frameRebarGrade = engineeringDraft.material.rebarGrade;
    }
    if (engineeringDraft.sections?.column) {
      next.frameColumnSection = engineeringDraft.sections.column;
    }
    if (engineeringDraft.sections?.beam) {
      next.frameBeamSection = engineeringDraft.sections.beam;
    }
    next.wind = next.wind ?? engineeringDraft.wind;
    const projectedFloorLoads = mergeFrameFloorLoadValues(
      projectFrameFloorLoads(loads, next),
      projectWindPressureToFloorLoads(next.wind, next),
    );
    if (projectedFloorLoads?.length) {
      next.floorLoads = hasFloorLoadValues(next.floorLoads)
        ? mergeFrameFloorLoadValues(next.floorLoads, projectedFloorLoads)
        : projectedFloorLoads;
    }
  }

  if (inferredType === 'column') {
    const section = engineeringDraft.sections?.column ?? engineeringDraft.sections?.member;
    Object.assign(skillState, sectionDimensionsM(section));
    if (engineeringDraft.material?.family === 'steel' || engineeringDraft.material?.family === 'concrete') {
      skillState.materialFamily = engineeringDraft.material.family;
    }
    const columnLoads = loads
      .filter((load) => isPointLikeLoad(load))
      .map((load) => signedNodalComponent(load));
    if (columnLoads.length) {
      skillState.columnLoads = columnLoads;
    }
    if (next.lengthM === undefined && next.heightM !== undefined) next.lengthM = next.heightM;
    if (next.heightM === undefined && next.lengthM !== undefined) next.heightM = next.lengthM;
    const axial = columnLoads.find((load) => typeof load.fzKN === 'number') as { fzKN?: number } | undefined;
    if (axial?.fzKN !== undefined) {
      next.loadKN = Math.abs(axial.fzKN);
      next.loadType = 'point';
      next.loadPosition = 'top-nodes';
    }
  }

  if (inferredType === 'double-span-beam') {
    if (spanLengths?.length) {
      next.spanLengthM = next.spanLengthM ?? spanLengths[0];
      skillState.spanLengthsM = spanLengths;
      skillState.spanCount = spanLengths.length;
    }
    const lineLoad = loads.find(isLineLoad);
    if (lineLoad) {
      skillState.distributedLoadKNM = (lineLoad.direction === 'globalZ' ? -lineLoad.magnitude : lineLoad.magnitude);
      next.loadKN = next.loadKN ?? lineLoad.magnitude;
      next.loadType = next.loadType ?? 'distributed';
      next.loadPosition = next.loadPosition ?? 'full-span';
    }
    const pointLoad = loads.find((load) => isPointLikeLoad(load) && !isLineLoad(load));
    if (pointLoad) {
      skillState.pointLoadKN = (pointLoad.direction === 'globalZ' ? -pointLoad.magnitude : pointLoad.magnitude);
      if (pointLoad.location?.spanIndex !== undefined) skillState.pointLoadSpanIndex = pointLoad.location.spanIndex;
      if (pointLoad.location?.xM !== undefined) skillState.pointLoadXM = pointLoad.location.xM;
    }
  }

  if (inferredType === 'portal-frame') {
    if (spanLengths?.length) {
      next.spanLengthM = next.spanLengthM ?? spanLengths[0];
      skillState.portalBaySpansM = spanLengths;
      skillState.portalBayCount = spanLengths.length;
    }
    if (engineeringDraft.geometry?.mezzanineHeightM !== undefined) {
      skillState.mezzanineHeightM = engineeringDraft.geometry.mezzanineHeightM;
    }
    if (engineeringDraft.geometry?.mezzanineLengthM !== undefined) {
      skillState.mezzanineLengthM = engineeringDraft.geometry.mezzanineLengthM;
    }
    const mezzanineLoad = loads.find((load) => (
      isLineLoad(load)
      && isClearPortalTarget(load, PORTAL_MEZZANINE_TARGETS, PORTAL_ROOF_TARGETS)
    ));
    if (mezzanineLoad) {
      skillState.mezzanineLoadKN = (mezzanineLoad.direction === 'globalZ' ? -mezzanineLoad.magnitude : mezzanineLoad.magnitude);
    }
    const roofLoad = loads.find((load) => (
      isLineLoad(load)
      && isClearPortalTarget(load, PORTAL_ROOF_TARGETS, PORTAL_MEZZANINE_TARGETS)
    ))
      ?? loads.find((load) => (
        isLineLoad(load)
        && !targetMatches(load, PORTAL_MEZZANINE_TARGETS)
        && !targetMatches(load, PORTAL_CRANE_TARGETS)
      ));
    if (roofLoad) {
      skillState.roofLoadKNM = (roofLoad.direction === 'globalZ' ? -roofLoad.magnitude : roofLoad.magnitude);
      next.loadKN = (roofLoad.direction === 'globalZ' ? -roofLoad.magnitude : roofLoad.magnitude);
      next.loadType = 'distributed';
      next.loadPosition = 'full-span';
    } else {
      const defaultPortalLoad = loads.find((load) => (
        !targetMatches(load, PORTAL_MEZZANINE_TARGETS)
        && !targetMatches(load, PORTAL_CRANE_TARGETS)
      ));
      if (defaultPortalLoad) {
        next.loadKN = next.loadKN ?? defaultPortalLoad.magnitude;
        next.loadType = next.loadType ?? legacyLoadType(defaultPortalLoad);
        next.loadPosition = next.loadPosition ?? legacyLoadPosition(defaultPortalLoad);
      }
    }
    const craneLoad = loads.find((load) => targetMatches(load, PORTAL_CRANE_TARGETS));
    if (craneLoad) {
      skillState.craneLoadKN = (craneLoad.direction === 'globalZ' ? -craneLoad.magnitude : craneLoad.magnitude);
    }
  }

  return next;
}
