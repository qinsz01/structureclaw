import type { EngineeringDraft } from '../shared/types/agent.js';
import { createLocalStructureProtocolClient, type LocalStructureProtocolClient } from '../skill-shared/structure-protocol-execution.js';
import { checkModelPhysics, appliedLoadTotals, compileConfirmedModelLoads, LoadMappingError, type ExpandedAreaLoads } from './model-physics.js';
import { isRecord, type ModelRecord } from './model-state.js';
import { modelLoadMappingsSchema, selectRecords } from './model-selection.js';

const rows = (value: unknown): ModelRecord[] => Array.isArray(value) ? value.filter(isRecord) : [];

/** Recompute each explicitly bound area load from source pressure and physical panel geometry.
 * Model-authored transfer totals/receipts are never accepted as verification evidence.
 */
export async function checkModelPhysicsWithAreaLoads(model: ModelRecord, draft?: EngineeringDraft,
  client: LocalStructureProtocolClient = createLocalStructureProtocolClient()) {
  const sources = draft?.loads?.filter(load => load.unit === 'kN/m2') ?? [];
  if (!sources.length) return checkModelPhysics(model, draft);
  try {
    return checkModelPhysics(model, draft, await expandDeclaredAreaLoads(model, draft!, client));
  } catch (error) {
    const checked = checkModelPhysics(model);
    return { ...checked, valid: false, diagnostics: [...checked.diagnostics, { code: 'AREA_LOAD_BINDING_INVALID', severity: 'error' as const,
      entityIds: sources.flatMap(load => load.id ? [load.id] : []), details: { ...(error instanceof LoadMappingError ? error.details : {}), error: String(error) },
      message: { en: 'Cannot independently verify the declared floor pressure transfer. Bind each source load to its exact floor-to-beam operation and preserve its pressure, full-floor scope and case.',
        zh: '无法独立核对楼面面荷载传递。请将每条源荷载绑定准确的floor-to-beam操作，并保留原压力、整层范围及工况。' } }] };
  }
}

export async function compileDeclaredModelLoads(model: ModelRecord, draft: EngineeringDraft) {
  return compileConfirmedModelLoads(model, draft,
    await expandDeclaredAreaLoads(model, draft, createLocalStructureProtocolClient()));
}

async function expandDeclaredAreaLoads(model: ModelRecord, draft: EngineeringDraft, client: LocalStructureProtocolClient): Promise<ExpandedAreaLoads> {
    const sources = draft.loads?.filter(load => load.unit === 'kN/m2') ?? [];
    if (!sources.length) return new Map();
    const mappings = modelLoadMappingsSchema.parse(isRecord(model.metadata) ? model.metadata.loadMappings : undefined);
    const operations = rows(isRecord(model.metadata) ? model.metadata.modellingOperations : undefined);
    const nodes = rows(model.nodes), elements = rows(model.elements);
    const expanded: ExpandedAreaLoads = new Map();
    const used = new Set<string>();
    for (const source of sources) {
      const bindings = mappings.filter(mapping => mapping.loadId === source.id);
      const fail = (reason: string, details: ModelRecord = {}): never => { throw new LoadMappingError('AREA_LOAD_BINDING_INVALID', [source.id ?? '?'], {
        loadId: source.id, reason, binding: bindings[0], ...details,
        availableStories: rows(model.stories).map(row => ({ id: row.id, height: row.height, elevation: row.elevation })),
        availableBeams: elements.filter(row => row.type === 'beam').slice(0, 40).map(row => ({ id: row.id, story: row.story,
          endpoints: Array.isArray(row.nodes) ? row.nodes.map(id => { const node = nodes.find(node => node.id === id); return node ? { id, x: node.x, y: node.y, z: node.z } : { id }; }) : [] })),
      }, { en: `Invalid source floor transfer: ${reason}. Correct the source mapping against the actual geometry; do not guess aliases.`,
        zh: `源面荷载传递无效：${reason}。请按实际几何修正源荷载映射，不猜测别名。` }); };
      if (bindings.length !== 1 || !bindings[0]!.transferId) fail('one explicit transferId is required / 需唯一明确的传荷操作ID');
      const mapping = bindings[0]!, transfers = operations.filter(op => op.id === mapping.transferId && op.op === 'floor-to-beam');
      if (transfers.length !== 1 || used.has(mapping.transferId!)) fail('transferId must identify one distinct floor-to-beam operation / 传荷操作须唯一且不重复');
      const transfer = transfers[0]!;
      if (!source.floorTransfer) fail('source floorTransfer.distribution and bounds must be explicitly confirmed / 原面荷载需已确认的floorTransfer传荷方向及范围');
      if (transfer.distribution !== source.floorTransfer!.distribution) fail('confirmed transfer direction changed / 已确认传荷方向被改变');
      used.add(mapping.transferId!);
      const caseId = source.caseId ?? mapping.caseId ?? fail('explicit caseId required / 需明确工况');
      if (transfer.caseId !== caseId || mapping.caseId && mapping.caseId !== caseId) fail('confirmed case identity changed / 工况绑定不一致');
      if (!['gravity', 'globalZ'].includes(String(source.direction))) fail('only explicitly vertical floor pressures are supported / 仅支持明确竖向楼面压力');
      const pressure = source.magnitude * (source.direction === 'gravity' ? 1 : -1);
      if (transfer.pressureKNM2 !== pressure) fail('source pressure changed / 原面荷载数值或方向被改变');
      const targets = selectRecords(elements, mapping.selector, model);
      if (!targets.length || mapping.selector.ids?.some(id => !targets.some(row => row.id === id))) fail('source mapping selects no complete support group / 源荷载映射未选中完整支承分组');
      if (isRecord(transfer.beamSelector)) {
        const selected = selectRecords(elements, transfer.beamSelector, model);
        const identities = (group: ModelRecord[]) => JSON.stringify(group.map(row => String(row.id)).sort());
        if (identities(selected) !== identities(targets)) fail('source mapping.selector and transfer.beamSelector select different support groups; fix the conflicting selectors / 源映射与传荷操作选中了不同支承分组，须修正冲突选择器', {
          sourceTargetIds: targets.map(row => row.id), transferTargetIds: selected.map(row => row.id), transferSelector: transfer.beamSelector,
        });
      }
      const heights = draft.geometry?.storyHeightsM;
      if (!heights?.length) fail('declared storey heights required / 需已声明的逐层层高');
      const base = Math.min(...nodes.map(node => Number(node.z)));
      const levels = heights!.map((_, index) => base + heights!.slice(0, index + 1).reduce((sum, height) => sum + height, 0));
      let z: number;
      if (source.location?.story !== undefined) {
        const story = source.location.story;
        if (!Number.isInteger(story) || story < 1 || story > levels.length
          || source.target !== 'floor' && !source.scopeDescription && !source.selector) fail('full floor and valid one-based storey scope required / 需明确整层楼面及有效层号');
        z = levels[story - 1]!;
      } else {
        // The LLM's explicit geometry binding resolves a confirmed semantic
        // scope. Do not interpret its prose, invent a roof alias or default to
        // every floor. All selected support endpoints must identify one
        // declared storey and the separately authored transfer must agree.
        if (!source.scopeDescription && !source.selector) fail('confirmed floor scope required; no implicit floor / 需已确认楼面范围，不默认楼层');
        const elevations = targets.flatMap(element => Array.isArray(element.nodes) ? element.nodes.map(id => Number(nodes.find(node => node.id === id)?.z)) : []);
        if (!elevations.length || elevations.some(value => !Number.isFinite(value) || Math.abs(value - elevations[0]!) > 1e-8)
          || !levels.some(level => Math.abs(level - elevations[0]!) <= 1e-8)) fail('binding must select support beams on exactly one declared storey / 绑定必须选中同一已声明楼层的支承梁');
        z = elevations[0]!;
      }
      if (typeof transfer.z !== 'number' || Math.abs(transfer.z - z) > 1e-8) fail('floor elevation differs from confirmed storey / 楼层标高不一致');
      const rawBounds = isRecord(transfer.bounds) ? transfer.bounds : fail('explicit rectangular bounds required / 需明确矩形范围');
      const range = (axis: string): [number, number] => {
        const values = nodes.map(node => Number(node[axis]));
        const extent = [Math.min(...values), Math.max(...values)];
        const expected = source.floorTransfer!.bounds[axis as 'x' | 'y'];
        if (expected.some((value, index) => Math.abs(value - extent[index]!) > 1e-8)) return fail('source must identify a complete floor / 源范围须为完整楼面');
        const actual = rawBounds[axis];
        if (!Array.isArray(actual) || actual.length !== 2 || actual.some((value, index) => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value - expected[index]!) > 1e-8)) return fail('transfer must cover the confirmed full floor / 传荷范围须覆盖已确认整层楼面');
        return actual as [number, number];
      };
      const bounds = { x: range('x'), y: range('y') };
      if (!['one-way-x', 'one-way-y', 'two-way'].includes(String(transfer.distribution))) fail('explicit transfer direction required / 需明确传荷方向');
      const { data } = await client.post<{ loads: ModelRecord[]; totalKN: number }>('/expand-floor-load', {
        nodes, elements: targets, z, bounds, pressureKNM2: pressure, distribution: transfer.distribution,
      });
      const expectedTotal = pressure * (bounds.x[1] - bounds.x[0]) * (bounds.y[1] - bounds.y[0]);
      const actual = appliedLoadTotals({ ...model, load_cases: [{ id: caseId, loads: data.loads }] })[caseId]!;
      if (Math.abs(actual[2] + expectedTotal) > 1e-7 * Math.max(1, Math.abs(expectedTotal))) fail('recomputed transfer does not conserve pressure times area / 重算传荷不满足面荷载合力守恒');
      expanded.set(source.id!, { caseId, loads: data.loads });
    }
    return expanded;
}
