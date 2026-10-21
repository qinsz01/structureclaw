import type { DraftExtraction, DraftIssue, DraftState, EngineeringDraft } from '../shared/types/agent.js';
import { engineeringLoadClarifiesExisting } from './engineering-draft.js';
import { resolveTemplateMaterials, resolveTemplateSectionId, stiffnessPlaceholderUses } from './template-properties.js';
import { draftContract, resolveFieldSchema, validDraftValue, type FieldSchema } from '../engineering/draft-contract.js';
import { canonicalDraftPath as canonicalPath, legacyDraftContract, withLegacyScalarViews } from './draft/legacy-fields.js';
import { invalidDraftFieldsOf } from './draft/normalize.js';

import { fieldTokens as tokens, type FieldToken as Token } from '../engineering/field-path.js';
type Located = { path: string; value: unknown; schema: FieldSchema };
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function locate(state: DraftExtraction | DraftState, field: string): Located[] {
  const path = canonicalPath(field), keys = tokens(path);
  if (!keys.length) return [];
  const walk = (value: unknown, schema: FieldSchema, rest: Token[], address: string): Located[] => {
    if (!rest.length) return [{ value, schema, path: address }];
    const current = resolveFieldSchema(schema), [part, ...tail] = rest;
    if (current.type === 'array') {
      if (!Array.isArray(value) || !current.items) return [];
      // `materials.E` names a record field, not a record ID: it addresses every record
      // of the collection (the sole one, typically) and is reported by stable ID.
      if (!part!.wildcard && !part!.index && !value.some(item => record(item) && item.id === part!.key)
        && resolveFieldSchema(current.items).properties?.[part!.key]) {
        return value.flatMap((item, index) => walk(item, current.items!, rest,
          `${address}[${record(item) && typeof item.id === 'string' ? JSON.stringify(item.id) : index}]`));
      }
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
  return walk(withLegacyScalarViews(state), { ...draftContract, properties: { ...legacyDraftContract.properties, ...draftContract.properties } }, keys, '');
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

type TemplateRole = 'beam' | 'column' | 'member';
/** For `sections.<role>`: the role and the complete section record the template assigns to it. */
function assignedRoleSection(field: string, merged: DraftState): { role: TemplateRole; sectionId: string } | undefined {
  const [owner, role, ...rest] = tokens(canonicalPath(field));
  if (owner?.key !== 'sections' || rest.length || !['beam', 'column', 'member'].includes(role?.key ?? '')
    || !merged.engineeringDraft?.sectionRecords?.length || merged.engineeringDraft.model) return undefined;
  const key = role!.key as TemplateRole;
  try {
    const sectionId = resolveTemplateSectionId(merged, key);
    return sectionId ? { role: key, sectionId } : undefined;
  } catch { return undefined; }
}

/** Missing data is derived; ambiguity/conflicting evidence requires a new explicit answer.
 * Old field strings are accepted conservatively and resolved by stable record identity.
 */
export function mergeDraftDiagnostics(existing: DraftState | undefined, patch: DraftExtraction, merged: DraftState): Pick<DraftState, 'draftIssues' | 'skillState'> {
  const aligned = alignedPatch(patch, existing, merged.engineeringDraft);
  // Design inputs are not draft diagnostics: the analysis workflow never asks for them and an
  // explicitly requested code check reports its own missing inputs.
  const analysisIssue = (issue: DraftIssue): boolean => !issue.field || !isDesignDraftField(issue.field);
  const newIssues: DraftIssue[] = (patch.draftIssues ?? []).filter(analysisIssue).map(({ target: _untrustedTarget, ...issue }) => issue);
  const resolved = (issue: DraftIssue): boolean => {
    if (!issue.field || issue.severity === 'conflict'
      || !issue.kind && issue.severity === 'ambiguous' && issue.value != null) return false;
    const field = issue.target ?? issue.field;
    // Omitted self-weight follows the solver default (disabled); it is not a required input.
    if (issue.kind === 'missing' && canonicalPath(field) === 'analysisControl.self_weight') return true;
    if (issue.kind === 'missing' && ['frame', 'portal-frame'].includes(merged.inferredType)
      && canonicalPath(field) === 'boundary.frameBaseSupportType') return true;
    // A force-only request runs on labelled unit stiffness when material/section are absent.
    if (issue.kind === 'missing' && !merged.engineeringDraft?.model) {
      const root = tokens(canonicalPath(field))[0]?.key ?? '';
      const placeholder = stiffnessPlaceholderUses(merged);
      if (placeholder.material && ['material', 'materials'].includes(root)) return true;
      if (placeholder.section && ['section', 'sections', 'sectionRecords', 'templateAssignments'].includes(root)) return true;
    }
    // A whole material-group absence can be satisfied by either supported input
    // representation. Reuse the builder's projection, never guess numeric data.
    // A specific record/field or a confirmation/conflict is not interchangeable.
    if (issue.kind === 'missing' && ['material', 'materials'].includes(canonicalPath(field))
      && !merged.engineeringDraft?.model) {
      try {
        if (validDraftValue(draftContract.properties.materials, resolveTemplateMaterials(merged))) return true;
      } catch { /* An unknown grade remains missing; the builder reports its required properties. */ }
    }
    // A missing elastic field of a record that declares a supported grade is supplied by the same
    // grade projection the template builder uses; explicit values and unknown grades are unaffected.
    if (issue.kind === 'missing' && canonicalPath(field).startsWith('materials') && merged.engineeringDraft?.materials?.length
      && !merged.engineeringDraft.model) {
      const projected = { ...merged, engineeringDraft: { ...merged.engineeringDraft, materials: resolveTemplateMaterials(merged) } };
      const located = locate(projected, field);
      if (located.length && located.every(item => validDraftValue(item.schema, item.value))) return true;
    }
    // `sections.<role>` and the complete section record assigned to that role are one
    // engineering fact; a confirmation is answered by a new value in either representation.
    const assigned = assignedRoleSection(field, merged);
    if (assigned && (issue.kind === 'missing' || [`sectionRecords[${JSON.stringify(assigned.sectionId)}]`,
      `templateAssignments.${assigned.role}.sectionId`, 'templateAssignments.member.sectionId']
      .some(path => locate(aligned, path).some(supplied => supplied.value != null)))) return true;
    const old = existing ? locate(existing, field) : [];
    const current = old.length ? old.flatMap(item => locate(merged, item.path)) : locate(merged, field);
    if (!current.length || current.some(item => !validDraftValue(item.schema, item.value))) return false;
    return issue.kind === 'missing' || current.some(item => locate(aligned, item.path).some(supplied => supplied.value != null));
  };
  const pending = (existing?.draftIssues ?? []).filter(issue => analysisIssue(issue) && !resolved(issue));
  const issues = [...pending.filter(issue => issue.severity === 'conflict' || !newIssues.some(next => next.field && next.field === issue.field)), ...newIssues]
    .filter(issue => issue.kind !== 'missing' || !resolved(issue))
    .map(issue => {
      if (!issue.kind || issue.target || !issue.field) return issue;
      const locations = locate(merged, issue.field);
      return locations.length === 1 ? { ...issue, target: locations[0]!.path } : issue;
    });
  const legacy = [...new Set([...invalidDraftFieldsOf(existing), ...invalidDraftFieldsOf(patch)])]
    .filter(field => !isDesignDraftField(field))
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
  return [...new Set([...(state.draftIssues ?? []).map(issue => issue.field ?? issue.reason), ...invalidDraftFieldsOf(state)])];
}
