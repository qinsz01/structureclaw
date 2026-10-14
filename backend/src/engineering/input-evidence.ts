import { contentHash, isRecord, type ModelRecord } from './model-state.js';

function evidenceField(item: ModelRecord): string {
  return typeof item.field === 'string' ? item.field : String(item.id ?? 'input');
}

function observation(item: ModelRecord): ModelRecord {
  return item.normalizedValue !== undefined
    ? { value: item.normalizedValue, unit: item.normalizedUnit }
    : { value: item.value, unit: item.unit };
}

function isResolution(item: ModelRecord): boolean {
  return item.status === 'resolved' && isRecord(item.resolution)
    && typeof item.resolution.reason === 'string' && !!item.resolution.reason.trim()
    && (item.resolution.value !== undefined || item.resolution.selectedSource !== undefined);
}

export function evidenceSourceFile(item: ModelRecord): string | undefined {
  const source = isRecord(item.source) ? item.source : {};
  return typeof source.file === 'string' ? source.file : typeof source.filePath === 'string' ? source.filePath : undefined;
}

/** An exclusion covers exact observations, never future reads of the same file. */
export function activeInputEvidence(value: unknown): ModelRecord[] {
  if (!Array.isArray(value)) return [];
  const records = value.filter(isRecord);
  const excluded = new Set<string>();
  for (const item of records) {
    if (item.status !== 'excluded') continue;
    if (!isRecord(item.resolution) || typeof item.resolution.reason !== 'string' || !item.resolution.reason.trim()
      || typeof item.resolution.sourceFile !== 'string' || !Array.isArray(item.resolution.evidenceHashes)
      || !item.resolution.evidenceHashes.length) throw new Error('INPUT_EXCLUSION_REASON_AND_SOURCE_REQUIRED');
    const resolution = item.resolution;
    for (const hash of resolution.evidenceHashes as unknown[]) {
      if (typeof hash !== 'string' || !records.some(record => record.status !== 'excluded'
        && evidenceSourceFile(record) === resolution.sourceFile && contentHash(record) === hash)) {
        throw new Error('INPUT_EXCLUSION_SOURCE_MISMATCH');
      }
      excluded.add(hash);
    }
  }
  return records.filter(item => item.status !== 'excluded' && !excluded.has(contentHash(item)));
}

/** Evidence is retained, including superseded/conflicting observations. Resolution is explicit. */
export function unresolvedInputEvidence(value: unknown): Array<{ field: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  const records = activeInputEvidence(value);
  const fields = new Map<string, ModelRecord[]>();
  for (const item of records) {
    if (item.required === false) continue;
    const field = evidenceField(item);
    fields.set(field, [...(fields.get(field) ?? []), item]);
  }
  const issues: Array<{ field: string; reason: string }> = [];
  for (const [field, items] of fields) {
    const preceding: ModelRecord[] = [];
    let reviewed = new Set<string>();
    let selectedValue: ModelRecord | undefined;
    let invalidResolution = false;
    for (const item of items) {
      if (item.status !== 'resolved') { preceding.push(item); continue; }
      if (!isResolution(item)) { invalidResolution = true; continue; }
      const resolution = item.resolution as ModelRecord;
      // Legacy append-only records cover preceding evidence only. New records persist
      // the hashes at merge time, so later edits under the same ID cannot be waived.
      const hashes = resolution.evidenceHashes ?? preceding.map((record) => contentHash(record));
      if (!Array.isArray(hashes) || hashes.some((hash) => typeof hash !== 'string')) { invalidResolution = true; continue; }
      const covered = new Set(hashes as string[]);
      const selected = resolution.selectedSource === undefined ? undefined : preceding.find((record) => covered.has(contentHash(record))
        && (record.id === resolution.selectedSource
          || record.source !== undefined && contentHash(record.source) === contentHash(resolution.selectedSource)));
      if (resolution.selectedSource !== undefined && !selected) { invalidResolution = true; continue; }
      const matching = preceding.find((record) => covered.has(contentHash(record))
        && contentHash(observation(record).value) === contentHash(resolution.value));
      reviewed = covered;
      selectedValue = resolution.value !== undefined
        ? { value: resolution.value, unit: resolution.unit ?? (matching ? observation(matching).unit : undefined) }
        : selected ? observation(selected) : undefined;
      invalidResolution = false;
    }
    if (invalidResolution) { issues.push({ field, reason: 'resolution must identify reviewed evidence and a valid source or value' }); continue; }
    const active = preceding.filter((item) => !reviewed.has(contentHash(item)));
    const pending = active.find((item) => ['conflict', 'ambiguous', 'missing', 'unread', 'failed', 'truncated'].includes(String(item.status)));
    if (pending) { issues.push({ field, reason: String(pending.reason ?? pending.status) }); continue; }
    const observations = new Set(active.filter((item) => item.value !== undefined || item.normalizedValue !== undefined)
      .map((item) => contentHash(observation(item))));
    if (selectedValue?.value !== undefined) observations.add(contentHash(selectedValue));
    if (observations.size > 1) issues.push({ field, reason: 'conflicting observations require an explicit resolution' });
  }
  return issues;
}

export function assertResolvedInput(value: unknown): void {
  const issues = unresolvedInputEvidence(value);
  if (issues.length) throw new Error(`INPUT_EVIDENCE_UNRESOLVED: ${issues.map((item) => `${item.field}: ${item.reason}`).join('; ')} / 必需输入仍有冲突或未读取内容，请保留证据并明确解决。`);
}

/** Binds an attachment's analysis-only use to the exact record/settings, not a model value. */
export function analysisInputBinding(record: ModelRecord): ModelRecord {
  if (typeof record.id !== 'string' || !isRecord(record.fileReference)
    || !['sha256', 'parsedSha256', 'path', 'parsedPath'].every(key => typeof (record.fileReference as ModelRecord)[key] === 'string')) {
    throw new Error('ANALYSIS_INPUT_COMPLETE_SOURCE_REQUIRED');
  }
  const keys = ['id', 'fileReference', 'sheetName', 'unit', 'direction', 'component', 'axis', 'seismicDirection',
    'dt', 'timeStep', 'time_step', 'timeUnit', 'timeColumn', 'accelerationColumn', 'accelColumn', 'valueColumn'];
  return { kind: 'ground-motion', recordId: record.id, parameters: Object.fromEntries(keys
    .filter(key => record[key] !== undefined).map(key => [key, structuredClone(record[key])])) };
}

export function assertAnalysisInputEvidenceMatchesRequest(evidence: unknown, workflow: unknown): void {
  const set = isRecord(workflow) && isRecord(workflow.groundMotionSet) ? workflow.groundMotionSet : {};
  const records = Array.isArray(set.records) ? set.records.filter(isRecord) : [];
  const latest = new Map<string, ModelRecord>();
  for (const item of activeInputEvidence(evidence)) if (isResolution(item)) latest.set(evidenceField(item), item);
  for (const item of latest.values()) {
    const resolution = isRecord(item.resolution) ? item.resolution : {};
    if (!isRecord(resolution.analysisInput)) continue;
    const binding = resolution.analysisInput;
    const matches = records.filter(record => record.id === binding.recordId);
    if (matches.length !== 1 || contentHash(analysisInputBinding(matches[0]!)) !== contentHash(binding)) {
      throw new Error(`ANALYSIS_INPUT_BINDING_CHANGED: ${String(binding.recordId)} / 分析输入文件或参数已改变，须重新复核`);
    }
  }
}

const modelCollections = new Set(['nodes', 'elements', 'materials', 'sections', 'stories', 'load_cases', 'load_combinations']);
const modelSingletons = new Set(['analysis_control', 'site_seismic', 'structure_system', 'wind', 'coordinate_system']);
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);

/** Arrays are addressed by stable IDs, never their current array index. */
function readModelField(model: ModelRecord, field: string): { value: unknown; route: string[] } {
  const root = field.slice(0, field.indexOf('.'));
  if (!modelCollections.has(root) && !modelSingletons.has(root)) throw new Error(`INPUT_EVIDENCE_MODEL_FIELD_REQUIRED: ${field}`);
  function read(value: unknown, remaining: string, route: string[]): Array<{ value: unknown; route: string[] }> {
    if (!remaining) return [{ value, route }];
    if (Array.isArray(value)) {
      return value.filter(isRecord).flatMap(item => typeof item.id === 'string' && remaining.startsWith(`${item.id}.`)
        ? read(item, remaining.slice(item.id.length + 1), route) : []);
    }
    if (!isRecord(value)) return [];
    const [key, ...rest] = remaining.split('.');
    if (!key || unsafeKeys.has(key) || !Object.hasOwn(value, key)) return [];
    return read(value[key], rest.join('.'), [...route, key]);
  }
  const matches = read(model[root], field.slice(root.length + 1), [root]);
  if (matches.length !== 1 || matches[0]!.value === undefined) throw new Error(`INPUT_EVIDENCE_MODEL_FIELD_NOT_FOUND_OR_AMBIGUOUS: ${field}`);
  return matches[0]!;
}

/** V2 unit declarations; unknown numeric fields require an explicit implementation. */
function modelFieldUnit(route: string[]): string | undefined {
  const path = route.join('.');
  if (/^nodes\.[xyz]$|^elements\.offsets\.[ij]_[xyz]$|^stories\.(height|elevation)$|^load_cases\.loads\.(position|start|end)$/.test(path)) return 'm';
  if (/^nodes\.mass$/.test(path)) return 'tonne';
  if (/^materials\.(E|G|fy)$|^materials\.design\.(f|fv|fc|ft|ftk|Ec|Es|fy|fyv|fy_compression)$/.test(path)) return 'MPa';
  if (path === 'materials.rho') return 'kg/m3';
  if (/^materials\.(nu|design\.(ecu|alpha1|beta1))$/.test(path)) return '1';
  if (/^sections\.shape\.(H|B|T|d|a|a2|t|tw|tf|tf2|B2|r|r1|r2|b|h)$/.test(path)) return 'mm';
  if (/^sections\.properties\.(A|Asy|Asz)$/.test(path) || path === 'stories.load_area_m2') return 'm2';
  if (/^sections\.properties\.(I|Iy|Iz|Iyy|Izz|J)$/.test(path)) return 'm4';
  if (/^sections\.properties\.(W|Wy|Wz|Wyy|Wzz)$/.test(path)) return 'm3';
  if (/^elements\.design\.(l0|h0|crackWidthLimit)$/.test(path)) return 'mm';
  if (/^elements\.design\.(phi|phi_b|phi_axial|beta1|btLimit|lambdaLimit|deflectionLimitN|axialRatioLimit)$/.test(path)) return '1';
  if (path === 'elements.rotation_angle') return 'deg';
  if (/^load_cases\.loads\.f[xyz]$/.test(path)) return 'kN';
  if (/^load_cases\.loads\.m[xyz]$/.test(path)) return 'kN.m';
  if (/^load_cases\.loads\.w[xyz]$/.test(path)) return 'kN/m';
  if (/^stories\.(dead_load|live_load)$/.test(path) || path === 'wind.basic_pressure') return 'kN/m2';
  if (path === 'site_seismic.characteristic_period') return 's';
  if (/^site_seismic\.(intensity|max_influence_coefficient|damping_ratio)$|^wind\.(shape_factor|height_variation_factor)$/.test(path)) return '1';
  return undefined;
}

const inputUnits: Record<string, [dimension: string, scale: number]> = {
  '1': ['ratio', 1], '%': ['ratio', .01],
  m: ['length', 1], cm: ['length', .01], mm: ['length', .001],
  m2: ['area', 1], cm2: ['area', 1e-4], mm2: ['area', 1e-6],
  m3: ['volume', 1], cm3: ['volume', 1e-6], mm3: ['volume', 1e-9],
  m4: ['inertia', 1], cm4: ['inertia', 1e-8], mm4: ['inertia', 1e-12],
  n: ['force', 1], kn: ['force', 1e3],
  'n.m': ['moment', 1], 'kn.m': ['moment', 1e3], 'n.mm': ['moment', .001], 'kn.mm': ['moment', 1],
  'n/m': ['line-force', 1], 'kn/m': ['line-force', 1e3], 'n/mm': ['line-force', 1e3],
  pa: ['pressure', 1], kpa: ['pressure', 1e3], mpa: ['pressure', 1e6], gpa: ['pressure', 1e9],
  'n/m2': ['pressure', 1], 'kn/m2': ['pressure', 1e3], 'n/mm2': ['pressure', 1e6],
  'kg/m3': ['density', 1], 't/m3': ['density', 1e3], 'tonne/m3': ['density', 1e3], 'g/cm3': ['density', 1e3],
  kg: ['mass', 1], t: ['mass', 1e3], tonne: ['mass', 1e3],
  rad: ['angle', 1], deg: ['angle', Math.PI/180], '°': ['angle', Math.PI/180],
  s: ['time', 1], ms: ['time', .001],
};
function unitKey(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/g, '').replace(/[·*]/g, '.').replace(/\^/g, '').replace(/²/g, '2').replace(/³/g, '3').replace(/⁴/g, '4');
}
function hasNumericValue(value: unknown): boolean {
  return typeof value === 'number' || (Array.isArray(value) ? value.some(hasNumericValue)
    : isRecord(value) ? Object.values(value).some(hasNumericValue) : false);
}

/** Canonical observations and reviewed modelField mappings must match the model.
 * Noncanonical observations remain candidates until an explicit field mapping.
 */
export function assertInputEvidenceMatchesModel(model: ModelRecord, evidence: unknown = isRecord(model.metadata) ? model.metadata.inputEvidence : undefined): void {
  assertResolvedInput(evidence);
  if (!Array.isArray(evidence)) return;
  const byField = new Map<string, ModelRecord[]>();
  const active = activeInputEvidence(evidence);
  for (const record of active) {
    if (record.required === false) continue;
    const field = evidenceField(record);
    byField.set(field, [...(byField.get(field) ?? []), record]);
  }
  for (const [field, records] of byField) {
    const canonical = modelCollections.has(field.split('.')[0]!) || modelSingletons.has(field.split('.')[0]!);
    const latest = records.reduce((last, item, index) => isResolution(item) ? index : last, -1);
    const directObservation = latest < 0 ? records.filter(item => item.status === 'observed').at(-1) : undefined;
    if (latest < 0 && !directObservation) continue;
    if (latest < 0 && !canonical) {
      if (/^file:/.test(field) || /^coverage\.(geometry|connectivity|supports|loads|materials|sections)$/.test(field)) continue;
      throw new Error(`INPUT_EVIDENCE_MODEL_FIELD_REQUIRED: ${field} / 必需识别值尚未绑定到稳定模型字段`);
    }
    const resolution = latest < 0 ? {} : records[latest]!.resolution as ModelRecord;
    // File-read and category coverage reviews are workflow acknowledgments,
    // not a numerical model assignment. Concrete engineering fields still bind.
    if (resolution.modelField === undefined && /^file:/.test(field)) {
      if (isRecord(resolution.analysisInput)) {
        const binding = resolution.analysisInput;
        const reference = isRecord(binding.parameters) && isRecord(binding.parameters.fileReference) ? binding.parameters.fileReference : {};
        const completed = active.find(item => item.id === resolution.sourceEvidenceId);
        const source = completed && isRecord(completed.source) ? completed.source : {};
        if (binding.kind !== 'ground-motion' || source.complete !== true || source.sha256 !== reference.sha256
          || evidenceSourceFile(completed ?? {}) !== evidenceSourceFile(records[0]!)
          || !isRecord(source.fileReference) || source.fileReference.parsedSha256 !== reference.parsedSha256) {
          throw new Error('ANALYSIS_INPUT_COMPLETE_SOURCE_REQUIRED');
        }
        if (source.sheet !== undefined && (!isRecord(binding.parameters) || binding.parameters.sheetName !== source.sheet)) {
          throw new Error('ANALYSIS_INPUT_SOURCE_SHEET_MISMATCH');
        }
        continue;
      }
      const sourceRecord = records.find(item => item.requirement === 'field-mapping');
      if (sourceRecord) {
        const mapped = resolution.mappedFields;
        const source = isRecord(sourceRecord.source) ? sourceRecord.source : {};
        if (!Array.isArray(mapped) || !mapped.length || mapped.some(name => typeof name !== 'string'
          || !active.some(item => item.field === name && item.required !== false
            && evidenceSourceFile(item) === evidenceSourceFile(sourceRecord)
            && (!['csv-parse', 'xlsx'].includes(String(source.parser))
              || isRecord(item.source) && typeof item.source.row === 'number' && item.source.column !== undefined)
            && (modelCollections.has(name.split('.')[0]!) || modelSingletons.has(name.split('.')[0]!)
              || isResolution(item) && typeof (item.resolution as ModelRecord).modelField === 'string')
            && (item.status === 'observed' || isResolution(item))))) {
          throw new Error(`INPUT_SOURCE_FIELD_MAPPING_REQUIRED: ${field} / 附件须绑定已复核的工程字段或明确排除`);
        }
      }
      if (records.some(item => item.requirement === 'complete-read')) {
        const completed = active.find(item => item.id === resolution.sourceEvidenceId);
        if (!completed || !isRecord(completed.source) || completed.source.complete !== true
          || evidenceSourceFile(completed) !== evidenceSourceFile(records[0]!)
          || records.some(item => {
            const source = isRecord(item.source) ? item.source : {};
            return ['page', 'sheet', 'sha256'].some(key => source[key] !== undefined
              && source[key] !== (completed.source as ModelRecord)[key]);
          })) {
          throw new Error(`INPUT_SOURCE_COMPLETE_READ_REQUIRED: ${field} / 相关截断须完整读取或明确排除`);
        }
      }
      continue;
    }
    if (resolution.modelField === undefined && /^coverage\.(geometry|connectivity|supports|loads|materials|sections)$/.test(field)) continue;
    if (canonical && resolution.modelField !== undefined && resolution.modelField !== field) throw new Error(`INPUT_EVIDENCE_MODEL_FIELD_CONFLICT: ${field}`);
    const modelField = resolution.modelField ?? (canonical ? field : undefined);
    if (typeof modelField !== 'string' || !modelField.trim()) throw new Error(`INPUT_EVIDENCE_MODEL_FIELD_REQUIRED: ${field} / 复核的工程值还需指定模型字段`);
    const actual = readModelField(model, modelField);
    const preceding = records.slice(0, latest).filter(item => item.status !== 'resolved');
    const covered = new Set((resolution.evidenceHashes ?? preceding.map(contentHash)) as string[]);
    const selected = resolution.selectedSource === undefined ? undefined : preceding.find(item => covered.has(contentHash(item))
      && (item.id === resolution.selectedSource || item.source !== undefined && contentHash(item.source) === contentHash(resolution.selectedSource)));
    if (selected && selected.status !== undefined && selected.status !== 'observed') throw new Error(`INPUT_EVIDENCE_OBSERVED_SOURCE_REQUIRED: ${field}`);
    let expected: ModelRecord = directObservation ? observation(directObservation)
      : resolution.value !== undefined ? { value: resolution.value, unit: resolution.unit } : selected ? observation(selected) : {};
    if (resolution.value !== undefined && resolution.unit === undefined) {
      const units = new Set(preceding.filter(item => covered.has(contentHash(item))
        && contentHash(observation(item).value) === contentHash(resolution.value)).map(item => observation(item).unit));
      if (units.size === 1) expected = { ...expected, unit: [...units][0] };
    }
    if (typeof expected.value === 'number') {
      const targetUnit = modelFieldUnit(actual.route);
      if (!targetUnit) throw new Error(`INPUT_EVIDENCE_MODEL_UNIT_UNSUPPORTED: ${modelField}`);
      const sourceUnit = expected.unit ?? (targetUnit === '1' ? '1' : undefined);
      if (typeof sourceUnit !== 'string' || !sourceUnit.trim()) throw new Error(`INPUT_EVIDENCE_UNIT_REQUIRED: ${field}`);
      const from = inputUnits[unitKey(sourceUnit)], to = inputUnits[unitKey(targetUnit)];
      if (!from || !to || from[0] !== to[0]) throw new Error(`INPUT_EVIDENCE_UNIT_UNSUPPORTED: ${sourceUnit} -> ${targetUnit}`);
      const converted = expected.value * from[1] / to[1];
      if (typeof actual.value !== 'number' || !Number.isFinite(expected.value) || !Number.isFinite(actual.value) || !Number.isFinite(converted)
        || Math.abs(actual.value - converted) > 32*Number.EPSILON*Math.max(Math.abs(actual.value), Math.abs(converted), Number.MIN_VALUE)) {
        throw new Error(`INPUT_EVIDENCE_MODEL_VALUE_MISMATCH: ${field} -> ${modelField} / 复核值尚未应用到模型`);
      }
    } else {
      if (expected.value === undefined || expected.value === null || hasNumericValue(expected.value)) throw new Error(`INPUT_EVIDENCE_SCALAR_MAPPING_REQUIRED: ${field}`);
      if (contentHash(actual.value) !== contentHash(expected.value)) throw new Error(`INPUT_EVIDENCE_MODEL_VALUE_MISMATCH: ${field} -> ${modelField} / 复核值尚未应用到模型`);
    }
  }
}

export function mergeInputEvidence(existing: ModelRecord[] | undefined, patch: ModelRecord[] | undefined) {
  if (!patch) return existing;
  const records = new Map<string, ModelRecord>();
  for (const record of [...(existing ?? []), ...patch]) {
    const stored = structuredClone(record);
    if (isResolution(stored) && isRecord(stored.resolution) && stored.resolution.evidenceHashes === undefined) {
      stored.resolution.evidenceHashes = [...records.values()]
        .filter((item) => item.required !== false && item.status !== 'resolved' && evidenceField(item) === evidenceField(stored))
        .map((item) => contentHash(item));
    }
    const key = typeof record.id === 'string' ? record.id : contentHash(record);
    const previous = records.get(key);
    if (previous) {
      if (contentHash(previous) !== contentHash(stored)) throw new Error(`INPUT_EVIDENCE_ID_CONFLICT: ${key}; append changed evidence with a new ID / 已有证据不可覆盖，请为新版本使用新的证据 ID。`);
      continue;
    }
    records.set(key, stored);
  }
  return [...records.values()];
}
