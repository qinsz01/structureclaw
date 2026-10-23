import { EngineeringValidationError } from '../../engineering/validation-error.js';
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
import { legacyScalarsShadowing, normalizeFrameBoundary } from './legacy-fields.js';
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
const failClear = (path: string, reason: string): never => { throw new EngineeringValidationError(`DRAFT_CLEAR_INVALID: ${path}: ${reason} / 草稿删除操作无效，原状态未变`); };

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
  if (parsed === undefined && patch[key] != null || parsed !== undefined && parsed <= 0) {
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
    return parsed === undefined || parsed <= 0;
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
  const engineeringDraft = verifyDraftSectionEvidence(reconcileDraftMaterials(normalizeDraftWithReportedLoadIssue(normalizeFrameBoundary(rawDraft, normalizeInferredType(patch.inferredType) ?? normalizeInferredType(asRecord(rawDraft)?.structureType) ?? accepted?.inferredType), draftIssues, accepted),
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

/** Generic input remains canonical; aliases are retained as context, never projected onto a template. */
export function ingestGenericDraft(
  llmDraftPatch: Record<string, unknown> | null | undefined,
  existing?: DraftState,
  userText?: string,
): DraftExtraction {
  const source = llmDraftPatch ?? {};
  const cleared = source.clearDraftFields !== undefined ? normalizeClearDraftFields(source.clearDraftFields) : undefined;
  const accepted = clearDraftFields(existing, cleared);
  const draftIssues = draftIssuesFromSource(source);
  const engineeringDraft = normalizeEngineeringDraft(source.engineeringDraft, accepted?.engineeringDraft);
  const rawLoads = asRecord(source.engineeringDraft)?.loads;
  if (Array.isArray(rawLoads) && engineeringDraft?.loads?.length !== rawLoads.length) {
    throw new EngineeringValidationError('INVALID_GENERIC_LOADS: every declared load must have a valid kind, magnitude and unit / 每个已声明荷载都必须具有有效类型、数值和单位，不得丢弃后继续建模');
  }
  return {
    skillId: 'generic', structuralTypeKey: 'unknown',
    inferredType: normalizeLlmDeclaredType(source.inferredType ?? engineeringDraft?.structureType) ?? accepted?.inferredType ?? 'unknown',
    ...(cleared !== undefined ? { clearDraftFields: cleared } : {}),
    ...(engineeringDraft ? { engineeringDraft } : {}),
    ...(draftIssues?.length ? { draftIssues } : {}),
    skillState: { ...asRecord(source.skillState), genericDraft: structuredClone(source), ...(userText ? { userText } : {}) },
  };
}

/** No scalar, floor-load or frame-boundary synthesis on the free-form path. */
export function mergeGenericDraftState(existing: DraftState | undefined, patch: DraftExtraction): DraftState {
  existing = clearDraftFields(existing, patch.clearDraftFields);
  const engineeringDraft = cleanSectionMaterials(mergeEngineeringDraft(existing?.engineeringDraft, patch.engineeringDraft));
  const merged: DraftState = {
    inferredType: patch.inferredType ?? existing?.inferredType ?? 'unknown',
    skillId: 'generic', structuralTypeKey: 'unknown',
    engineeringDraft,
    supportLevel: patch.supportLevel === 'unsupported' ? 'unsupported' : 'supported',
    supportNote: patch.supportNote ?? existing?.supportNote,
    ...(existing?.requestScope ? { requestScope: existing.requestScope } : {}),
    updatedAt: Date.now(),
  };
  return projectDraftState(engineeringDraft, { ...merged, ...mergeDraftDiagnostics(existing, patch, merged) });
}
