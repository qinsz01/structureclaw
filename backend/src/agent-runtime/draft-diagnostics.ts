import type { DraftExtraction, DraftIssue, DraftState, EngineeringDraft } from './types.js';
import { engineeringLoadClarifiesExisting } from './engineering-draft.js';
import { draftContract, legacyDraftContract, legacyDraftPaths, resolveFieldSchema, validDraftValue, type FieldSchema } from '../engineering/draft-contract.js';

type Token = { key: string; index?: boolean; wildcard?: boolean };
type Located = { path: string; value: unknown; schema: FieldSchema };
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalidFields = (state: DraftExtraction | DraftState | undefined): string[] =>
  Array.isArray(state?.skillState?.invalidDraftFields) ? state.skillState.invalidDraftFields.filter((v): v is string => typeof v === 'string') : [];

function tokens(field: string): Token[] {
  const result: Token[] = [];
  const pattern = /(?:^|\.)([^.[\]]+)|\[("(?:[^"\\]|\\.)*"|'[^']*'|[^\]]*)\]/g;
  let consumed = 0;
  for (const match of field.matchAll(pattern)) {
    if (match.index !== consumed) return [];
    consumed += match[0].length;
    const raw = match[1] ?? match[2]!, quoted = /^['"]/.test(raw);
    let key = raw;
    if (raw.startsWith('"')) { try { key = JSON.parse(raw); } catch { return []; } }
    else if (quoted) key = raw.slice(1, -1);
    if (['__proto__', 'prototype', 'constructor'].includes(key)) return [];
    result.push({ key, index: match[2] !== undefined && !quoted && /^\d+$/.test(raw), wildcard: !quoted && (key === '' || key === '*') });
  }
  return consumed === field.length ? result : [];
}
function canonicalPath(field: string): string {
  const path = field.replace(/^engineeringDraft\./, '');
  const root = tokens(path)[0]?.key;
  return root && legacyDraftPaths[root] ? legacyDraftPaths[root] + path.slice(root.length) : path;
}
function stateData(state: DraftExtraction | DraftState): Record<string, unknown> {
  // Historical scalar fields are read only at the compatibility boundary.
  const result: Record<string, any> = { ...state, ...(state.engineeringDraft ?? {}) };
  for (const [old, path] of Object.entries(legacyDraftPaths)) {
    if (state[old] === undefined || !path.includes('.')) continue;
    const [owner, key] = path.split('.');
    result[owner!] = { [key!]: state[old], ...(result[owner!] ?? {}) };
  }
  return result;
}
function locate(state: DraftExtraction | DraftState, field: string): Located[] {
  const path = canonicalPath(field), keys = tokens(path);
  if (!keys.length) return [];
  const walk = (value: unknown, schema: FieldSchema, rest: Token[], address: string): Located[] => {
    if (!rest.length) return [{ value, schema, path: address }];
    const current = resolveFieldSchema(schema), [part, ...tail] = rest;
    if (current.type === 'array') {
      if (!Array.isArray(value) || !current.items) return [];
      const selected = part!.wildcard ? value.map((item, index) => ({ item, index }))
        : part!.index ? [{ item: value[Number(part!.key)], index: Number(part!.key) }]
          : value.flatMap((item, index) => record(item) && item.id === part!.key ? [{ item, index }] : []);
      if (!part!.wildcard && selected.length !== 1) return [];
      return selected.flatMap(({ item, index }) => {
        const selector = record(item) && typeof item.id === 'string' ? JSON.stringify(item.id) : index;
        return walk(item, current.items, tail, `${address}[${selector}]`);
      });
    }
    const child = current.properties?.[part!.key] ?? (record(current.additionalProperties) ? current.additionalProperties : undefined);
    if (!child) return [];
    return walk(record(value) ? value[part!.key] : undefined, child, tail, address ? `${address}.${part!.key}` : part!.key);
  };
  return walk(stateData(state), { ...draftContract, properties: { ...legacyDraftContract.properties, ...draftContract.properties } }, keys, '');
}

export function draftFieldValues(draft: EngineeringDraft, field: string): Located[] {
  return locate({ engineeringDraft: draft }, field);
}

/** Schema ownership determines analysis versus design, independent of the field spelling. */
export function isDesignDraftField(field: string): boolean {
  const path = canonicalPath(field), parts = tokens(path);
  if (!parts.length) return false;
  // Old conversations used these containers; they remain design-only history.
  if (['design', 'designCheck', 'designCriteria', 'designParameters', 'codeCheck'].includes(parts[0]!.key)
    || path === 'material.designStrength') return true;
  if (parts[0]!.key === 'material' && parts[1]?.key === 'design') return true;
  if (parts[0]!.key === 'member' && parts[1]?.key === 'design') return true;
  let schema: FieldSchema = draftContract;
  for (const part of parts) {
    const current = resolveFieldSchema(schema);
    schema = current.type === 'array' ? current.items ?? {} : current.properties?.[part.key] ?? {};
    const variants = schema.anyOf ?? [schema];
    if (variants.some((item: FieldSchema) => ['#/$defs/MaterialDesign', '#/$defs/MemberDesign'].includes(item.$ref))) return true;
  }
  return false;
}

function alignedPatch(patch: DraftExtraction, existing: DraftState | undefined, draft: EngineeringDraft | undefined): DraftExtraction {
  const align = (incoming: any, original: any, merged: any, key: string): any => {
    if (Array.isArray(incoming) && incoming.some(record)) {
      if (!Array.isArray(merged)) return incoming;
      const result = new Array(merged.length);
      for (const item of incoming) {
        if (!record(item)) continue;
        const matches = merged.flatMap((target, index) => record(target) && (item.id
          ? target.id === item.id
          : key === 'loads' && !target.id && draft && engineeringLoadClarifiesExisting(target as any, item as any, draft)) ? [index] : []);
        if (matches.length === 1) result[matches[0]!] = item;
      }
      return result;
    }
    if (!record(incoming)) return incoming;
    return Object.fromEntries(Object.entries(incoming).map(([name, item]) => [name, align(item, original?.[name], merged?.[name], name)]));
  };
  return { ...patch, engineeringDraft: align(patch.engineeringDraft, existing?.engineeringDraft, draft, '') };
}

/** Missing data is derived; ambiguity/conflicting evidence requires a new explicit answer.
 * Old field strings are accepted conservatively and resolved by stable record identity.
 */
export function mergeDraftDiagnostics(existing: DraftState | undefined, patch: DraftExtraction, merged: DraftState): Pick<DraftState, 'draftIssues' | 'skillState'> {
  const aligned = alignedPatch(patch, existing, merged.engineeringDraft);
  const newIssues: DraftIssue[] = (patch.draftIssues ?? []).map(({ target: _untrustedTarget, ...issue }) => issue);
  const resolved = (issue: DraftIssue): boolean => {
    if (!issue.field || issue.severity === 'conflict'
      || !issue.kind && issue.severity === 'ambiguous' && issue.value != null) return false;
    const field = issue.target ?? issue.field;
    const old = existing ? locate(existing, field) : [];
    const current = old.length ? old.flatMap(item => locate(merged, item.path)) : locate(merged, field);
    if (!current.length || current.some(item => !validDraftValue(item.schema, item.value))) return false;
    return issue.kind === 'missing' || current.some(item => locate(aligned, item.path).some(supplied => supplied.value != null));
  };
  const pending = (existing?.draftIssues ?? []).filter(issue => !resolved(issue));
  const issues = [...pending.filter(issue => issue.severity === 'conflict' || !newIssues.some(next => next.field && next.field === issue.field)), ...newIssues]
    .filter(issue => issue.kind !== 'missing' || !resolved(issue))
    .map(issue => {
      if (!issue.kind || issue.target || !issue.field) return issue;
      const locations = locate(merged, issue.field);
      return locations.length === 1 ? { ...issue, target: locations[0]!.path } : issue;
    });
  const legacy = [...new Set([...invalidFields(existing), ...invalidFields(patch)])]
    .filter(field => issues.some(issue => issue.field === field)
      || !(existing?.draftIssues ?? []).some(issue => issue.field === field) && !resolved({ field, severity: 'invalid', reason: 'Legacy diagnostic' }));
  const fields = [...new Set([...legacy, ...issues.flatMap(issue => issue.field ? [issue.field] : [])])];
  const { invalidDraftFields: _old, ...skillState } = { ...existing?.skillState, ...patch.skillState };
  return { draftIssues: issues.length ? issues : undefined,
    skillState: Object.keys(skillState).length || fields.length ? { ...skillState, ...(fields.length ? { invalidDraftFields: fields } : {}) } : undefined };
}

export function currentDraftDiagnostics(state: DraftState): DraftState {
  return { ...state, ...mergeDraftDiagnostics(state, {}, state) };
}

export function unresolvedDraftFields(state: DraftState): string[] {
  return [...new Set([...(state.draftIssues ?? []).map(issue => issue.field ?? issue.reason), ...invalidFields(state)])];
}
