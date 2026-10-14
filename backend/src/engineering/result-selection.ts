import { z } from 'zod';
import { isRecord } from './model-state.js';

/** Shared location/index contract. A selection describes a saved result; it never mutates it. */
export const resultSelectionSchema = z.object({
  runId: z.string().optional(), resultKey: z.string().optional(),
  nodeId: z.string().optional().describe('Stable model node ID; choose a nodal field such as reactions or displacements. Exclusive with elementId. / 稳定节点ID，配合reactions或displacements等节点结果字段，与elementId互斥。'),
  elementId: z.string().optional().describe('Physical member ID. Static member queries require positionM, even for forces or segmentResults; time-history forces require end. No model remeshing is needed to query an interior position. / 物理构件ID，静力查询必须带positionM（包括forces或segmentResults），时程内力必须带end。查询跨内位置不需要修改或细分模型。'),
  modeNumber: z.number().int().positive().optional(), timeIndex: z.number().int().nonnegative().optional(),
  positionM: z.number().nonnegative().optional().describe('Required for a static elementId: distance in m from the physical member first node, not a normalized fraction. / 静力elementId必需：距物理构件首节点的米数，不是比例。'),
  side: z.enum(['left', 'right']).optional().describe('Cut side at the requested position. Default right; use left at the member final end and specify the desired side at load jumps. / 截面左右侧，默认right；构件末端用left，集中荷载处明确所需侧。'),
  end: z.enum(['n1', 'n2']).optional().describe('Recorded physical end for time-history member forces only; static end queries use positionM=0 or member length. / 仅用于时程内力的已记录物理构件端；静力端部用positionM=0或构件长度。'),
  component: z.enum(['ux','uy','uz','rx','ry','rz','fx','fy','fz','mx','my','mz','N','V2','V3','T','M2','M3']).optional().describe('Scalar query requires an explicit unit and nodeId or elementId+positionM (dynamic: end). Querying a component saves its run-bound quantity for reports. / 标量查询须同时给单位和节点或构件位置（时程构件给end）；指定分量后保存绑定运行的数值供报告使用。'),
  unit: z.enum(['m','mm','rad','kN','N','kN.m','N.m','m/s','mm/s','rad/s','m/s2','mm/s2','rad/s2','1']).optional().describe('Required with component: m/mm for translation, rad for rotation, kN/N for force, kN.m/N.m for moment, 1 for normalized modal translation. / component必需：平移m/mm、转角rad、力kN/N、力矩kN.m/N.m、归一化平动振型1。'),
  field: z.enum(['displacements', 'velocities', 'accelerations', 'forces', 'reactions', 'solverMesh', 'segmentResults', 'summary', 'modal', 'modes', 'timeHistory', 'memberResponses', 'memberResponseExtrema']).optional().describe('Result collection. Omit object IDs to inspect a full collection; supplying static elementId requests a physical section and therefore requires positionM. / 结果集合。不带对象ID可查看整个集合；带静力elementId则查询物理截面，必须给positionM。'),
});
export type ResultSelection = z.infer<typeof resultSelectionSchema>;

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
