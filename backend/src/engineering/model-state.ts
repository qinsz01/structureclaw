import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertInputEvidenceMatchesModel, assertResolvedInput, mergeInputEvidence, unresolvedInputEvidence } from './input-evidence.js';

export type ModelRecord = Record<string, unknown>;
export type ModelCollection = 'nodes' | 'elements' | 'materials' | 'sections' | 'stories' | 'load_cases' | 'load_combinations' | 'loads' | 'model_settings';
export interface ModelEdit {
  operation: 'add' | 'update' | 'remove';
  collection: ModelCollection;
  id: string;
  caseId?: string;
  values?: ModelRecord;
}
export interface ModelTransaction {
  id: string;
  revision: number;
  label: string;
  beforeModel: ModelRecord | null;
  afterHash: string;
  createdAt: string;
  undoOf?: string;
}
export interface ModelState {
  model?: ModelRecord | null;
  modelRevision?: number;
  modelPending?: boolean;
  modelHistory?: ModelTransaction[];
  analysisResult?: ModelRecord | null;
  codeCheckResult?: ModelRecord | null;
  report?: unknown;
  analysisRequestSequence?: number;
  analysisRequest?: AnalysisRequestBinding | null;
  inputEvidence?: ModelRecord[];
}

export const analysisRequestBindingSchema = z.object({
  modelRevision: z.number().int().nonnegative(),
  modelHash: z.string().min(1), settingsHash: z.string().min(1),
  requestSequence: z.number().int().positive(),
});
export type AnalysisRequestBinding = z.infer<typeof analysisRequestBindingSchema>;

export function isRecord(value: unknown): value is ModelRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(ordered);
    return items.length > 0 && items.every((item) => isRecord(item) && typeof item.id === 'string')
      ? items.sort((a, b) => String((a as ModelRecord).id).localeCompare(String((b as ModelRecord).id)))
      : items;
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => [key, ordered(value[key])]));
  }
  return value;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(ordered(value)) ?? 'null').digest('hex');
}

/** Display and source annotations do not change structural physics. */
export function modelHash(model: ModelRecord): string {
  const physical: ModelRecord = {};
  for (const key of [
    'schema_version', 'unit_system', 'coordinate_system', 'nodes', 'elements',
    'materials', 'sections', 'stories', 'load_cases', 'load_combinations',
    'analysis_control', 'site_seismic', 'structure_system', 'wind', 'wall_openings', 'slab_openings',
  ]) {
    if (model[key] !== undefined) physical[key] = model[key];
  }
  // Boundary readers still accept the historical load aliases.
  physical.load_cases ??= model.loadCases;
  physical.load_combinations ??= model.loadCombinations;
  if (isRecord(model.metadata)) {
    const metadata = Object.fromEntries(Object.entries(model.metadata).filter(([key]) => ![
      'title', 'name', 'description', 'source', 'inputEvidence', 'createdAt', 'updatedAt', 'physicalModel', 'inferredType',
    ].includes(key)));
    if (Object.keys(metadata).length) physical.metadata = metadata;
  }
  return contentHash(physical);
}

function entities(model: ModelRecord, collection: string): ModelRecord[] {
  const value = model[collection];
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`MODEL_INVALID_COLLECTION: ${collection}`);
  }
  return value;
}

/** Fast structural references check; Python V2 remains the semantic validator. */
export function validateModelReferences(model: ModelRecord): void {
  const index = new Map<string, Set<string>>();
  for (const collection of ['nodes', 'elements', 'materials', 'sections', 'stories', 'load_cases', 'load_combinations']) {
    if (model[collection] === undefined && !['nodes', 'elements', 'materials', 'sections'].includes(collection)) continue;
    const ids = new Set<string>();
    for (const item of entities(model, collection)) {
      if (typeof item.id !== 'string' || !item.id || ids.has(item.id)) {
        throw new Error(`MODEL_DUPLICATE_OR_MISSING_ID: ${collection}:${String(item.id)}`);
      }
      ids.add(item.id);
    }
    index.set(collection, ids);
  }
  const requireId = (collection: string, id: unknown, owner: unknown) => {
    if (typeof id !== 'string' || !index.get(collection)?.has(id)) {
      throw new Error(`MODEL_UNKNOWN_REFERENCE: ${String(owner)} -> ${collection}:${String(id)}`);
    }
  };
  for (const element of entities(model, 'elements')) {
    if (!Array.isArray(element.nodes) || element.nodes.length < 2) throw new Error(`MODEL_INVALID_CONNECTIVITY: ${element.id}`);
    for (const node of element.nodes) requireId('nodes', node, element.id);
    requireId('materials', element.material, element.id);
    requireId('sections', element.section, element.id);
  }
  for (const loadCase of (model.load_cases ?? []) as ModelRecord[]) {
    const loadIds = new Set<string>();
    for (const load of entities(loadCase, 'loads')) {
      if (typeof load.id === 'string') {
        if (loadIds.has(load.id)) throw new Error(`MODEL_DUPLICATE_LOAD_ID: ${loadCase.id}:${load.id}`);
        loadIds.add(load.id);
      }
      const node = load.node ?? load.nodeId ?? load.node_id;
      const element = load.element ?? load.elementId ?? load.element_id;
      if (node !== undefined) requireId('nodes', node, loadCase.id);
      if (element !== undefined) requireId('elements', element, loadCase.id);
    }
  }
  for (const combination of (model.load_combinations ?? []) as ModelRecord[]) {
    for (const id of Object.keys(isRecord(combination.factors) ? combination.factors : {})) requireId('load_cases', id, combination.id);
  }
}

function mergeFields(target: ModelRecord, values: ModelRecord): ModelRecord {
  const result = { ...target };
  for (const [key, value] of Object.entries(values)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('MODEL_INVALID_FIELD');
    result[key] = isRecord(value) && isRecord(result[key])
      ? mergeFields(result[key] as ModelRecord, value)
      : structuredClone(value);
  }
  return result;
}

export function applyModelEdits(model: ModelRecord, edits: ModelEdit[]): ModelRecord {
  if (edits.length === 0) throw new Error('MODEL_EMPTY_EDIT');
  const updated = structuredClone(model);
  for (const edit of edits) {
    if (edit.collection === 'model_settings') {
      if (!['analysis_control', 'site_seismic', 'structure_system', 'wind'].includes(edit.id)) throw new Error('MODEL_SETTINGS_TARGET_INVALID');
      if (edit.operation === 'remove') delete updated[edit.id];
      else {
        if (!edit.values) throw new Error('MODEL_EDIT_VALUES_REQUIRED');
        if (edit.operation === 'add' && updated[edit.id] !== undefined) throw new Error('MODEL_OBJECT_EXISTS');
        updated[edit.id] = mergeFields(isRecord(updated[edit.id]) ? updated[edit.id] as ModelRecord : {}, edit.values);
      }
      continue;
    }
    let owner = updated;
    if (edit.collection === 'loads') {
      const loadCase = entities(updated, 'load_cases').find((item) => item.id === edit.caseId);
      if (!loadCase) throw new Error(`MODEL_LOAD_CASE_NOT_FOUND: ${edit.caseId}`);
      owner = loadCase;
    }
    if (edit.operation === 'add' && owner[edit.collection] === undefined) owner[edit.collection] = [];
    const items = entities(owner, edit.collection);
    const at = items.findIndex((item) => item.id === edit.id);
    if (edit.operation === 'add') {
      if (at !== -1) throw new Error(`MODEL_OBJECT_EXISTS: ${edit.collection}:${edit.id}`);
      if (!edit.values) throw new Error('MODEL_EDIT_VALUES_REQUIRED');
      if (edit.values.id !== undefined && edit.values.id !== edit.id) throw new Error('MODEL_ID_CHANGE_FORBIDDEN');
      items.push(mergeFields({ id: edit.id }, edit.values));
    } else {
      if (at === -1) throw new Error(`MODEL_OBJECT_NOT_FOUND: ${edit.collection}:${edit.id}`);
      if (edit.operation === 'remove') items.splice(at, 1);
      else {
        if (!edit.values) throw new Error('MODEL_EDIT_VALUES_REQUIRED');
        if (edit.values.id !== undefined && edit.values.id !== edit.id) throw new Error('MODEL_ID_CHANGE_FORBIDDEN');
        items[at] = mergeFields(items[at]!, edit.values);
      }
    }
  }
  validateModelReferences(updated);
  return updated;
}

export function commitModel(state: ModelState | undefined, model: ModelRecord, label: string, undoOf?: string) {
  const previous = state?.model ?? null;
  const changed = !previous || modelHash(previous) !== modelHash(model);
  const revision = (state?.modelRevision ?? 0) + (changed ? 1 : 0);
  const history = [...(state?.modelHistory ?? [])];
  if (changed) history.push({
    id: randomUUID(), revision, label, beforeModel: previous ? structuredClone(previous) : null,
    afterHash: modelHash(model), createdAt: new Date().toISOString(), ...(undoOf ? { undoOf } : {}),
  });
  return {
    model: structuredClone(model), modelRevision: revision, modelPending: false, modelHistory: history,
    ...(changed ? invalidateAnalysis(state) : {}),
  };
}

export function invalidateAnalysis(state: ModelState | undefined) {
  const previous = state?.analysisResult;
  const id = previous ? String(previous.runId ?? `legacy-${randomUUID()}`) : undefined;
  return {
    ...(id && previous ? { analysisRuns: { [id]: previous } } : {}),
    analysisResult: null, codeCheckResult: null, report: null, analysisRequest: null,
  };
}

/** Reserve before awaiting the solver; a completion may publish only this request. */
export function beginAnalysisRequest(state: ModelState, settingsHash: string) {
  if (!state.model || state.modelPending) throw new Error('MODEL_REBUILD_REQUIRED');
  assertResolvedInput(state.inputEvidence);
  assertInputEvidenceMatchesModel(state.model, state.inputEvidence);
  assertInputEvidenceMatchesModel(state.model);
  const requestSequence = (state.analysisRequestSequence ?? 0) + 1;
  const analysisRequest: AnalysisRequestBinding = {
    modelRevision: state.modelRevision ?? 0, modelHash: modelHash(state.model), settingsHash, requestSequence,
  };
  return { ...invalidateAnalysis(state), analysisRequestSequence: requestSequence, analysisRequest };
}

function matchesRequest(a: AnalysisRequestBinding, b: ModelRecord): boolean {
  return a.modelRevision === b.modelRevision && a.modelHash === b.modelHash
    && a.settingsHash === b.settingsHash && a.requestSequence === b.requestSequence;
}

export function undoModel(state: ModelState, transactionId?: string) {
  const history = state.modelHistory ?? [];
  const transaction = transactionId ? history.find((item) => item.id === transactionId) : history.at(-1);
  if (!transaction?.beforeModel) throw new Error('MODEL_UNDO_UNAVAILABLE');
  if (!state.model || modelHash(state.model) !== transaction.afterHash) throw new Error('MODEL_UNDO_CONFLICT');
  return commitModel(state, structuredClone(transaction.beforeModel), `Undo: ${transaction.label}`, transaction.id);
}

export function currentAnalysisError(state: ModelState | undefined): string | undefined {
  if (!state?.model || !state.analysisResult) return 'ANALYSIS_REQUIRED';
  if (unresolvedInputEvidence(state.inputEvidence).length
    || unresolvedInputEvidence(isRecord(state.model.metadata) ? state.model.metadata.inputEvidence : undefined).length)
    return 'INPUT_EVIDENCE_UNRESOLVED';
  if (state.modelPending) return 'MODEL_REBUILD_REQUIRED';
  try {
    assertInputEvidenceMatchesModel(state.model, state.inputEvidence);
    assertInputEvidenceMatchesModel(state.model);
  } catch { return 'INPUT_EVIDENCE_NOT_APPLIED'; }
  const meta = isRecord(state.analysisResult.meta) ? state.analysisResult.meta : {};
  if (meta.modelHash !== modelHash(state.model)) return 'ANALYSIS_STALE_OR_LEGACY';
  if (!state.analysisRequest || !matchesRequest(state.analysisRequest, meta)
    || state.analysisRequest.modelRevision !== (state.modelRevision ?? 0)) return 'ANALYSIS_STALE_OR_LEGACY';
  if (state.analysisResult.success === false) return 'ANALYSIS_FAILED';
  return undefined;
}

/** Newly read engineering evidence must be applied before old artifacts become usable. */
export function applyInputEvidence(state: ModelState, patch: ModelRecord[]) {
  const inputEvidence = mergeInputEvidence(state.inputEvidence, patch) ?? [];
  const previous = new Set((state.inputEvidence ?? []).map(contentHash));
  const changed = inputEvidence.some(item => item.required !== false && !previous.has(contentHash(item)));
  return { inputEvidence, ...(changed ? { ...invalidateAnalysis(state), modelPending: Boolean(state.model) } : {}) };
}

export function publishAnalysis(state: ModelState, request: AnalysisRequestBinding, result: ModelRecord) {
  const runId = String(result.runId ?? (isRecord(result.meta) ? result.meta.traceId : undefined));
  if (!runId || runId === 'undefined') throw new Error('RUN_ID_REQUIRED');
  const meta = isRecord(result.meta) ? result.meta : {};
  const current = Boolean(state.model && !state.modelPending && modelHash(state.model) === request.modelHash
    && (state.modelRevision ?? 0) === request.modelRevision && state.analysisRequest
    && matchesRequest(request, { ...state.analysisRequest }) && matchesRequest(request, meta));
  return {
    analysisRuns: { [runId]: result },
    ...(current ? { analysisResult: result, analysisRequest: request,
      analysisRequestSequence: request.requestSequence, codeCheckResult: null, report: null } : {}),
  };
}
