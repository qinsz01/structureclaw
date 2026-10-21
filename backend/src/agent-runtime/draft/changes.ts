import { canonicalDraftPath, withLegacyScalarViews, normalizeFrameBoundary } from './legacy-fields.js';
import { draftFieldValues } from '../draft-diagnostics.js';
import { validDraftValue } from '../../engineering/draft-contract.js';
import { isDeepStrictEqual } from 'node:util';
import type { DraftExtraction, DraftState } from '../../shared/types/agent.js';

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
export function unappliedDraftFields(patch: DraftExtraction | undefined, after: DraftState | undefined) {
  const actual = leaves(draftValues(after));
  return [...leaves(draftValues(patch))].filter(([path, value]) => !path.includes('.extra.') && !isDeepStrictEqual(value, actual.get(path)))
    .map(([field]) => ({ field, reason: 'NOT_RETAINED',
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
