import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { runtimeBaseDir } from '../config/index.js';
import { analysisRequestBindingSchema, contentHash, isRecord, modelHash, type ModelRecord } from './model-state.js';
import { enrichResultData } from './result-data.js';
import { assertInputEvidenceMatchesModel, assertResolvedInput } from './input-evidence.js';
import { writeAtomicFile } from './atomic-json.js';
import { requestScopeInputSchema } from './request-scope.js';
import { sectionAssumptions } from './section-assumptions.js';

const compress = promisify(gzip), decompress = promisify(gunzip);

export interface ResultSelection { key: string; kind: 'case' | 'combination' | 'analysis'; id: string }
const SELECTION_FIELDS = ['loadCaseIds', 'load_case_ids', 'loadCombinationIds', 'combinationIds',
  'loadCombinationId', 'load_combination_id', 'combinationId', 'loadCases', 'load_cases', 'batchCases', 'combinations'];

function ids(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim())) throw new Error('INVALID_RESULT_SELECTION');
  return [...new Set(value as string[])];
}

/** Normalize legacy selector names once; never let a child solver override its result label. */
function normalizeAnalysisParameters(parameters: ModelRecord): ModelRecord {
  const normalized = { ...parameters };
  for (const key of SELECTION_FIELDS) delete normalized[key];
  for (const key of ['loadCases', 'load_cases', 'batchCases', 'combinations']) {
    if (parameters[key] !== undefined && (!Array.isArray(parameters[key]) || (parameters[key] as unknown[]).length)) {
      throw new Error(`MODEL_LOAD_OVERRIDES_UNSUPPORTED: ${key}; define loads and combinations in the physical model`);
    }
  }
  const equivalent = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
  const single = (key: string): string[] | undefined => {
    if (parameters[key] === undefined) return undefined;
    if (typeof parameters[key] !== 'string' || !(parameters[key] as string).trim()) throw new Error('INVALID_RESULT_SELECTION');
    return [parameters[key] as string];
  };
  const cases = parameters.loadCaseIds === undefined ? undefined : ids(parameters.loadCaseIds);
  const oldCases = parameters.load_case_ids === undefined ? undefined : ids(parameters.load_case_ids);
  if (cases && oldCases && !equivalent(cases, oldCases)) throw new Error('CONFLICTING_RESULT_SELECTION: loadCaseIds/load_case_ids');
  if (cases !== undefined || oldCases !== undefined) normalized.loadCaseIds = cases ?? oldCases;

  const one = single('loadCombinationId');
  let combinations = parameters.loadCombinationIds === undefined && one === undefined ? undefined
    : [...new Set([...ids(parameters.loadCombinationIds), ...(one ?? [])])];
  for (const key of ['combinationIds', 'load_combination_id', 'combinationId']) {
    const alias = key === 'combinationIds' ? parameters[key] === undefined ? undefined : ids(parameters[key]) : single(key);
    if (alias === undefined) continue;
    if (combinations && !equivalent(combinations, alias)) throw new Error(`CONFLICTING_RESULT_SELECTION: ${key}`);
    combinations ??= alias;
  }
  if (combinations !== undefined) normalized.loadCombinationIds = combinations;
  if ((cases !== undefined || oldCases !== undefined || combinations !== undefined)
    && !((normalized.loadCaseIds as string[] | undefined)?.length || combinations?.length)) throw new Error('INVALID_RESULT_SELECTION: empty selection');
  return normalized;
}

export function analysisSettingsHash(type: unknown, engineId: unknown, parameters: ModelRecord): string {
  return contentHash({ type, engineId, parameters: normalizeAnalysisParameters(parameters) });
}

export function analysisRequestHash(payload: ModelRecord): string {
  return contentHash({ ...payload, requestId: undefined,
    parameters: normalizeAnalysisParameters(isRecord(payload.parameters) ? payload.parameters : {}) });
}

export function analysisSelections(model: ModelRecord, rawParameters: ModelRecord, type: unknown): ResultSelection[] {
  const parameters = normalizeAnalysisParameters(rawParameters);
  const cases = (model.load_cases ?? model.loadCases ?? []) as ModelRecord[];
  const combinations = (model.load_combinations ?? model.loadCombinations ?? []) as ModelRecord[];
  const requestedCases = ids(parameters.loadCaseIds);
  const requestedCombinations = ids(parameters.loadCombinationIds);
  const selected: ResultSelection[] = [];
  const add = (kind: 'case' | 'combination', requested: string[], available: ModelRecord[]) => {
    for (const id of requested) {
      if (!available.some((item) => item.id === id)) throw new Error(`LOAD_${kind.toUpperCase()}_NOT_FOUND: ${id}`);
      selected.push({ key: `${kind}:${id}`, kind, id });
    }
  };
  if (type === 'static' && parameters.loadCaseIds === undefined && parameters.loadCombinationIds === undefined) {
    add('case', cases.map((item) => String(item.id)), cases);
    add('combination', combinations.map((item) => String(item.id)), combinations);
  } else {
    add('case', requestedCases, cases);
    add('combination', requestedCombinations, combinations);
  }
  if (!selected.length) selected.push({ key: 'analysis:default', kind: 'analysis', id: 'default' });
  return selected;
}

export function executionStatus(result: ModelRecord): string {
  if (result.success !== false) return 'completed';
  const code = String(result.error_code ?? result.errorCode ?? '');
  if (/ENGINE_UNAVAILABLE|SDK_UNAVAILABLE|SOLVER_UNAVAILABLE|NOT_INSTALLED|LICENSE|ENVIRONMENT/.test(code)) return 'environment_unavailable';
  if (/UNSUPPORTED|NOT_SUPPORTED|UNVERIFIED/.test(code)) return 'unsupported';
  if (/MISSING|REQUIRED|INVALID_MODEL|INPUT_INVALID|INSUFFICIENT/.test(code)) return 'insufficient_data';
  return 'failed';
}

/** One immutable record per request. Each selected load case retains its own signed result. */
export async function executeAnalysisRun(
  payload: ModelRecord,
  invoke: (request: ModelRecord) => Promise<ModelRecord>,
  persist: (id: string, record: ModelRecord) => Promise<void> = saveAnalysisRun,
  runId: string = randomUUID(),
): Promise<ModelRecord> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) throw new Error('RUN_ID_INVALID');
  if (!isRecord(payload.model)) throw new Error('MODEL_REQUIRED');
  const model = structuredClone(payload.model);
  const requestScope = payload.requestScope === undefined ? undefined : requestScopeInputSchema.parse(payload.requestScope);
  assertResolvedInput(isRecord(model.metadata) ? model.metadata.inputEvidence : undefined);
  assertInputEvidenceMatchesModel(model);
  const parameters = normalizeAnalysisParameters(isRecord(payload.parameters) ? structuredClone(payload.parameters) : {});
  if ('_internalResultSelections' in parameters) throw new Error('RESERVED_ANALYSIS_PARAMETER');
  const selections = analysisSelections(model, parameters, payload.type);
  const startedAt = new Date().toISOString();
  const fingerprint = modelHash(model);
  const settingsHash = analysisSettingsHash(payload.type, payload.engineId, parameters);
  const binding: ModelRecord = payload.requestBinding === undefined ? {} : analysisRequestBindingSchema.parse(payload.requestBinding);
  if (Object.keys(binding).length && (binding.modelHash !== fingerprint || binding.settingsHash !== settingsHash)) {
    throw new Error('ANALYSIS_REQUEST_BINDING_MISMATCH');
  }
  const results: ModelRecord = {};
  const commercialBatch = ['builtin-pkpm', 'builtin-yjk'].includes(String(payload.engineId))
    && selections.every(selection => selection.kind !== 'analysis');
  let nativeResponse: ModelRecord | undefined;
  for (const selection of selections) {
    const effective = { ...parameters };
    for (const key of SELECTION_FIELDS) delete effective[key];
    if (selection.kind === 'case') effective.loadCaseIds = [selection.id];
    if (selection.kind === 'combination') effective.loadCombinationId = selection.id;
    let result: ModelRecord;
    try {
      if (commercialBatch) {
        // Commercial backends solve all native cases in one owned job. A failed
        // projection must not silently launch another analysis/design job.
        if (!nativeResponse) {
          try {
            const nativeParameters = { ...parameters };
            for (const key of SELECTION_FIELDS) delete nativeParameters[key];
            // The one native job must include every case needed by all requested views.
            // Applying the first view here discards later source cases in PKPM extraction.
            const sourceCases = selections.flatMap(item => item.kind === 'case' ? [item.id]
              : Object.keys((model.load_combinations as ModelRecord[]).find(row => row.id === item.id)!.factors as ModelRecord));
            nativeParameters.loadCaseIds = [...new Set(sourceCases)];
            nativeResponse = await invoke({ ...payload, model,
              parameters: { ...nativeParameters, _internalResultSelections: selections } });
          } catch (error) {
            nativeResponse = { success: false, error_code: isRecord(error) && typeof error.errorCode === 'string' ? error.errorCode : 'ANALYSIS_EXECUTION_FAILED',
              message: error instanceof Error ? error.message : String(error), data: {} };
          }
        }
        const data = isRecord(nativeResponse.data) ? nativeResponse.data : {};
        const batch = isRecord(data.nativeResultSet) ? data.nativeResultSet : {};
        const entry = isRecord(batch.results) ? batch.results[selection.key] : undefined;
        if (nativeResponse.success === false) result = structuredClone(nativeResponse);
        else if (batch.schema !== 'sclaw-native-result-set/v1' || !isRecord(entry) || typeof entry.success !== 'boolean') {
          result = { success: false, error_code: 'NATIVE_RESULT_SET_INCOMPLETE', message: `Missing native result: ${selection.key}`, data: {} };
        } else {
          // The selected entry replaces the batch data. Do not copy every case
          // and raw native payload only to immediately discard that copy.
          const { data: _batchData, ...envelope } = nativeResponse;
          result = { ...structuredClone(envelope), ...structuredClone(entry), meta: nativeResponse.meta };
          const selectedNative = isRecord(result.data) && isRecord(result.data.selectedResult) ? result.data.selectedResult : {};
          if (entry.success && (selectedNative.id !== selection.id || selectedNative.kind !== selection.kind)) {
            throw new Error('NATIVE_RESULT_SELECTION_MISMATCH');
          }
          if (isRecord(result.data) && selection === selections[0]) {
            result.data.caseResults = data.caseResults;
            result.data.envelopeTables = data.envelopeTables;
          }
        }
      } else result = await invoke({ ...payload, model, parameters: effective });
      const suppliedMeta = isRecord(result.meta) ? result.meta : {};
      const expected: ModelRecord = { ...binding, modelHash: fingerprint, settingsHash };
      for (const key of ['modelHash', 'settingsHash', 'modelRevision', 'requestSequence']) {
        if (suppliedMeta[key] !== undefined && expected[key] !== undefined && suppliedMeta[key] !== expected[key]) {
          throw Object.assign(new Error(`ANALYSIS_RESULT_BINDING_MISMATCH: ${key}`), { errorCode: 'ANALYSIS_RESULT_BINDING_MISMATCH' });
        }
      }
    } catch (error) {
      result = { success: false, error_code: isRecord(error) && typeof error.errorCode === 'string' ? error.errorCode : 'ANALYSIS_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error), data: {} };
    }
    result.meta = { ...(isRecord(result.meta) ? result.meta : {}), ...binding, runId, modelHash: fingerprint, settingsHash, effectiveParameters: effective, requestParameters: parameters,
      ...(requestScope ? { requestScope } : {}) };
    const data = enrichResultData(model, result, selection as unknown as ModelRecord);
    const sectionNotes = sectionAssumptions(model);
    if (sectionNotes.length) data.sectionAssumptions = sectionNotes;
    results[selection.key] = {
      ...result, data, selection, executionStatus: executionStatus(result),
      capabilityStatus: result.success === false ? 'unavailable'
        : data.status === 'partial' || data.status === 'preliminary' || data.isPreliminary === true
          || Array.isArray(data.missingCapabilities) && data.missingCapabilities.length > 0
          || Array.isArray(data.missingInputs) && data.missingInputs.length > 0 ? 'partial' : 'complete',
      meta: { ...(isRecord(result.meta) ? result.meta : {}), runId, modelHash: fingerprint, settingsHash, effectiveParameters: effective, requestParameters: parameters },
    };
  }
  const selectedResultKey = selections[0]!.key;
  const selected = results[selectedResultKey] as ModelRecord;
  const success = Object.values(results).every((item) => isRecord(item) && item.success !== false);
  const engineUnavailable = Object.values(results).every(item => isRecord(item) && item.error_code === 'ENGINE_UNAVAILABLE');
  const capabilityStatus = Object.values(results).every((item) => isRecord(item) && item.capabilityStatus === 'complete') ? 'complete' : 'partial';
  const record = {
    runId, requestId: payload.requestId, requestHash: analysisRequestHash(payload),
    startedAt, completedAt: new Date().toISOString(), modelHash: fingerprint, settingsHash,
    request: { ...payload, model, parameters }, selections, results, selectedResultKey,
    executionStatus: success ? 'completed' : 'incomplete', capabilityStatus, success,
  };
  await persist(runId, record);
  return {
    ...selected, success, runId, requestId: record.requestId, requestHash: record.requestHash,
    modelSnapshot: model, results, selectedResultKey, executionStatus: record.executionStatus, capabilityStatus,
    ...(!success ? engineUnavailable ? { error_code: 'ENGINE_UNAVAILABLE', message: selected.message,
      messageZh: '请求的求解器当前不可用，请检查安装与配置。' }
      : { error_code: 'RESULT_SET_INCOMPLETE', message: 'One or more requested results failed; inspect results by key.' } : {}),
    meta: { ...(isRecord(selected.meta) ? selected.meta : {}), startedAt, completedAt: record.completedAt, resultCount: selections.length },
  };
}

export async function saveAnalysisRun(id: string, record: ModelRecord, baseDirectory = path.join(runtimeBaseDir, 'runs')): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('RUN_ID_INVALID');
  const bytes = await compress(JSON.stringify(record));
  await mkdir(baseDirectory, { recursive: true });
  const directory = path.join(baseDirectory, id);
  // Claim a new immutable run directory. An old or interrupted archive cannot
  // be replaced, including one written in the historical uncompressed format.
  await mkdir(directory);
  writeAtomicFile(path.join(directory, 'run.json.gz'), bytes);
}

/** UUID lookup only; the archived request and result fingerprints must still agree. */
export async function loadAnalysisRun(id: string, directory = path.join(runtimeBaseDir, 'runs')): Promise<ModelRecord> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('RUN_ID_INVALID');
  let record: ModelRecord;
  try {
    const folder = path.join(directory, id), names = await readdir(folder);
    const compressed = names.includes('run.json.gz'), plain = names.includes('run.json');
    if (compressed && plain) throw new Error('RUN_ARCHIVE_AMBIGUOUS');
    if (!compressed && !plain) throw new Error('RUN_NOT_FOUND');
    const bytes = compressed ? await decompress(await readFile(path.join(folder, 'run.json.gz')))
      : await readFile(path.join(folder, 'run.json'));
    record = JSON.parse(bytes.toString('utf8')) as ModelRecord;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') throw new Error('RUN_NOT_FOUND', { cause: error });
    throw error;
  }
  const request = isRecord(record.request) ? record.request : {};
  const parameters = isRecord(request.parameters) ? request.parameters : {};
  const model = request.model;
  const requestHash = analysisRequestHash(request);
  const binding = request.requestBinding === undefined ? {} : analysisRequestBindingSchema.parse(request.requestBinding);
  if (record.runId !== id || !isRecord(model) || record.modelHash !== modelHash(model)
    || record.settingsHash !== analysisSettingsHash(request.type, request.engineId, parameters)
    || !isRecord(record.results) || typeof record.selectedResultKey !== 'string'
    || (record.requestHash !== undefined && record.requestHash !== requestHash)
    || (record.requestId !== undefined && record.requestId !== request.requestId)) throw new Error('RUN_ARCHIVE_INVALID');
  for (const result of Object.values(record.results)) {
    const meta = isRecord(result) && isRecord(result.meta) ? result.meta : {};
    if (meta.runId !== id || meta.modelHash !== record.modelHash || meta.settingsHash !== record.settingsHash
      || Object.entries(binding).some(([key, value]) => meta[key] !== value)) throw new Error('RUN_ARCHIVE_INVALID');
  }
  const selected = record.results[record.selectedResultKey];
  if (!isRecord(selected)) throw new Error('RUN_ARCHIVE_INVALID');
  return { ...selected, runId: id, requestId: request.requestId, requestHash, modelSnapshot: model, results: record.results,
    selectedResultKey: record.selectedResultKey, success: record.success,
    executionStatus: record.executionStatus, capabilityStatus: record.capabilityStatus,
    meta: { ...(isRecord(selected.meta) ? selected.meta : {}), startedAt: record.startedAt,
      completedAt: record.completedAt, resultCount: Object.keys(record.results).length } };
}
