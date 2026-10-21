import { enforceSectionProvenance } from './section-provenance.js';
import { SECTION_EVIDENCE_RULE } from './section-evidence.js';
import type { LocalStructureProtocolClient } from '../skill-shared/structure-protocol-execution.js';
import type { EngineeringDraft } from '../shared/types/agent.js';
import { isRecord, type ModelEdit, type ModelRecord } from './model-state.js';
import modelSchema from './structure-model-v2.schema.json' with { type: 'json' };

type Schema = Record<string, any>;
const schemas = new WeakMap<LocalStructureProtocolClient, Promise<Schema>>();
export const sectionPropertyUnits: Record<string, string> = Object.fromEntries(
  Object.entries((modelSchema as Schema).$defs.SectionV2.properties.properties.properties)
    .map(([key, value]) => [key, (value as Schema)['x-unit']]),
);
export const modelEditGuidance = {
  format: 'Use nested objects or canonical dotted paths within values; do not prefix paths with material/member. / values使用嵌套对象或规范点路径，不加material/member前缀。',
  materials: 'materials[id].design: f/fv in MPa; material design strengths belong to the referenced material, not the element. / 设计强度写入引用材料的design。',
  elements: 'elements[id].design: beta1, phi_b, btLimit, lambdaLimit, deflectionLimitN; l0/h0 in mm; serviceability_result_keys is an array of saved result keys; requested_checks is an optional nonempty array of user-selected check IDs/names (omit for all checks); basis maps field names to supplied evidence. / 构件设计条件、使用工况数组及依据；requested_checks仅用于用户明确指定的专项范围，省略则检查全部。',
  sections: 'sections[id].properties: A/As m2, Iy/Iz/J m4, Wnx/Wx/Wz/S/Sz m3, tw/tz/b/t/imin m. shape dimensions are mm. Updates deep-merge: send only changed properties, preserving supplied values and axis mappings. Never infer units from magnitude. / 截面属性采用米制，shape尺寸为mm；更新会递归合并，只传修改字段，保留已给数值及轴映射，禁止按大小猜单位。',
  sectionSources: 'Section sources: user properties win (extra.provenance.properties="user"). For user dimensions, supply shape with extra.provenance.shape="user" and omit properties for SYSTEM sharp-corner derivation. Designation-only sections require one dimension question together with other missing inputs. Assistant-recalled values must remain labelled llm-table candidates until the user actually confirms; they cannot enter a computable model. Offer them only as "assistant-recalled table value, please verify". After an actual answer/selection, record confirmed dimensions as user-sourced, omit recalled properties, and derive from geometry. Never relabel recalled values merely to bypass a rejection. / 截面来源：用户属性优先，properties来源为user；用户尺寸只提交shape并标记user，属性由系统按尖角推导。仅型号须将尺寸与其他缺项合并询问一次。助手记忆值只能是llm-table候选，标注“助手记忆的标准表值，请核对”，用户实际确认前不得进入计算模型；实际答复或选中候选后，确认尺寸记录为user，不带入记忆属性，由系统推导。不得为绕过拒绝而改标来源。' + SECTION_EVIDENCE_RULE,
  discovery: 'query_model(includeSchema=true, collection=materials|elements|sections) returns fields from the actual V2 schema. / 可查询实际V2字段。',
};

export async function engineeringModelSchema(client: LocalStructureProtocolClient): Promise<Schema> {
  let pending = schemas.get(client);
  if (!pending) {
    pending = client.get<Schema>('/schema/structure-model-v2').then(result => result.data);
    schemas.set(client, pending);
    pending.catch(() => schemas.delete(client));
  }
  return pending;
}

/** Locate a proposed reviewed field by actual stable IDs, before schema validation. */
export function modelFieldEdit(model: ModelRecord, field: string, value: unknown): ModelEdit {
  const [root] = field.split('.');
  if (['analysis_control', 'site_seismic', 'structure_system', 'wind'].includes(root!)) {
    return { operation: 'update', collection: 'model_settings', id: root!, values: { [field.slice(root!.length + 1)]: value } };
  }
  const candidates = Array.isArray(model[root!]) ? (model[root!] as unknown[]).filter(isRecord)
    .filter(row => field.startsWith(`${root}.${row.id}.`)) : [];
  if (candidates.length !== 1) fail(field, 'INPUT_EVIDENCE_MODEL_FIELD_NOT_FOUND_OR_AMBIGUOUS');
  const owner = candidates[0]!, rest = field.slice(`${root}.${owner.id}.`.length);
  if (root === 'load_cases' && rest.startsWith('loads.')) {
    const loads = Array.isArray(owner.loads) ? owner.loads.filter(isRecord).filter(row => rest.startsWith(`loads.${row.id}.`)) : [];
    if (loads.length !== 1) fail(field, 'INPUT_EVIDENCE_MODEL_FIELD_NOT_FOUND_OR_AMBIGUOUS');
    return { operation: 'update', collection: 'loads', caseId: String(owner.id), id: String(loads[0]!.id), values: { [rest.slice(`loads.${loads[0]!.id}.`.length)]: value } };
  }
  return { operation: 'update', collection: root as ModelEdit['collection'], id: String(owner.id), values: { [rest]: value } };
}
function resolved(schema: Schema, root: Schema): Schema {
  if (schema.$ref) return resolved(root.$defs?.[String(schema.$ref).split('/').at(-1)!] ?? {}, root);
  if (Array.isArray(schema.anyOf)) return resolved(schema.anyOf.find((item: Schema) => item.type !== 'null') ?? {}, root);
  return schema;
}
function fail(path: string, reason: string): never {
  throw new Error(`MODEL_EDIT_FIELD_INVALID: ${path}: ${reason} / 编辑字段无效；请按query_model返回的实际字段、类型与单位修改，原模型未变`);
}
function equalValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, i) => equalValue(value, right[i]));
  if (isRecord(left) && isRecord(right)) return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && equalValue(left[key], right[key]));
  return Object.is(left, right);
}
function canonicalEnum(value: unknown, allowed: string[]): unknown {
  return typeof value === 'string' ? allowed.find(item => item.toLowerCase() === value.trim().toLowerCase()) ?? value : value;
}
function field(schema: Schema, key: string, root: Schema, path: string, model: ModelRecord, edit: ModelEdit): Schema {
  if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(path, 'unsafe field');
  const current = resolved(schema, root);
  if (current.properties?.[key]) return current.properties[key];
  if (isRecord(current.properties)) {
    const element = Array.isArray(model.elements) ? model.elements.find(item => isRecord(item) && item.id === edit.id) : undefined;
    const materialDesign = root.$defs?.MaterialDesign?.properties ?? {};
    const hint = edit.collection === 'elements' && materialDesign[key] && element
      ? `; write materials.${element.material}.design.${key}` : '';
    fail(path, `unsupported field; allowed: ${Object.keys(current.properties).join(', ')}${hint}`);
  }
  if (isRecord(current.additionalProperties)) return current.additionalProperties;
  if (current.additionalProperties === true || !Object.keys(current).length) return {};
  fail(path, 'unsupported field');
}
function normalized(value: unknown, schema: Schema, root: Schema, path: string, model: ModelRecord, edit: ModelEdit): unknown {
  if (value === null) return null; // The formal validator decides whether null is allowed.
  const current = resolved(schema, root);
  if (edit.collection === 'sections' && path.endsWith('.shape.kind') && current.enum) value = canonicalEnum(value, current.enum);
  if ((current.type === 'object' || current.properties) && typeof value === 'string') {
    try { value = JSON.parse(value); } catch { fail(path, 'expected a JSON object'); }
  }
  if (current.type === 'array' && typeof value === 'string') {
    try { value = JSON.parse(value); } catch { fail(path, 'expected an array, e.g. ["case:LC1"]'); }
  }
  if (['number', 'integer'].includes(current.type) && typeof value === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) value = Number(value);
  if (current.type === 'boolean' && (value === 'true' || value === 'false')) value = value === 'true';
  if (Array.isArray(value)) {
    if (current.type && current.type !== 'array') fail(path, `expected ${current.type}`);
    return value.map((item, index) => normalized(item, current.items ?? {}, root, `${path}[${index}]`, model, edit));
  }
  if (isRecord(value)) {
    if (current.type && current.type !== 'object') fail(path, `expected ${current.type}`);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item, field(current, key, root, `${path}.${key}`, model, edit), root, `${path}.${key}`, model, edit)]));
  }
  if (['number', 'integer'].includes(current.type) && (typeof value !== 'number' || !Number.isFinite(value))) fail(path, `expected finite ${current.type}`);
  if (current.type === 'object' || current.type === 'array') fail(path, `expected ${current.type}`);
  if (current.type === 'boolean' && typeof value !== 'boolean' || current.type === 'string' && typeof value !== 'string') fail(path, `expected ${current.type}`);
  if (current.enum && !current.enum.includes(value)) fail(path, `expected one of ${current.enum.join(', ')}`);
  if (typeof value === 'number') {
    if (current.exclusiveMinimum !== undefined && value <= current.exclusiveMinimum) fail(path, `must be greater than ${current.exclusiveMinimum}`);
    if (current.minimum !== undefined && value < current.minimum) fail(path, `must be greater than or equal to ${current.minimum}`);
    if (current.maximum !== undefined && value > current.maximum) fail(path, `must be less than or equal to ${current.maximum}`);
  }
  return value;
}
function insert(target: ModelRecord, keys: string[], value: unknown, path: string): void {
  const [key, ...rest] = keys;
  if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) fail(path, 'unsafe or empty field');
  if (rest.length) {
    if (target[key] !== undefined && !isRecord(target[key])) fail(path, 'MODEL_EDIT_PATH_CONFLICT');
    const child = isRecord(target[key]) ? target[key] as ModelRecord : {};
    target[key] = child; insert(child, rest, value, path); return;
  }
  if (target[key] === undefined) { target[key] = value; return; }
  if (isRecord(target[key]) && isRecord(value)) {
    for (const [name, item] of Object.entries(value)) insert(target[key] as ModelRecord, [name], item, path);
  } else if (!equalValue(target[key], value)) fail(path, 'MODEL_EDIT_PATH_CONFLICT');
}
export function normalizeModelEdits(model: ModelRecord, edits: ModelEdit[], root: Schema): ModelEdit[] {
  return edits.map(edit => {
    if (!edit.values) return edit;
    const collection = edit.collection === 'loads' ? resolved(resolved(root.properties.load_cases.items, root).properties.loads, root).items
      : edit.collection === 'model_settings' ? root.properties[edit.id] : root.properties[edit.collection]?.items;
    if (!collection) fail(edit.collection, 'unsupported collection');
    const values: ModelRecord = {};
    for (const [name, raw] of Object.entries(edit.values)) {
      const keys = name.split('.'); let schema = collection;
      for (const key of keys) schema = field(schema, key, root, `${edit.collection}.${edit.id}.${name}`, model, edit);
      // A dictionary of section properties is intentionally extensible in V2,
      // but physical edits must use declared, consumed engineering properties.
      if (edit.collection === 'sections' && keys[0] === 'properties') {
        let properties: unknown = keys.length === 1 ? raw : { [keys[1]!]: raw };
        if (keys.length === 1 && typeof raw === 'string') {
          try { properties = JSON.parse(raw); } catch { fail(`sections.${edit.id}.properties`, 'expected a JSON object'); }
        }
        if (isRecord(properties)) for (const property of Object.keys(properties)) {
          if (!sectionPropertyUnits[property] && property !== 'G') fail(`sections.${edit.id}.properties.${property}`, 'unsupported section property; use canonical Iy/Iz, not Ix, and extra for annotations');
        }
        if (keys.length > 1) schema = { type: 'number' };
        else schema = { type: 'object', additionalProperties: { type: 'number' } };
      }
      insert(values, keys, normalized(raw, schema, root, `${edit.collection}.${edit.id}.${name}`, model, edit), name);
    }
    return { ...edit, values };
  });
}

/** Conversion cannot turn an accepted edit into a silently discarded no-op. */
export function assertModelEditReadback(model: ModelRecord, edits: ModelEdit[], sourceModel?: ModelRecord): void {
  const check = (actual: unknown, expected: unknown, path: string) => {
    // Null is the transaction's explicit remove-field operation. The formal
    // schema may restore a declared default; it must still validate the model.
    if (expected === null) return;
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length) fail(path, 'MODEL_EDIT_NOT_PRESERVED_BY_CONVERSION');
      expected.forEach((value, index) => check(actual[index], value, `${path}[${index}]`));
    }
    else if (isRecord(expected)) { for (const [key, value] of Object.entries(expected)) check(isRecord(actual) ? actual[key] : undefined, value, `${path}.${key}`); }
    else if (!equalValue(actual, expected)) fail(path, 'MODEL_EDIT_NOT_PRESERVED_BY_CONVERSION');
  };
  for (const edit of edits) {
    if (edit.operation === 'remove' || !edit.values) continue;
    const owner = edit.collection === 'loads' ? (model.load_cases as ModelRecord[])?.find(row => row.id === edit.caseId) : model;
    const actual = edit.collection === 'model_settings' ? model[edit.id] : (owner?.[edit.collection] as ModelRecord[])?.find(row => row.id === edit.id);
    let expected = edit.values;
    const source = edit.collection === 'sections'
      ? (sourceModel?.sections as ModelRecord[] | undefined)?.find(row => row.id === edit.id) : undefined;
    if (source && enforceSectionProvenance(source) !== source) {
      // Source precedence deliberately replaces non-user properties during conversion.
      // All other requested edits still require exact readback; user properties never take this path.
      const extra = isRecord(expected.extra) ? expected.extra : {};
      expected = { ...expected, properties: null, extra: { ...extra, source: null,
        provenance: { ...(isRecord(extra.provenance) ? extra.provenance : {}), properties: 'geometry' } } };
    }
    check(actual, expected, `${edit.collection}.${edit.id}`);
  }
}

function referencedDefinitions(root: Schema, selected: unknown): Schema {
  const definitions: Schema = {};
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isRecord(value)) return;
    if (typeof value.$ref === 'string') {
      const name = value.$ref.split('/').at(-1)!;
      if (!Object.hasOwn(definitions, name)) { definitions[name] = root.$defs?.[name]; visit(definitions[name]); }
    }
    Object.values(value).forEach(visit);
  };
  visit(selected);
  return definitions;
}

export function editCollectionSchema(root: Schema, collection?: string): ModelRecord {
  const names = collection ? [collection] : ['materials', 'elements', 'sections'];
  const collections = Object.fromEntries(names.map(name => [name, root.properties[name]?.items ?? root.properties[name] ?? {}]));
  const definitions = referencedDefinitions(root, collections);
  return { collections, $defs: definitions, sectionPropertyUnits };
}

/** The extractor receives the same design contract as model validation and edits. */
export function draftDesignSchema(root: Schema): ModelRecord {
  const inputs = {
    'materials[].design': resolved(root.properties.materials.items, root).properties.design,
    'templateAssignments.<role>.design': resolved(root.properties.elements.items, root).properties.design,
  };
  return { inputs, $defs: referencedDefinitions(root, inputs) };
}

export function hasDraftDesignInputs(draft: unknown): boolean {
  if (!isRecord(draft)) return false;
  return (Array.isArray(draft.materials) && draft.materials.some(row => isRecord(row) && row.design !== undefined))
    || (isRecord(draft.templateAssignments) && Object.values(draft.templateAssignments).some(row => isRecord(row) && row.design !== undefined));
}

/** Reject malformed generated design records before a deep merge poisons the saved draft.
 * This checks field names and types; full physical validation remains at model entry.
 */
export function assertDraftDesignInputs(draft: unknown, root: Schema): void {
  if (!isRecord(draft)) return;
  const check = (design: unknown, collection: 'materials' | 'elements', id: string, path: string) => {
    if (design === undefined) return;
    const schema = resolved(root.properties[collection].items, root).properties.design;
    const canonical = normalized(design, schema, root, path, {}, { operation: 'update', collection, id });
    if (!equalValue(canonical, design)) fail(path, 'use canonical typed values; draft unchanged');
  };
  for (const [index, row] of (Array.isArray(draft.materials) ? draft.materials : []).entries()) {
    if (isRecord(row)) check(row.design, 'materials', String(row.id ?? index), `materials[${row.id ?? index}].design`);
  }
  for (const [role, row] of Object.entries(isRecord(draft.templateAssignments) ? draft.templateAssignments : {})) {
    if (isRecord(row)) check(row.design, 'elements', role, `templateAssignments.${role}.design`);
  }
}

/** The Python model owns the shape vocabulary. Drafts use that same schema,
 * before readiness or persistence, rather than asking the LLM to repair casing.
 */
export function draftSectionShapeSchema(root: Schema): Schema {
  return resolved(resolved(root.properties.sections.items, root).properties.shape, root);
}

export function normalizeDraftSectionInputs(draft: EngineeringDraft, root: Schema): EngineeringDraft {
  const schema = draftSectionShapeSchema(root);
  const kinds = schema.properties.kind.enum as string[];
  const section = (row: Record<string, unknown>) => {
    const next = structuredClone(row);
    // The stable table ID is also a valid display label; it is not missing engineering input.
    if ((next.name === undefined || typeof next.name === 'string' && !next.name.trim())
      && typeof next.id === 'string' && next.id.trim()) next.name = next.id;
    if (next.type !== undefined) next.type = canonicalEnum(next.type, kinds);
    if (next.shape != null) {
      const path = `sectionRecords[${row.id}].shape`;
      if (!isRecord(next.shape) || next.shape.kind == null) fail(path, 'an object with an explicit kind is required');
      next.shape = normalized(next.shape, schema, root,
        path, {}, { operation: 'update', collection: 'sections', id: String(row.id) });
      if (next.type == null) next.type = (next.shape as Record<string, unknown>).kind;
    }
    if (next.type == null && isRecord(next.properties) && Object.keys(next.properties).length) next.type = 'general';
    return enforceSectionProvenance(next);
  };
  return { ...draft,
    ...(draft.sectionRecords ? { sectionRecords: draft.sectionRecords.map(section) } : {}),
    ...(Array.isArray(draft.model?.sections) ? { model: { ...draft.model, sections: draft.model.sections.map(section) } } : {}),
  };
}
