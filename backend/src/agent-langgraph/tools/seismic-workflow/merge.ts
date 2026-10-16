import { isRecord } from '../shared.js';

type ParsedJsonObjectInput =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function parseJsonObjectInput(value: string | undefined, fieldName: string): ParsedJsonObjectInput | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return { ok: false, error: `${fieldName} must be a JSON object.` };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${fieldName} is not valid JSON: ${message}` };
  }
}

export function hasStructuredSeismicWorkflow(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

export function hasSemanticSeismicWorkflowInput(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  if (!hasStructuredSeismicWorkflow(value)) {
    return false;
  }
  const semanticTopLevelKeys = Object.keys(value).filter((key) =>
    !['groundMotionSet', 'groundMotions', 'groundMotionRecords', 'timeHistoryRecords'].includes(key));
  if (semanticTopLevelKeys.length > 0) {
    return true;
  }
  const groundMotionSet = isRecord(value.groundMotionSet) ? value.groundMotionSet : undefined;
  if (!groundMotionSet) {
    return false;
  }
  return Object.keys(groundMotionSet).some((key) =>
    !['source', 'uploadedAttachments', 'records'].includes(key));
}

function mergeStructuredRecords(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return override ? { ...override } : undefined;
  }
  if (!override) {
    return { ...base };
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = result[key];
    result[key] = isRecord(baseValue) && isRecord(value)
      ? mergeStructuredRecords(baseValue, value)
      : value;
  }
  return result;
}

function isUploadedGroundMotionContext(value: Record<string, unknown> | undefined): boolean {
  const groundMotionSet = isRecord(value?.groundMotionSet) ? value.groundMotionSet : undefined;
  if (!groundMotionSet) {
    return false;
  }
  const source = typeof groundMotionSet.source === 'string'
    ? groundMotionSet.source.trim().toLowerCase()
    : '';
  return source === 'uploaded'
    || Array.isArray(groundMotionSet.uploadedAttachments);
}

function shouldMergeUploadedGroundMotionContext(
  base: Record<string, unknown> | undefined,
  context: Record<string, unknown> | undefined,
): boolean {
  if (!isUploadedGroundMotionContext(context)) {
    return true;
  }
  const baseGroundMotionSet = isRecord(base?.groundMotionSet) ? base.groundMotionSet : undefined;
  const source = typeof baseGroundMotionSet?.source === 'string'
    ? baseGroundMotionSet.source.trim().toLowerCase()
    : '';
  return !source || source === 'uploaded';
}

export function mergeSeismicWorkflowInputs(
  semanticWorkflow: Record<string, unknown> | undefined,
  contextWorkflow: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!semanticWorkflow) {
    return contextWorkflow ? { ...contextWorkflow } : undefined;
  }
  if (!contextWorkflow || !shouldMergeUploadedGroundMotionContext(semanticWorkflow, contextWorkflow)) {
    return { ...semanticWorkflow };
  }
  const merged = mergeStructuredRecords(semanticWorkflow, contextWorkflow) ?? {};
  const semanticSet = isRecord(semanticWorkflow.groundMotionSet) ? semanticWorkflow.groundMotionSet : {};
  const mergedSet = isRecord(merged.groundMotionSet) ? merged.groundMotionSet : {};
  if (Array.isArray(semanticSet.records) && Array.isArray(mergedSet.records)) {
    mergedSet.records = mergedSet.records.map(record => {
      if (!isRecord(record)) return record;
      const selected = (semanticSet.records as unknown[]).filter(isRecord).find(item => item.id !== undefined && item.id === record.id);
      if (!selected) return record;
      const settings = Object.fromEntries(Object.entries(selected).filter(([key]) => ['unit', 'direction', 'component', 'axis', 'seismicDirection',
        'dt', 'timeStep', 'time_step', 'timeUnit', 'timeColumn', 'accelerationColumn', 'accelColumn', 'valueColumn'].includes(key)));
      return { ...record, ...settings };
    });
  }
  return merged;
}
