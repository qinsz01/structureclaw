/**
 * The draft boundary. `EngineeringDraft` is the canonical internal representation; this module is
 * the only place where outside representations are converted to and from it.
 *
 * Inbound (`ingestDraft`, `ingestGenericDraft`, `clearDraftFields`): raw LLM/tool patches with
 * legacy flat scalars and aliases become a normalized `DraftExtraction`.
 * Outbound (`mergeDraftState`, `projectDraftPatch`, `projectDraftState`): the flat `DraftState`
 * wire fields (prompts, tool responses, checkpoints, frontend) and the persisted legacy
 * `skillState.engineeringDraft` mirror are produced only here.
 *
 * Old persisted states need no migration: a stored `skillState.engineeringDraft` mirror is never
 * read back (the top-level `engineeringDraft` is authoritative) and is refreshed on output.
 */
import { fieldTokens } from '../../engineering/field-path.js';
import { enforceSectionProvenance } from '../../engineering/section-provenance.js';
import { sectionEvidenceContext, type SectionEvidence } from '../../engineering/section-evidence.js';
import { draftContract } from '../../engineering/draft-contract.js';
import { draftFieldValues, mergeDraftDiagnostics } from '../draft-diagnostics.js';
import { mergeEngineeringDraft, normalizeEngineeringDraft } from '../engineering-draft.js';
import { legacyScalarsShadowing } from './legacy-fields.js';
import {
  asRecord,
  invalidDraftFieldsOf,
  mergeFloorLoadsByStory,
  normalizeDraftIssues,
  normalizeFloorLoads,
  normalizeFrameBaseSupportType,
  normalizeFrameDimension,
  normalizeInferredType,
  normalizeLoadPosition,
  normalizeLoadPositionM,
  normalizeLoadType,
  normalizeNumber,
  normalizeNumberArray,
  normalizePositiveInteger,
  normalizeSkillState,
  normalizeSupportType,
} from './normalize.js';
import { projectDraftPatch } from './project-patch.js';
import { cleanSectionMaterials, reconcileDraftMaterials } from './materials.js';
import type {
  DraftExtraction,
  DraftFloorLoad,
  DraftIssue,
  DraftState,
  EngineeringDraft,
  InferredModelType,
} from '../../shared/types/agent.js';

export { projectBeamLoads, projectDraftPatch } from './project-patch.js';

// ---------------------------------------------------------------------------
// Outbound: canonical draft -> DraftState
// ---------------------------------------------------------------------------

interface ProjectDraftStateOptions {
  /**
   * When to write the legacy `skillState.engineeringDraft` mirror:
   * - 'existing' (default): only where the base state already carries one;
   * - 'whenSkillState': whenever the base has a skill state (beam conflict resolution).
   */
  mirror?: 'existing' | 'whenSkillState';
}

/** Attach the canonical draft to a state and keep the persisted legacy mirror equal to it. */
export function projectDraftState<T extends DraftState>(
  draft: EngineeringDraft | undefined,
  base: T,
  options: ProjectDraftStateOptions = {},
): T {
  const mirror = options.mirror === 'whenSkillState' ? Boolean(base.skillState) : Boolean(base.skillState?.engineeringDraft);
  const next: T = draft === undefined && !('engineeringDraft' in base) ? { ...base } : { ...base, engineeringDraft: draft };
  return mirror ? { ...next, skillState: { ...base.skillState, engineeringDraft: draft } } : next;
}

function repeatValue(count: number | undefined, value: number | undefined): number[] | undefined {
  if (!count || !value || count <= 0 || value <= 0) {
    return undefined;
  }
  return Array.from({ length: count }, () => value);
}

function buildUniformFloorLoads(
  storyCount: number | undefined,
  verticalKN: number | undefined,
  lateralXKN: number | undefined,
  lateralYKN: number | undefined,
): DraftFloorLoad[] | undefined {
  if (!storyCount || storyCount <= 0) {
    return undefined;
  }
  if (verticalKN === undefined && lateralXKN === undefined && lateralYKN === undefined) {
    return undefined;
  }
  return Array.from({ length: storyCount }, (_, index) => ({
    story: index + 1,
    verticalKN,
    lateralXKN,
    lateralYKN,
  }));
}

function mergeStateFloorLoads(
  existing: DraftFloorLoad[] | undefined,
  incoming: DraftFloorLoad[] | undefined,
): DraftFloorLoad[] | undefined {
  if (!existing?.length) {
    return incoming?.length ? [...incoming].sort((a, b) => a.story - b.story) : undefined;
  }
  if (!incoming?.length) {
    return [...existing].sort((a, b) => a.story - b.story);
  }
  const normalized = mergeFloorLoadsByStory(existing, incoming)
    .filter((load) => load.verticalKN !== undefined || load.liveLoadKN !== undefined || load.lateralXKN !== undefined || load.lateralYKN !== undefined);
  return normalized.length > 0 ? normalized : undefined;
}

/** Apply an ingested patch to a stored state: clear, then merge canonical and flat fields. */
export function mergeDraftState(existing: DraftState | undefined, patch: DraftExtraction): DraftState {
  existing = clearDraftFields(existing, patch.clearDraftFields);
  const mergedType = patch.inferredType && patch.inferredType !== 'unknown' ? patch.inferredType : (existing?.inferredType || 'unknown');
  const mergedLength = patch.lengthM ?? existing?.lengthM;
  const mergedSpan = patch.spanLengthM ?? existing?.spanLengthM;
  const spanLengthM = mergedSpan ?? ((mergedType === 'portal-frame' || mergedType === 'double-span-beam') ? mergedLength : undefined);
  const storyCount = patch.storyCount ?? existing?.storyCount ?? patch.storyHeightsM?.length ?? existing?.storyHeightsM?.length;
  const bayCount = patch.bayCount ?? existing?.bayCount ?? patch.bayWidthsM?.length ?? existing?.bayWidthsM?.length;
  const bayCountX = patch.bayCountX ?? existing?.bayCountX ?? patch.bayWidthsXM?.length ?? existing?.bayWidthsXM?.length;
  const bayCountY = patch.bayCountY ?? existing?.bayCountY ?? patch.bayWidthsYM?.length ?? existing?.bayWidthsYM?.length;
  const frameDimension = patch.frameDimension ?? existing?.frameDimension;
  const storyHeightsM = patch.storyHeightsM ?? existing?.storyHeightsM ?? repeatValue(storyCount, patch.heightM ?? existing?.heightM);
  const bayWidthsM = patch.bayWidthsM ?? existing?.bayWidthsM;
  const bayWidthsXM = patch.bayWidthsXM ?? existing?.bayWidthsXM;
  const bayWidthsYM = patch.bayWidthsYM ?? existing?.bayWidthsYM;
  const floorLoads = mergeStateFloorLoads(existing?.floorLoads, patch.floorLoads);
  const engineeringDraft = cleanSectionMaterials(mergeEngineeringDraft(existing?.engineeringDraft, patch.engineeringDraft));
  const result: DraftState = {
    inferredType: mergedType,
    engineeringDraft,
    lengthM: mergedLength,
    spanLengthM,
    heightM: patch.heightM ?? existing?.heightM,
    supportType: patch.supportType ?? existing?.supportType,
    frameDimension,
    storyCount,
    bayCount,
    bayCountX,
    bayCountY,
    storyHeightsM,
    bayWidthsM: frameDimension === '2d'
      ? (bayWidthsM ?? repeatValue(bayCount, patch.lengthM ?? existing?.lengthM))
      : undefined,
    bayWidthsXM: frameDimension === '3d' ? bayWidthsXM : undefined,
    bayWidthsYM: frameDimension === '3d' ? bayWidthsYM : undefined,
    floorLoads: floorLoads ?? buildUniformFloorLoads(
      storyCount,
      patch.loadKN ?? existing?.loadKN,
      undefined,
      undefined,
    ),
    frameBaseSupportType: patch.frameBaseSupportType ?? existing?.frameBaseSupportType,
    loadKN: patch.loadKN ?? existing?.loadKN,
    loadType: patch.loadType ?? existing?.loadType,
    loadPosition: patch.loadPosition ?? existing?.loadPosition,
    loadPositionM: patch.loadPositionM ?? existing?.loadPositionM,
    updatedAt: Date.now(),
  };
  return projectDraftState(engineeringDraft, { ...result, ...mergeDraftDiagnostics(existing, patch, result) });
}

// ---------------------------------------------------------------------------
// Inbound: explicit removals
// ---------------------------------------------------------------------------

const isPlainRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const failClear = (path: string, reason: string): never => { throw new Error(`DRAFT_CLEAR_INVALID: ${path}: ${reason} / 草稿删除操作无效，原状态未变`); };

function normalizeClearDraftFields(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(field => typeof field !== 'string' || !field.trim())) failClear('clearDraftFields', 'expected field paths');
  return [...new Set((value as string[]).map(field => field.trim().replace(/^engineeringDraft\./, '')))];
}

/** Omission means unchanged. Deletion is a separate operation, never guessed from prose or shape type. */
export function clearDraftFields(state: DraftState | undefined, fields: string[] | undefined): DraftState | undefined {
  if (!fields?.length) return state;
  if (!state?.engineeringDraft) return failClear('clearDraftFields', 'no existing engineering draft');
  const next = structuredClone(state);
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '.') || a.startsWith(b + '[');
  const addresses = fields.map(path => ({ path, parts: fieldTokens(path) }));
  for (const { path, parts } of addresses) {
    if (!parts.length || parts.some(part => part.index || part.wildcard)
      || !Object.hasOwn(draftContract.properties, parts[0]!.key)) failClear(path, 'use canonical fields and quoted stable IDs');
    // Raw evidence and its provenance are not a mutable calculation setting.
    if (['inputEvidence', 'metadata', 'model'].includes(parts[0]!.key)
      || parts.some(part => part.key === 'extra') || parts.at(-1)!.key === 'id') failClear(path, 'identity and evidence are protected');
    for (const other of addresses) if (other.path !== path && overlaps(path, other.path)) failClear(path, 'overlapping removals');
    let owner: unknown = next.engineeringDraft;
    for (let i = 0; i < parts.length; i++) {
      const { key } = parts[i]!;
      const last = i === parts.length - 1;
      if (Array.isArray(owner)) {
        const matches = owner.flatMap((item, index) => isPlainRecord(item) && item.id === key ? [index] : []);
        if (matches.length !== 1) failClear(path, 'stable ID is absent or ambiguous');
        if (last) {
          owner.splice(matches[0]!, 1);
        } else owner = owner[matches[0]!];
      } else if (isPlainRecord(owner)) {
        if (last) {
          // Repeating an explicit withdrawal is harmless when this existing object's
          // field is declared by the canonical schema. Typos and missing IDs still fail.
          if (!Object.hasOwn(owner, key) && draftFieldValues(next.engineeringDraft!, path).length !== 1) failClear(path, 'field is not declared');
          delete owner[key];
        } else owner = owner[key];
      } else failClear(path, 'parent field does not exist');
    }
    // Historical scalar views cannot resurrect a removed canonical value.
    for (const alias of legacyScalarsShadowing(path, overlaps)) delete next[alias];
  }
  const removed = fields.flatMap(field => draftFieldValues(state.engineeringDraft!, field).map(item => item.path));
  const withdrawn = (field: string) => draftFieldValues(state.engineeringDraft!, field).some(item => removed.some(path => overlaps(item.path, path)));
  next.draftIssues = next.draftIssues?.filter(issue => !issue.field || !withdrawn(issue.target ?? issue.field));
  const projected = projectDraftState(next.engineeringDraft, next);
  return projected.skillState && Array.isArray(projected.skillState.invalidDraftFields) ? { ...projected, skillState: { ...projected.skillState,
    invalidDraftFields: projected.skillState.invalidDraftFields.filter(field => typeof field !== 'string' || !withdrawn(field)),
  } } : projected;
}

// ---------------------------------------------------------------------------
// Inbound: structured LLM / tool patches
// ---------------------------------------------------------------------------

function pushUnique(values: string[], key: string): void {
  if (!values.includes(key)) {
    values.push(key);
  }
}

function invalidIfNonPositive(patch: Record<string, unknown>, key: string, invalid: string[]): void {
  if (!(key in patch)) {
    return;
  }
  const parsed = normalizeNumber(patch[key]);
  if (parsed !== undefined && parsed <= 0) {
    pushUnique(invalid, key);
  }
}

function invalidIfArrayHasNonPositive(patch: Record<string, unknown>, key: string, invalid: string[]): void {
  const value = patch[key];
  if (!Array.isArray(value)) {
    return;
  }
  const hasInvalid = value.some((item) => {
    const parsed = normalizeNumber(item);
    return parsed !== undefined && parsed <= 0;
  });
  if (hasInvalid) {
    pushUnique(invalid, key);
  }
}

function collectEngineeringDraftInvalidFields(engineeringDraft: unknown, invalid: string[]): void {
  const draft = asRecord(engineeringDraft);
  if (!draft) {
    return;
  }
  const rawGeometry = asRecord(draft.geometry);
  if (rawGeometry) {
    invalidIfNonPositive(rawGeometry, 'lengthM', invalid);
    invalidIfNonPositive(rawGeometry, 'heightM', invalid);
    invalidIfArrayHasNonPositive(rawGeometry, 'spanLengthsM', invalid);
    invalidIfArrayHasNonPositive(rawGeometry, 'storyHeightsM', invalid);
    invalidIfArrayHasNonPositive(rawGeometry, 'bayWidthsM', invalid);
    invalidIfArrayHasNonPositive(rawGeometry, 'bayWidthsXM', invalid);
    invalidIfArrayHasNonPositive(rawGeometry, 'bayWidthsYM', invalid);
  }
  if (Array.isArray(draft.loads)) {
    const hasInvalidLoad = draft.loads.some((item) => {
      const record = asRecord(item);
      if (!record) {
        return false;
      }
      const parsed = normalizeNumber(record.magnitude ?? record.value ?? record.loadKN ?? record.forceKN ?? record.intensity);
      return parsed === undefined;
    });
    if (hasInvalidLoad) {
      pushUnique(invalid, 'loadKN');
    }
  }
}

function collectInvalidDraftFields(patch: Record<string, unknown>): string[] | undefined {
  const invalid: string[] = [];
  for (const key of ['lengthM', 'spanLengthM', 'heightM'] as const) {
    invalidIfNonPositive(patch, key, invalid);
  }
  for (const key of ['storyCount', 'bayCount', 'bayCountX', 'bayCountY'] as const) {
    invalidIfNonPositive(patch, key, invalid);
  }
  for (const key of ['storyHeightsM', 'bayWidthsM', 'bayWidthsXM', 'bayWidthsYM'] as const) {
    invalidIfArrayHasNonPositive(patch, key, invalid);
  }
  collectEngineeringDraftInvalidFields(patch.engineeringDraft, invalid);
  return invalid.length ? invalid : undefined;
}

function withInvalidDraftFields(
  skillState: Record<string, unknown> | undefined,
  invalidDraftFields: string[] | undefined,
): Record<string, unknown> | undefined {
  if (!skillState && !invalidDraftFields?.length) {
    return undefined;
  }
  const merged = Array.from(new Set([
    ...invalidDraftFieldsOf({ skillState }),
    ...(invalidDraftFields ?? []),
  ]));
  return {
    ...(skillState ?? {}),
    ...(merged.length ? { invalidDraftFields: merged } : {}),
  };
}

function normalizeDraftWithReportedLoadIssue(value: unknown, issues: DraftIssue[] | undefined, existing?: DraftState) {
  try { return normalizeEngineeringDraft(value, existing?.engineeringDraft); }
  catch (error) {
    // A reported ambiguity is a clarification state, never a partially executable load.
    const reported = issues?.some((issue) => issue.field === 'loadType' || issue.field === 'loadKN');
    if (!reported || !/INVALID_ENGINEERING_LOAD|LOAD_UNIT_REQUIRED|LOAD_DIRECTION_INVALID/.test(String(error))
      || !value || typeof value !== 'object' || Array.isArray(value)) throw error;
    return normalizeEngineeringDraft({ ...value, loads: undefined }, existing?.engineeringDraft);
  }
}

/** Raw patch (canonical draft and/or legacy flat scalars) -> normalized extraction. */
export function ingestDraft(patch: Record<string, unknown> | null | undefined, existing?: DraftState, userTexts?: SectionEvidence): DraftExtraction {
  if (!patch) {
    return {};
  }
  const draftIssues = normalizeDraftIssues(patch.draftIssues);
  const cleared = patch.clearDraftFields !== undefined ? normalizeClearDraftFields(patch.clearDraftFields) : undefined;
  const accepted = existing ? clearDraftFields(existing, cleared) : existing;
  // Providers sometimes place property records/assignments alongside engineeringDraft. Other flat
  // skill fields (for example wind) retain their existing skill-specific interpretation.
  const rootDraft = Object.fromEntries(Object.entries(patch)
    .filter(([key]) => ['material', 'materials', 'sectionRecords', 'templateAssignments'].includes(key)));
  const rawDraft = Object.keys(rootDraft).length ? { ...rootDraft, ...asRecord(patch.engineeringDraft) } : patch.engineeringDraft;
  const engineeringDraft = verifyDraftSectionEvidence(reconcileDraftMaterials(normalizeDraftWithReportedLoadIssue(rawDraft, draftIssues, accepted),
    accepted?.engineeringDraft, normalizeInferredType(patch.inferredType) ?? accepted?.inferredType), userTexts);
  const issueFields = draftIssues
    ?.map((issue) => issue.field)
    .filter((field): field is string => typeof field === 'string' && field.trim().length > 0);
  const invalidDraftFields = Array.from(new Set([
    ...(collectInvalidDraftFields(engineeringDraft?.loads && patch.engineeringDraft && typeof patch.engineeringDraft === 'object'
      ? { ...patch, engineeringDraft: { ...patch.engineeringDraft, loads: engineeringDraft.loads } } : patch) ?? []),
    ...(issueFields ?? []),
  ]));
  const skillState = withInvalidDraftFields(
    normalizeSkillState(patch.skillState),
    invalidDraftFields.length ? invalidDraftFields : undefined,
  );
  return {
    inferredType: normalizeInferredType(patch.inferredType),
    ...(cleared !== undefined ? { clearDraftFields: cleared } : {}),
    skillId: typeof patch.skillId === 'string' ? patch.skillId : undefined,
    engineeringDraft,
    draftIssues,
    skillState,
    lengthM: normalizeNumber(patch.lengthM),
    spanLengthM: normalizeNumber(patch.spanLengthM),
    heightM: normalizeNumber(patch.heightM),
    supportType: normalizeSupportType(patch.supportType),
    frameDimension: normalizeFrameDimension(patch.frameDimension),
    storyCount: normalizePositiveInteger(patch.storyCount),
    bayCount: normalizePositiveInteger(patch.bayCount),
    bayCountX: normalizePositiveInteger(patch.bayCountX),
    bayCountY: normalizePositiveInteger(patch.bayCountY),
    storyHeightsM: normalizeNumberArray(patch.storyHeightsM),
    bayWidthsM: normalizeNumberArray(patch.bayWidthsM),
    bayWidthsXM: normalizeNumberArray(patch.bayWidthsXM),
    bayWidthsYM: normalizeNumberArray(patch.bayWidthsYM),
    floorLoads: normalizeFloorLoads(patch.floorLoads),
    frameBaseSupportType: normalizeFrameBaseSupportType(patch.frameBaseSupportType),
    loadKN: normalizeNumber(patch.loadKN),
    loadType: normalizeLoadType(patch.loadType),
    loadPosition: normalizeLoadPosition(patch.loadPosition),
    loadPositionM: normalizeLoadPositionM(patch.loadPositionM),
  };
}

/** Run after merging too: a partial patch can retain numbers from an older untrusted claim. */
export function verifyDraftSectionEvidence(draft: EngineeringDraft | undefined, userTexts?: SectionEvidence): EngineeringDraft | undefined {
  if (!draft || userTexts === undefined) return draft;
  userTexts = { ...sectionEvidenceContext(userTexts), sections: Array.isArray(draft.model?.sections) ? draft.model.sections : draft.sectionRecords };
  return { ...draft,
    ...(draft.sectionRecords ? { sectionRecords: draft.sectionRecords.map(section => enforceSectionProvenance(section, userTexts)) } : {}),
    ...(Array.isArray(draft.model?.sections) ? { model: { ...draft.model,
      sections: draft.model.sections.map(section => enforceSectionProvenance(section, userTexts)) } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Inbound: loose generic-skill patches (free-form aliases such as span/load/pointLoads)
// ---------------------------------------------------------------------------

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function normalizeLlmDeclaredType(value: unknown): InferredModelType | undefined {
  const normalizedText = stringValue(value)?.toLowerCase().trim();
  if (!normalizedText) return undefined;
  const normalized = normalizeInferredType(normalizedText);
  if (normalized && normalized !== 'unknown') return normalized;
  if (
    normalizedText === 'steel-frame'
    || normalizedText === 'concrete-frame'
    || normalizedText === 'reinforced-concrete-frame'
  ) {
    return 'frame';
  }
  if (normalizedText === 'portal') return 'portal-frame';
  if (normalizedText === 'girder') return 'beam';
  return undefined;
}

function draftIssuesFromSource(source: Record<string, unknown>): DraftExtraction['draftIssues'] {
  const issues = source.draftIssues;
  if (!Array.isArray(issues)) {
    return undefined;
  }
  return issues.filter((issue): issue is NonNullable<DraftExtraction['draftIssues']>[number] => (
    !!issue && typeof issue === 'object' && !Array.isArray(issue)
  ));
}

function genericSkillStateFromSource(source: Record<string, unknown>): Record<string, unknown> {
  const sourceSkillState = asRecord(source.skillState);
  return {
    ...(sourceSkillState ?? {}),
    genericDraft: source,
  };
}

function inferSupportTypeFromText(value: unknown): DraftExtraction['supportType'] {
  const normalized = normalizeSupportType(value);
  if (normalized) return normalized;
  const text = stringValue(value)?.toLowerCase();
  if (!text) return undefined;
  if (text.includes('simply') || text.includes('simple') || text.includes('简支')) return 'simply-supported';
  if (text.includes('cantilever') || text.includes('悬臂')) return 'cantilever';
  if (text.includes('fixed-fixed') || text.includes('两端固')) return 'fixed-fixed';
  if (text.includes('fixed-pinned') || text.includes('固铰')) return 'fixed-pinned';
  return undefined;
}

function inferLoadTypeFromPatch(patch: Record<string, unknown>): DraftExtraction['loadType'] {
  const normalized = normalizeLoadType(patch.loadType ?? patch.load_type);
  if (normalized) return normalized;
  if (Array.isArray(patch.pointLoads) || Array.isArray(patch.point_loads)) return 'point';
  if (Array.isArray(patch.distributedLoads) || Array.isArray(patch.distributed_loads)) return 'distributed';
  return undefined;
}

/** Generic-skill raw patch (canonical draft plus loose aliases) -> normalized extraction. */
export function ingestGenericDraft(
  llmDraftPatch: Record<string, unknown> | null | undefined,
  existing?: DraftState,
): DraftExtraction {
  const source = llmDraftPatch ?? {};
  const cleared = source.clearDraftFields !== undefined ? normalizeClearDraftFields(source.clearDraftFields) : undefined;
  const accepted = existing ? clearDraftFields(existing, cleared) : existing;
  const engineeringDraft = normalizeEngineeringDraft(source.engineeringDraft, accepted?.engineeringDraft);
  const pointLoad = firstRecord(source.pointLoads ?? source.point_loads);
  const distributedLoad = firstRecord(source.distributedLoads ?? source.distributed_loads);
  const span = normalizeNumber(source.lengthM ?? source.spanLengthM ?? source.span ?? source.length);
  const loadValue = normalizeNumber(
    source.loadKN
    ?? source.load
    ?? source.loadValue
    ?? pointLoad?.force
    ?? pointLoad?.value
    ?? pointLoad?.magnitude
    ?? distributedLoad?.force
    ?? distributedLoad?.value,
  );
  const loadPositionM = normalizeLoadPositionM(
    source.loadPositionM
    ?? source.position
    ?? pointLoad?.position
    ?? pointLoad?.positionM,
  );
  const loadType = inferLoadTypeFromPatch(source);
  const explicitType = normalizeInferredType(source.inferredType);
  const inferredType =
    (explicitType && explicitType !== 'unknown' ? explicitType : undefined)
    ?? normalizeLlmDeclaredType(engineeringDraft?.structureType)
    ?? normalizeLlmDeclaredType(source.componentType)
    ?? normalizeLlmDeclaredType(source.structureType)
    ?? normalizeLlmDeclaredType(source.structuralType)
    ?? normalizeLlmDeclaredType(source.type);

  const patch: DraftExtraction = {};
  if (cleared !== undefined) patch.clearDraftFields = cleared;
  if (inferredType) patch.inferredType = inferredType;
  if (engineeringDraft) patch.engineeringDraft = engineeringDraft;
  const draftIssues = draftIssuesFromSource(source);
  if (draftIssues?.length) patch.draftIssues = draftIssues;
  if (span !== undefined) patch.lengthM = span;
  if (loadValue !== undefined) patch.loadKN = loadValue;
  if (loadType) patch.loadType = loadType;
  const supportType = inferSupportTypeFromText(
    source.supportType
    ?? source.supportCondition
    ?? source.support_condition
    ?? source.boundaryCondition,
  );
  if (supportType) patch.supportType = supportType;
  const loadPosition = normalizeLoadPosition(source.loadPosition ?? source.load_position);
  if (loadPosition) {
    patch.loadPosition = loadPosition;
  } else if (loadType === 'point' && span !== undefined && loadPositionM !== undefined && Math.abs(loadPositionM - span / 2) < 1e-6) {
    patch.loadPosition = 'midspan';
  } else if (loadType === 'distributed') {
    patch.loadPosition = 'full-span';
  }
  if (loadPositionM !== undefined) patch.loadPositionM = loadPositionM;

  if (Object.keys(source).length > 0) {
    const skillState = genericSkillStateFromSource(source);
    const existingInvalidDraftFields = Array.isArray(skillState.invalidDraftFields)
      ? skillState.invalidDraftFields.filter((field): field is string => typeof field === 'string')
      : [];
    const issueFields = draftIssues
      ?.map((issue) => issue.field)
      .filter((field): field is string => typeof field === 'string' && field.trim().length > 0)
      ?? [];
    patch.skillState = {
      ...skillState,
      ...((existingInvalidDraftFields.length || issueFields.length)
        ? { invalidDraftFields: Array.from(new Set([...existingInvalidDraftFields, ...issueFields])) }
        : {}),
    };
  }
  return inferredType ? projectDraftPatch(patch, inferredType) : patch;
}
