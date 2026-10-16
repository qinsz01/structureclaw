import { fieldTokens } from '../engineering/field-path.js';
import { draftContract, legacyDraftPaths } from '../engineering/draft-contract.js';
import { draftFieldValues } from './draft-diagnostics.js';
import type { DraftState } from './types.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (path: string, reason: string): never => { throw new Error(`DRAFT_CLEAR_INVALID: ${path}: ${reason} / 草稿删除操作无效，原状态未变`); };

export function normalizeClearDraftFields(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(field => typeof field !== 'string' || !field.trim())) fail('clearDraftFields', 'expected field paths');
  return [...new Set((value as string[]).map(field => field.trim().replace(/^engineeringDraft\./, '')))];
}

/** Omission means unchanged. Deletion is a separate operation, never guessed from prose or shape type. */
export function clearDraftFields(state: DraftState | undefined, fields: string[] | undefined): DraftState | undefined {
  if (!fields?.length) return state;
  if (!state?.engineeringDraft) return fail('clearDraftFields', 'no existing engineering draft');
  const next = structuredClone(state);
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '.') || a.startsWith(b + '[');
  const addresses = fields.map(path => ({ path, parts: fieldTokens(path) }));
  for (const { path, parts } of addresses) {
    if (!parts.length || parts.some(part => part.index || part.wildcard)
      || !Object.hasOwn(draftContract.properties, parts[0]!.key)) fail(path, 'use canonical fields and quoted stable IDs');
    // Raw evidence and its provenance are not a mutable calculation setting.
    if (['inputEvidence', 'metadata', 'model'].includes(parts[0]!.key)
      || parts.some(part => part.key === 'extra') || parts.at(-1)!.key === 'id') fail(path, 'identity and evidence are protected');
    for (const other of addresses) if (other.path !== path && overlaps(path, other.path)) fail(path, 'overlapping removals');
    let owner: unknown = next.engineeringDraft;
    for (let i = 0; i < parts.length; i++) {
      const { key } = parts[i]!;
      const last = i === parts.length - 1;
      if (Array.isArray(owner)) {
        const matches = owner.flatMap((item, index) => record(item) && item.id === key ? [index] : []);
        if (matches.length !== 1) fail(path, 'stable ID is absent or ambiguous');
        if (last) {
          owner.splice(matches[0]!, 1);
        } else owner = owner[matches[0]!];
      } else if (record(owner)) {
        if (last) {
          // Repeating an explicit withdrawal is harmless when this existing object's
          // field is declared by the canonical schema. Typos and missing IDs still fail.
          if (!Object.hasOwn(owner, key) && draftFieldValues(next.engineeringDraft!, path).length !== 1) fail(path, 'field is not declared');
          delete owner[key];
        } else owner = owner[key];
      } else fail(path, 'parent field does not exist');
    }
    // Historical scalar views cannot resurrect a removed canonical value.
    for (const [alias, canonical] of Object.entries(legacyDraftPaths)) {
      if (overlaps(canonical, path) || overlaps(path, canonical)) delete next[alias];
    }
    if (parts[0]!.key === 'loads') {
      for (const key of ['loadKN', 'loadType', 'loadPosition', 'loadPositionM', 'floorLoads']) delete next[key];
    }
  }
  const removed = fields.flatMap(field => draftFieldValues(state.engineeringDraft!, field).map(item => item.path));
  const withdrawn = (field: string) => draftFieldValues(state.engineeringDraft!, field).some(item => removed.some(path => overlaps(item.path, path)));
  next.draftIssues = next.draftIssues?.filter(issue => !issue.field || !withdrawn(issue.target ?? issue.field));
  if (next.skillState) next.skillState = { ...next.skillState,
    ...(next.skillState.engineeringDraft ? { engineeringDraft: next.engineeringDraft } : {}),
    ...(Array.isArray(next.skillState.invalidDraftFields) ? {
      invalidDraftFields: next.skillState.invalidDraftFields.filter(field => typeof field !== 'string' || !withdrawn(field)),
    } : {}),
  };
  return next;
}
