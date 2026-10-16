import { assertCanonicalCoordinateModel, withCanonicalCoordinateContract } from '../engineering/coordinate-semantics.js';
import type { DraftState } from '../shared/types/agent.js';
import { applyDraftAnalysisControl } from './engineering-draft.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(message: string): never { throw new Error(`INVALID_EXPLICIT_MODEL: ${message} / 显式模型不完整或不一致，请补充或修正所列字段`); }
function entities(value: unknown, name: string, allowEmpty = false): RecordValue[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.some((item) => !record(item))) fail(`${name} must be an array of complete records`);
  const result = value as RecordValue[];
  const ids = result.map((item) => item.id);
  if (ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) fail(`${name} requires unique non-empty string ids`);
  return result;
}

/** One physical V2 model boundary for explicit/generic paths; no template inference. */
export function validateExplicitModel(model: RecordValue): RecordValue {
  if (!['2.0.0', '2.1.0', '2.2.0'].includes(String(model.schema_version))) fail('schema_version must be 2.0.0, 2.1.0 or 2.2.0');
  const nodes = entities(model.nodes, 'nodes');
  const elements = entities(model.elements, 'elements');
  const materials = entities(model.materials, 'materials');
  const sections = entities(model.sections, 'sections');
  const cases = entities(model.load_cases, 'load_cases', true);
  const materialIds = new Set(materials.map((item) => item.id));
  const sectionIds = new Set(sections.map((item) => item.id));
  for (const node of nodes) {
    if (node.restraints != null && (!Array.isArray(node.restraints) || node.restraints.length !== 6 || node.restraints.some((v) => typeof v !== 'boolean'))) fail(`node ${node.id}: restraints must contain six booleans`);
  }
  for (const element of elements) {
    if (!['beam', 'column', 'truss', 'brace', 'link', 'shell', 'solid', 'wall', 'slab'].includes(String(element.type))) fail(`element ${element.id}: explicit type required`);
    if (!materialIds.has(element.material)) fail(`element ${element.id}: unknown material ${element.material}`);
    if (!sectionIds.has(element.section)) fail(`element ${element.id}: unknown section ${element.section}`);
  }
  for (const material of materials) {
    const densityRequired = !record(model.analysis_control) || model.analysis_control.self_weight !== false;
    for (const key of ['E', 'nu', ...(densityRequired || material.rho != null ? ['rho'] : [])]) {
      if (typeof material[key] !== 'number' || !Number.isFinite(material[key])) fail(`material ${material.id}: finite ${key} required`);
    }
    if (Number(material.E) <= 0 || material.rho != null && Number(material.rho) < 0 || Number(material.nu) <= -1 || Number(material.nu) >= 0.5) fail(`material ${material.id}: invalid elastic constants/density`);
  }
  for (const section of sections) {
    if (!record(section.properties) && !record(section.dimensions) && !record(section.shape)) fail(`section ${section.id}: properties, dimensions or shape required`);
  }
  const caseIds = new Set(cases.map((item) => item.id));
  if (model.load_combinations !== undefined) {
    for (const combination of entities(model.load_combinations, 'load_combinations', true)) {
      if (!record(combination.factors) || !Object.keys(combination.factors).length) fail(`combination ${combination.id}: factors required`);
      for (const [id, factor] of Object.entries(combination.factors)) {
        if (!caseIds.has(id) || typeof factor !== 'number' || !Number.isFinite(factor)) fail(`combination ${combination.id}: invalid factor/reference ${id}`);
      }
    }
  }
  const coordinate = model.coordinate_system;
  if (!record(coordinate) || !['2d', '3d'].includes(String(coordinate.dimension))) fail('coordinate_system and dimension must be explicit');
  assertCanonicalCoordinateModel(model, coordinate.dimension as '2d' | '3d');
  return model;
}

/** Full explicit records take precedence over role-based convenience templates. */
export function buildExplicitDraftModel(state: DraftState): RecordValue | undefined {
  const draft = state.engineeringDraft;
  if (!draft) return undefined;
  const explicit = draft.model || draft.topology?.members?.some((member) => member.type || member.material || member.section);
  if (!explicit) return undefined;
  if (draft.model) {
    const model = structuredClone(draft.model);
    model.metadata = { ...(record(model.metadata) ? model.metadata : {}), inputEvidence: structuredClone(draft.inputEvidence ?? (record(model.metadata) ? model.metadata.inputEvidence : undefined) ?? []) };
    return validateExplicitModel(applyDraftAnalysisControl(model, draft, true));
  }
  if (!draft.topology?.nodes?.length || !draft.topology.members?.length) fail('topology.nodes and topology.members required');
  if (!draft.materials?.length || !draft.sectionRecords?.length) fail('materials and sectionRecords required; role defaults cannot replace explicit assignments');
  const dimension = draft.coordinateSystem?.dimension ?? state.frameDimension;
  if (!['2d', '3d'].includes(String(dimension))) fail('coordinateSystem.dimension required; a planar drawing alone does not establish a 2-D analysis');
  if (draft.coordinateSystem?.dimension && state.frameDimension && draft.coordinateSystem.dimension !== state.frameDimension) {
    fail('coordinateSystem.dimension conflicts with legacy frameDimension');
  }
  if (!draft.loadCases && draft.loads?.length) fail('loadCases required for explicit topology: preserve targets, signs, components and member positions');
  if (draft.loads?.length && !draft.loadCases?.some(loadCase => Array.isArray(loadCase.loads) && loadCase.loads.length)) {
    fail('loadCases[].loads must contain the declared loads with node/element targets; draft.loads cannot substitute for explicit load records');
  }
  const model = withCanonicalCoordinateContract({
    schema_version: '2.2.0',
    nodes: structuredClone(draft.topology.nodes),
    elements: structuredClone(draft.topology.members),
    materials: structuredClone(draft.materials),
    sections: structuredClone(draft.sectionRecords),
    load_cases: structuredClone(draft.loadCases ?? []),
    load_combinations: structuredClone(draft.analysis?.loadCombinations ?? []),
    metadata: { inputEvidence: structuredClone(draft.inputEvidence ?? []), physicalModel: true },
  }, dimension as '2d' | '3d');
  // Fill only protocol constants; validate any explicitly supplied coordinate semantics.
  if (draft.coordinateSystem) Object.assign(model.coordinate_system, draft.coordinateSystem);
  return validateExplicitModel(applyDraftAnalysisControl(model, draft));
}
