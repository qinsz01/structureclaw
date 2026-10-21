import { isRecord, type ModelRecord } from '../../engineering/model-state.js';
import { memberGeometry, coordinates } from '../../engineering/member-geometry.js';
import { buildStructuralCoordinateSystem } from '../../engineering/coordinate-semantics.js';
import { appliedLoadTotals } from '../../engineering/model-physics.js';
import { createLocalStructureProtocolClient } from '../structure-protocol-execution.js';
import { arcGeometry, polylineGeometry, regularFrameGeometry, trussPanelGeometry } from './geometry.js';
import { modellingOperationSchema, ModellingOperationError, type ModelSelector, type ModellingOperation } from './contract.js';

const rows = (value: unknown): ModelRecord[] => Array.isArray(value) ? value.filter(isRecord) : [];
export function selectRecords(records: ModelRecord[], selector: ModelSelector): ModelRecord[] {
  return records.filter(record => {
    if (selector.ids && !selector.ids.includes(String(record.id)) || selector.type && record.type !== selector.type
      || selector.story && record.story !== selector.story || selector.prefix && !String(record.id).startsWith(selector.prefix)) return false;
    const coordinate = selector.coordinate;
    if (!coordinate) return true;
    const value = Number(record[coordinate.axis]);
    return Number.isFinite(value) && (coordinate.eq === undefined || Math.abs(value - coordinate.eq) < 1e-8)
      && (coordinate.gt === undefined || value > coordinate.gt) && (coordinate.gte === undefined || value >= coordinate.gte)
      && (coordinate.lt === undefined || value < coordinate.lt) && (coordinate.lte === undefined || value <= coordinate.lte);
  });
}

function selected(records: ModelRecord[], selector: ModelSelector) {
  const result = selectRecords(records, selector);
  if (!result.length || selector.ids?.some(id => !result.some(record => record.id === id))) throw new ModellingOperationError('OPERATION_SELECTOR_UNRESOLVED', { selector });
  return result;
}
function addRecords(model: ModelRecord, collection: string, additions: ModelRecord[]) {
  const existing = rows(model[collection]);
  for (const record of additions) {
    const same = existing.find(item => item.id === record.id);
    if (same) {
      // Explicit partial records may supply the identity/coordinates of a generated joint.
      const matchingNode = collection === 'nodes' && ['x', 'y', 'z'].every(axis => Math.abs(Number(same[axis]) - Number(record[axis])) <= 1e-8);
      const matchingMember = collection === 'elements' && Array.isArray(same.nodes) && Array.isArray(record.nodes)
        && JSON.stringify([...same.nodes].sort()) === JSON.stringify([...record.nodes].sort());
      if (!matchingNode && !matchingMember) {
        throw new ModellingOperationError('OPERATION_ID_COLLISION', { collection, id: record.id });
      }
      Object.assign(same, { ...record, ...same });
    } else existing.push(record);
  }
  model[collection] = existing;
}
function loadCase(model: ModelRecord, id: string, type: string): ModelRecord[] {
  const cases = rows(model.load_cases);
  let current = cases.find(item => item.id === id);
  if (!current) { current = { id, type, loads: [] }; cases.push(current); }
  if (current.type !== undefined && current.type !== type && current.type !== 'other' && type !== 'other') throw new ModellingOperationError('OPERATION_CASE_TYPE_CONFLICT', { id, type });
  current.loads ??= []; model.load_cases = cases;
  return current.loads as ModelRecord[];
}
function appendLoads(model: ModelRecord, op: { id: string; caseId: string; caseType: string }, loads: ModelRecord[]) {
  const target = loadCase(model, op.caseId, op.caseType);
  for (const [index, load] of loads.entries()) {
    const id = `${op.id}:${index + 1}`;
    if (target.some(item => item.id === id)) throw new ModellingOperationError('OPERATION_ID_COLLISION', { collection: op.caseId, id });
    target.push({ ...load, id });
  }
}
function positionM(value: { fraction: number } | { distanceM: number }, length: number): number {
  const position = 'fraction' in value ? value.fraction * length : value.distanceM;
  if (position < 0 || position > length + 1e-8) throw new ModellingOperationError('OPERATION_LOAD_POSITION_INVALID', { position, length });
  return position;
}

/** Operations extend the builder contract, not the agent tool registry. Explicit records and IDs
 * remain first-class, and every expanded model still crosses the ordinary V2/physics boundary.
 */
export async function expandModellingOperations(input: ModelRecord, base?: ModelRecord): Promise<ModelRecord> {
  if (input.operations === undefined) return input;
  if (!Array.isArray(input.operations)) throw new ModellingOperationError('INVALID_MODELLING_OPERATIONS');
  const model = { ...structuredClone(base ?? {}), ...structuredClone(input) }; delete model.operations;
  for (const key of ['nodes', 'elements', 'materials', 'sections', 'load_cases', 'load_combinations']) model[key] ??= [];
  let dimension = isRecord(model.coordinate_system) ? model.coordinate_system.dimension : undefined;
  const ids = new Set<string>();
  for (const raw of input.operations) {
    const parsed = modellingOperationSchema.safeParse(raw);
    if (!parsed.success) throw new ModellingOperationError('INVALID_MODELLING_OPERATION', { issues: parsed.error.issues });
    const op = parsed.data;
    if (ids.has(op.id)) throw new ModellingOperationError('OPERATION_ID_COLLISION', { id: op.id });
    ids.add(op.id);
    if (op.op === 'regular-frame') {
      if (dimension && dimension !== op.dimension || op.dimension === '3d' && !op.bayWidthsY?.length) throw new ModellingOperationError('OPERATION_DIMENSION_CONFLICT', { dimension, operationDimension: op.dimension });
      dimension = op.dimension;
      const geometry = regularFrameGeometry({ ...op, prefix: `${op.id}:` });
      addRecords(model, 'nodes', geometry.nodes); addRecords(model, 'elements', geometry.elements); addRecords(model, 'stories', geometry.stories);
    } else if (op.op === 'truss-panels') {
      const geometry = trussPanelGeometry({ ...op, prefix: `${op.id}:` });
      addRecords(model, 'nodes', geometry.nodes); addRecords(model, 'elements', geometry.elements);
    } else if (op.op === 'polyline' || op.op === 'arc') {
      const geometry = op.op === 'polyline'
        ? polylineGeometry(op.points, op.segmentsPerEdge, `${op.id}:`, op.nodeIds, op.memberType)
        : arcGeometry(op.center, op.radius, op.startDegrees, op.endDegrees, op.segments, op.plane, `${op.id}:`, op.nodeIds, op.memberType);
      for (const element of geometry.elements) { if (op.material) element.material = op.material; if (op.section) element.section = op.section; }
      addRecords(model, 'nodes', geometry.nodes); addRecords(model, 'elements', geometry.elements);
    } else if (op.op === 'translate' || op.op === 'mirror') {
      for (const node of selected(rows(model.nodes), op.selector)) {
        if (op.op === 'translate') for (const [index, axis] of ['x', 'y', 'z'].entries()) node[axis] = Number(node[axis]) + op.vector[index]!;
        else node[op.axis] = 2 * op.offset - Number(node[op.axis]);
      }
    } else if (op.op === 'replicate') replicate(model, op);
    else if (op.op === 'merge-coincident') mergeCoincident(model, op.tolerance, op.preferredIds);
    else if (op.op === 'assign-properties') for (const element of selected(rows(model.elements), op.selector)) Object.assign(element, structuredClone(op.values));
    else if (op.op === 'assign-restraints') for (const node of selected(rows(model.nodes), op.selector)) node.restraints = [...op.restraints];
    else if (op.op === 'nodal-load') {
      if (op.reference_frame !== 'global') throw new ModellingOperationError('NODAL_LOAD_GLOBAL_AXES_REQUIRED');
      appendLoads(model, op, selected(rows(model.nodes), op.selector).map(node => ({ type: 'nodal', node: node.id, fx: op.vector[0], fy: op.vector[1], fz: op.vector[2], reference_frame: 'global' })));
    } else if (op.op === 'member-udl' || op.op === 'member-point-load') {
      appendLoads(model, op, selected(rows(model.elements), op.selector).map(element => {
        const { length } = memberGeometry(model, element);
        if (op.op === 'member-point-load') return { type: 'point', element: element.id, position: positionM(op.position, length), reference_frame: op.reference_frame,
          fx: op.vector[0], fy: op.vector[1], fz: op.vector[2] };
        const start = op.start ? positionM(op.start, length) : 0, end = op.end ? positionM(op.end, length) : length;
        if (end <= start) throw new ModellingOperationError('OPERATION_LOAD_POSITION_INVALID', { start, end });
        return { type: 'distributed', element: element.id, reference_frame: op.reference_frame, wx: op.vector[0], wy: op.vector[1], wz: op.vector[2], start, end };
      }));
    } else if (op.op === 'floor-to-beam') {
      const { data } = await createLocalStructureProtocolClient().post<{ loads: ModelRecord[]; totalKN: number }>('/expand-floor-load', {
        nodes: rows(model.nodes), elements: op.beamSelector ? selected(rows(model.elements), op.beamSelector) : rows(model.elements),
        z: op.z, bounds: op.bounds, pressureKNM2: op.pressureKNM2, distribution: op.distribution,
      }).catch(error => { throw new ModellingOperationError('FLOOR_LOAD_EXPANSION_FAILED', { error: String(error) }); });
      const total = appliedLoadTotals({ ...model, load_cases: [{ id: op.caseId, loads: data.loads }] })[op.caseId]!;
      if (Math.abs(total[2] + data.totalKN) > 1e-7 * Math.max(1, Math.abs(data.totalKN))) throw new ModellingOperationError('FLOOR_LOAD_NOT_CONSERVED', { expected: data.totalKN, actual: total });
      appendLoads(model, op, data.loads);
      model.metadata = { ...(isRecord(model.metadata) ? model.metadata : {}), floorLoadTransfers: [
        ...(isRecord(model.metadata) && Array.isArray(model.metadata.floorLoadTransfers) ? model.metadata.floorLoadTransfers : []),
        { operationId: op.id, caseId: op.caseId, pressureKNM2: op.pressureKNM2, distribution: op.distribution, totalKN: data.totalKN },
      ] };
    }
  }
  if (dimension !== '2d' && dimension !== '3d') throw new ModellingOperationError('OPERATION_DIMENSION_REQUIRED');
  model.coordinate_system = buildStructuralCoordinateSystem(dimension);
  model.metadata = { ...(isRecord(model.metadata) ? model.metadata : {}), modellingOperations: structuredClone(input.operations) };
  return model;
}

function replicate(model: ModelRecord, op: Extract<ModellingOperation, { op: 'replicate' }>) {
  const elements = selected(rows(model.elements), op.selector), nodeIds = new Set(elements.flatMap(element => element.nodes as string[]));
  const nodes = rows(model.nodes).filter(node => nodeIds.has(String(node.id)));
  const cases = structuredClone(rows(model.load_cases));
  for (let count = 1; count <= op.count; count++) {
    const prefix = `${op.id}:${count}:`;
    addRecords(model, 'nodes', nodes.map(node => ({ ...structuredClone(node), id: prefix + String(node.id),
      x: Number(node.x) + op.vector[0] * count, y: Number(node.y) + op.vector[1] * count, z: Number(node.z) + op.vector[2] * count })));
    addRecords(model, 'elements', elements.map(element => ({ ...structuredClone(element), id: prefix + String(element.id), nodes: (element.nodes as string[]).map(id => prefix + id) })));
    if (op.copyLoads) for (const loadCaseRecord of cases) {
      const cloned = rows(loadCaseRecord.loads).filter(load => nodeIds.has(String(load.node)) || elements.some(element => element.id === load.element))
        .map(load => ({ ...load, ...(load.node !== undefined ? { node: prefix + String(load.node) } : { element: prefix + String(load.element) }) }));
      appendLoads(model, { id: prefix, caseId: String(loadCaseRecord.id), caseType: String(loadCaseRecord.type ?? 'other') }, cloned);
    }
  }
}

function mergeCoincident(model: ModelRecord, tolerance: number, preferredIds: string[]) {
  const nodes = rows(model.nodes), retained: ModelRecord[] = [], aliases = new Map<string, string>();
  const ordered = [...nodes].sort((a, b) => Number(preferredIds.includes(String(b.id))) - Number(preferredIds.includes(String(a.id))));
  for (const node of ordered) {
    const match = retained.find(other => Math.hypot(...coordinates(node).map((value, i) => value - coordinates(other)[i]!)) <= tolerance);
    if (!match) { retained.push(node); continue; }
    if (preferredIds.includes(String(node.id)) && preferredIds.includes(String(match.id))) throw new ModellingOperationError('USER_TOPOLOGY_ID_CONFLICT', { ids: [node.id, match.id] });
    aliases.set(String(node.id), String(match.id));
    if (Array.isArray(node.restraints)) match.restraints = node.restraints.map((value, i) => value === true || Array.isArray(match.restraints) && match.restraints[i] === true);
  }
  model.nodes = nodes.filter(node => !aliases.has(String(node.id)));
  for (const element of rows(model.elements)) element.nodes = (element.nodes as string[]).map(id => aliases.get(id) ?? id);
  for (const loadCaseRecord of rows(model.load_cases)) for (const load of rows(loadCaseRecord.loads)) if (load.node !== undefined) load.node = aliases.get(String(load.node)) ?? load.node;
  model.metadata = { ...(isRecord(model.metadata) ? model.metadata : {}), mergedNodeAliases: Object.fromEntries(aliases) };
}

export function assertUserTopologyIds(model: ModelRecord, source: { nodes?: unknown; members?: unknown } | undefined, preserveValues = true): void {
  const missingNodes = rows(source?.nodes).filter(node => !rows(model.nodes).some(candidate => candidate.id === node.id)).map(node => node.id);
  const missingMembers = rows(source?.members).filter(member => member.id && !rows(model.elements).some(candidate => candidate.id === member.id)).map(member => member.id);
  if (missingNodes.length || missingMembers.length) throw new ModellingOperationError('USER_TOPOLOGY_IDS_NOT_PRESERVED', { missingNodes, missingMembers });
  if (preserveValues) for (const [collection, originals, fields] of [
    ['nodes', rows(source?.nodes), ['x', 'y', 'z', 'restraints']],
    ['elements', rows(source?.members), ['nodes', 'type', 'material', 'section', 'rotation_angle', 'releases']],
  ] as const) for (const original of originals) {
    if (!original.id) continue;
    const candidate = rows(model[collection]).find(record => record.id === original.id)!;
    for (const field of fields) if (original[field] !== undefined && JSON.stringify(original[field]) !== JSON.stringify(candidate[field])) {
      throw new ModellingOperationError('USER_TOPOLOGY_VALUE_CHANGED', { id: original.id, field, expected: original[field], actual: candidate[field] });
    }
  }
}
