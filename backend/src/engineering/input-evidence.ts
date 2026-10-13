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

/** Evidence is retained, including superseded/conflicting observations. Resolution is explicit. */
export function unresolvedInputEvidence(value: unknown): Array<{ field: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  const records = value.filter(isRecord);
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
