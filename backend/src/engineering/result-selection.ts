import { z } from 'zod';
import { isRecord } from './model-state.js';

/** Shared location/index contract. A selection describes a saved result; it never mutates it. */
export const resultSelectionSchema = z.object({
  runId: z.string().optional(), resultKey: z.string().optional(),
  nodeId: z.string().optional().describe('Physical model node ID present in the selected nodal result field. Solver-internal node IDs from solverMesh are not nodal result IDs; query interior displacement/force with elementId + positionM instead. Exclusive with elementId. / 指定节点结果字段中的物理模型节点ID。solverMesh内部节点ID不是节点结果ID；跨内位移和内力请用elementId + positionM查询，与elementId互斥。'),
  elementId: z.string().optional().describe('Physical member ID. Static member queries require positionM, even for forces or segmentResults; time-history forces require end. No model remeshing is needed to query an interior position. / 物理构件ID，静力查询必须带positionM（包括forces或segmentResults），时程内力必须带end。查询跨内位置不需要修改或细分模型。'),
  modeNumber: z.number().int().positive().optional(), timeIndex: z.number().int().nonnegative().optional(),
  positionM: z.number().nonnegative().optional().describe('Required for a static elementId: distance in m from the physical member first node, not a normalized fraction. / 静力elementId必需：距物理构件首节点的米数，不是比例。'),
  side: z.enum(['left', 'right']).optional().describe('Cut side at the requested position. Default right; use left at the member final end and specify the desired side at load jumps. / 截面左右侧，默认right；构件末端用left，集中荷载处明确所需侧。'),
  end: z.enum(['n1', 'n2']).optional().describe('Recorded physical end for time-history member forces only; static end queries use positionM=0 or member length. / 仅用于时程内力的已记录物理构件端；静力端部用positionM=0或构件长度。'),
  component: z.enum(['ux','uy','uz','rx','ry','rz','fx','fy','fz','mx','my','mz','N','V2','V3','T','M2','M3']).optional().describe('Scalar query requires an explicit unit and nodeId or elementId+positionM (dynamic: end). Querying a component saves its run-bound quantity for reports. / 标量查询须同时给单位和节点或构件位置（时程构件给end）；指定分量后保存绑定运行的数值供报告使用。'),
  unit: z.enum(['m','mm','rad','kN','N','kN.m','N.m','m/s','mm/s','rad/s','m/s2','mm/s2','rad/s2','1']).optional().describe('Required with component: m/mm for translation, rad for rotation, kN/N for force, kN.m/N.m for moment, 1 for normalized modal translation. / component必需：平移m/mm、转角rad、力kN/N、力矩kN.m/N.m、归一化平动振型1。'),
  field: z.enum(['displacements', 'velocities', 'accelerations', 'forces', 'reactions', 'solverMesh', 'segmentResults', 'summary', 'modal', 'modes', 'timeHistory', 'memberResponses', 'memberResponseExtrema']).optional().describe('Result collection. Omit object IDs to inspect a full collection. solverMesh describes internal discretization, not additional queryable nodal results. Static interior displacement/force queries use physical elementId + positionM. / 结果集合。不带对象ID可查看整个集合。solverMesh仅描述内部离散，不代表额外的节点结果；静力跨内位移和内力用物理elementId + positionM查询。'),
});
export type ResultSelection = z.infer<typeof resultSelectionSchema>;

/** Explain the public result locations without relabeling internal solver nodes. */
export function solverMeshQueryGuidance(data: Record<string, unknown>) {
  const mesh = isRecord(data.solverMesh) ? data.solverMesh : undefined;
  if (!mesh) return undefined;
  const segments = Array.isArray(mesh.elements) ? mesh.elements.filter(isRecord) : [];
  const nodes = Array.isArray(mesh.nodes) ? mesh.nodes.filter(isRecord) : [];
  const internalNodeIds = nodes.filter(node => node.physicalNodeId === null && typeof node.id === 'string').map(node => node.id as string);
  type MemberPosition = { elementId: string; positionM: number; side: 'left' | 'right' };
  const positionsByNode = new Map(internalNodeIds.map(id => [id, new Map<string, MemberPosition>()]));
  if (mesh.positionUnit === 'm') for (const segment of segments) {
    if (typeof segment.physicalElementId !== 'string' || !Array.isArray(segment.nodes)) continue;
    for (const [index, key, side] of [[0, 'start', 'right'], [1, 'end', 'left']] as const) {
      const nodeId = segment.nodes[index];
      const positions = typeof nodeId === 'string' ? positionsByNode.get(nodeId) : undefined;
      const positionM = segment[key];
      if (!positions || typeof positionM !== 'number' || !Number.isFinite(positionM) || positionM < 0) continue;
      const selection = { elementId: segment.physicalElementId, positionM, side };
      positions.set(JSON.stringify(selection), selection);
    }
  }
  const internalNodeLocations = internalNodeIds.map(solverNodeId => ({ solverNodeId, queryableAsNode: false,
    memberPositions: [...positionsByNode.get(solverNodeId)!.values()] }));
  return {
    instruction: 'solverMesh is internal solver topology. Only IDs present in the selected nodal field can be used as nodeId. For an interior displacement or force, use physical elementId + positionM and the required component/unit; select the cut side explicitly at load jumps. Do not remesh or use solver-internal node IDs. / solverMesh是求解器内部拓扑，nodeId只能使用指定节点结果字段已有的ID。跨内位移或内力请用物理elementId + positionM及所需分量、单位，荷载突变处明确截面侧别；无需重新划分网格，也不要用求解器内部节点ID。',
    nodeIdsByField: Object.fromEntries(['displacements', 'reactions', 'velocities', 'accelerations']
      .filter(field => isRecord(data[field])).map(field => [field, Object.keys(data[field] as Record<string, unknown>)])),
    internalNodeLocations,
  };
}

export function selectedSavedResult(run: Record<string, unknown>, key?: string) {
  const resultKey = key ?? (typeof run.selectedResultKey === 'string' ? run.selectedResultKey : undefined);
  if (isRecord(run.results)) {
    const selected = resultKey ? run.results[resultKey] : undefined;
    if (!isRecord(selected)) throw new Error('RESULT_NOT_FOUND');
    return { resultKey, selected };
  }
  if (key && key !== run.selectedResultKey) throw new Error('RESULT_NOT_FOUND');
  return { resultKey, selected: run };
}

export function resultCatalogEntry(run: Record<string, unknown>, current: boolean) {
  const results = isRecord(run.results) ? Object.entries(run.results) : [[String(run.selectedResultKey ?? 'default'), run]] as const;
  const model = isRecord(run.modelSnapshot) ? run.modelSnapshot : {};
  const meta = isRecord(run.meta) ? run.meta : {};
  const data = isRecord(run.data) ? run.data : {};
  const analysisType = [run.analysis_type, run.analysisType, run.type, meta.analysisType, meta.analysis_type, data.analysisType, data.analysis_type]
    .find(value => ['static', 'dynamic', 'seismic', 'nonlinear'].includes(String(value)))
    ?? (Array.isArray(data.timeHistory) || Array.isArray(data.modes) || isRecord(data.modal) ? 'dynamic' : 'static');
  return { runId: run.runId, current, selectedResultKey: run.selectedResultKey, meta: run.meta,
    analysisType,
    nodes: Array.isArray(model.nodes) ? model.nodes.filter(isRecord).map(node => String(node.id)) : [],
    members: Array.isArray(model.elements) ? model.elements.filter(isRecord).map(element => String(element.id)) : [],
    results: results.map(([key, value]) => {
      const selected = isRecord(value) ? value : {};
      const data = isRecord(selected.data) ? selected.data : selected;
      const modes = Array.isArray(data.modes) ? data.modes : isRecord(data.modal) && Array.isArray(data.modal.modes) ? data.modal.modes : [];
      const history = Array.isArray(data.timeHistory) ? data.timeHistory : [];
      return { key, selection: selected.selection, available: selected.success !== false && selected.executionStatus !== 'failed',
        modes: modes.filter(isRecord).map(mode => ({ modeNumber: mode.modeNumber, period: mode.period, frequency: mode.frequency })),
        times: history.map((row, index) => ({ index, time: isRecord(row) ? row.time : null })),
        responseDefinition: data.responseDefinition };
    }) };
}

/** Reports may include only the queried quantities belonging to this exact location and index. */
export function quantityMatchesSelection(quantity: Record<string, unknown>, selection: ResultSelection, runId: unknown, key: unknown) {
  if (quantity.runId !== runId || quantity.selection !== key) return false;
  if (quantity.timeIndex !== selection.timeIndex || quantity.modeNumber !== selection.modeNumber) return false;
  if (selection.component && (quantity.component !== selection.component || quantity.unit !== selection.unit || quantity.field !== selection.field)) return false;
  const location = isRecord(quantity.location) ? quantity.location : {};
  if (selection.nodeId && (location.kind !== 'node' || location.id !== selection.nodeId)) return false;
  if (selection.elementId && (location.kind !== 'member' || location.id !== selection.elementId
    || location.end !== selection.end || (selection.end === undefined && (location.positionM !== selection.positionM || location.side !== (selection.side ?? 'right'))))) return false;
  return true;
}
