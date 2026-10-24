import { canonicalDraftPath, withLegacyScalarViews, normalizeFrameBoundary } from './legacy-fields.js';
import { draftFieldValues } from '../draft-diagnostics.js';
import { validDraftValue } from '../../engineering/draft-contract.js';
import { isDeepStrictEqual } from 'node:util';
import type { DraftExtraction, DraftState } from '../../shared/types/agent.js';
import { normalizeFloorLoads } from './normalize.js';

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);

/** Semantic input only: timestamps, routing and the legacy mirror cannot manufacture progress. */
function draftValues(state: DraftState | DraftExtraction | undefined): RecordValue {
  const { updatedAt: _time, skillId: _skill, structuralTypeKey: _key, supportLevel: _level, supportNote: _note,
    routingSource: _route, coordinateSemantics: _coords, draftIssues: _issues, clearDraftFields: _clear,
    skillState, ...inputs } = state ?? {};
  const { engineeringDraft: _mirror, invalidDraftFields: _invalid, extractionSource: _source, ...skillInputs } = skillState ?? {};
  return { ...inputs, skillState: skillInputs };
}

/** Stable IDs address record arrays; empty normalized objects carry no input information. */
function leaves(value: unknown, path = '', result = new Map<string, unknown>()): Map<string, unknown> {
  if (value === undefined) return result;
  if (Array.isArray(value)) {
    if (value.length && value.every(item => isRecord(item) && typeof item.id === 'string')) {
      for (const item of value) leaves(item, `${path}[${JSON.stringify(item.id)}]`, result);
    } else if (value.length) result.set(path, value);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) leaves(item, path ? `${path}.${key}` : key, result);
  } else result.set(path, value);
  return result;
}

export function draftChangedFields(before: DraftState | undefined, after: DraftState | undefined): string[] {
  const old = leaves(draftValues(before)), next = leaves(draftValues(after));
  return [...new Set([...old.keys(), ...next.keys()])].filter(path => !isDeepStrictEqual(old.get(path), next.get(path))).sort();
}

/** Read back normalized extracted values, not keywords in user prose. Already stored values are retained. */
export function unappliedDraftFields(patch: DraftExtraction | undefined, after: DraftState | undefined, source?: RecordValue) {
  const supplied = draftValues(patch);
  // A canonical load declaration generates this legacy view during compilation. Audit
  // its source loads, while retaining the check for explicitly supplied floor totals.
  if (source && !Object.hasOwn(source, 'floorLoads') && patch?.engineeringDraft?.loads) delete supplied.floorLoads;
  let rejectedFloors = false;
  if (source && Object.hasOwn(source, 'floorLoads')) {
    delete supplied.floorLoads;
    const rows = source.floorLoads;
    const identified = Array.isArray(rows) && rows.every(row => isRecord(row)
      && ['number', 'string'].includes(typeof row.story) && Number.isInteger(Number(row.story)) && Number(row.story) > 0);
    rejectedFloors = !identified || rows.some(raw => {
      const row = normalizeFloorLoads([raw])?.[0];
      if (!row) return true;
      const actual = after?.floorLoads?.find(item => item.story === row.story);
      const invalidValue = (['verticalKN', 'liveLoadKN', 'lateralXKN', 'lateralYKN'] as const)
        .some(key => raw[key] !== undefined && row[key] === undefined);
      return invalidValue || !actual || Object.entries(row).some(([key, value]) => value !== undefined && !isDeepStrictEqual(value, actual[key as keyof typeof actual]));
    });
  }
  const actual = leaves(draftValues(after));
  const rejected = [...leaves(supplied)].filter(([path, value]) => !path.includes('.extra.') && !isDeepStrictEqual(value, actual.get(path))).map(([path]) => path);
  return [...rejected, ...(rejectedFloors ? ['floorLoads'] : [])]
    .map(field => ({ field, reason: 'NOT_RETAINED',
      message: 'The extracted value was not retained in the draft. / 提取出的值未保留在草稿中。' }));
}

/** A valid applied answer that readiness still rejects is a contract error, not another question. */
export function unresolvedAppliedFields(patch: DraftExtraction, after: DraftState, critical: string[]) {
  const supplied = leaves(draftValues(patch));
  const actual = leaves(draftValues(after));
  return critical.flatMap(requiredPath => {
    const required = canonicalDraftPath(requiredPath);
    const appliedPaths = [...supplied].filter(([path, value]) => {
      let canonical = canonicalDraftPath(path);
      if (['frame', 'portal-frame'].includes(after.inferredType) && canonical === 'boundary.supportType') canonical = 'boundary.frameBaseSupportType';
      const sameFact = canonical === required || canonical.startsWith(required + '.') || canonical.startsWith(required + '[');
      return sameFact && value != null && isDeepStrictEqual(value, actual.get(path));
    }).map(([path]) => path);
    const values = draftFieldValues(normalizeFrameBoundary(withLegacyScalarViews(patch), after.inferredType) as NonNullable<DraftExtraction['engineeringDraft']>, requiredPath);
    return appliedPaths.length && values.length && values.every(item => validDraftValue(item.schema, item.value))
      ? [{ requiredPath, appliedPaths }] : [];
  });
}
