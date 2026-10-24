import { z } from 'zod';
import { isRecord, type ModelRecord } from './model-state.js';

const number = z.number().finite(), id = z.string().trim().min(1);
const coordinate = z.object({ axis: z.enum(['x', 'y', 'z']), at: z.enum(['midpoint', 'start', 'end']).optional(),
  eq: number.optional(), gt: number.optional(), gte: number.optional(), lt: number.optional(), lte: number.optional(),
}).strict();
export const modelSelectorSchema = z.object({
  ids: z.array(id).min(1).optional(), type: id.optional(), story: id.optional(), prefix: z.string().optional(),
  parallelTo: z.enum(['x', 'y', 'z']).optional().describe('Member global-axis alignment / 构件平行的全局轴'),
  coordinate: coordinate.optional().describe('Node coordinates; members use endpoint midpoint by default / 节点坐标；构件默认取端点中点'),
  coordinates: z.array(coordinate).min(1).optional().describe('All coordinate predicates must match / 全部坐标条件须同时满足'),
}).strict();
export type ModelSelector = z.infer<typeof modelSelectorSchema>;
export const isGlobalFrameNodeRole = (value: unknown): boolean => value === 'all-non-base-nodes' || value === 'all-top-nodes';

/** Resolve the structured node-role protocol against coordinates, never prose. */
export function selectNodeRole(nodes: ModelRecord[], role: string, story?: number): ModelRecord[] {
  const levels = [...new Set(nodes.map(node => Number(node.z)))].sort((a, b) => a - b);
  const level = story !== undefined ? levels[story] : undefined;
  const candidates = role === 'all-non-base-nodes' ? nodes.filter(node => Number(node.z) > levels[0]!)
    : role === 'all-top-nodes' ? nodes.filter(node => Number(node.z) === levels[levels.length - 1])
      : level === undefined ? [] : nodes.filter(node => Number(node.z) === level);
  const pool = story === undefined ? candidates : candidates.filter(node => Number(node.z) === level);
  if (role === 'all' || isGlobalFrameNodeRole(role)) return pool;
  const xs = [...new Set(pool.map(node => Number(node.x)))].sort((a, b) => a - b);
  const ys = [...new Set(pool.map(node => Number(node.y)))].sort((a, b) => a - b);
  const grid = role.match(/^(?:corner-|node-)?x(\d+)y(\d+)$/);
  let xIndex: number | undefined, yIndex: number | undefined;
  if (grid) { xIndex = Number(grid[1]); yIndex = Number(grid[2]); }
  else if (ys.length === 1) {
    yIndex = 0;
    if (['right', 'right-side', 'right-end', 'end', '右侧', '右端'].includes(role)) xIndex = xs.length - 1;
    else if (['left', 'left-side', 'left-end', 'start', '左侧', '左端'].includes(role)) xIndex = 0;
    else if (['middle', 'center', 'centre', 'middle-node', 'center-node', '中间', '中央'].includes(role)) xIndex = Math.floor((xs.length - 1) / 2);
  }
  return pool.filter(node => Number(node.x) === xs[xIndex ?? -1] && Number(node.y) === ys[yIndex ?? -1]);
}
export const modelSelectorContract = z.toJSONSchema(modelSelectorSchema);
export const floorTransferSchema = z.object({ distribution: z.enum(['one-way-x', 'one-way-y', 'two-way'])
  .describe('Slab spanning direction: one-way-x transfers to constant-X edges (Y-parallel beams); one-way-y to constant-Y edges (X-parallel beams). / 板跨向：X跨传给Y向梁，Y跨传给X向梁；不得混同跨向与受荷梁方向。'),
  bounds: z.object({ x: z.tuple([number, number]), y: z.tuple([number, number]) }).strict(),
}).strict();
export const floorTransferContract = z.toJSONSchema(floorTransferSchema);
export const modelLoadMappingsSchema = z.array(z.object({ loadId: id, selector: modelSelectorSchema,
  transferId: id.optional().describe('For an area source, exact floor-to-beam operation ID; required to independently verify the transfer / 面荷载必须绑定准确的floor-to-beam操作ID'),
  caseId: id.optional().describe('Bind an unassigned source load to an existing model case; never replace a confirmed case ID / 仅绑定未指定工况的源荷载，不得替换已确认工况ID'),
}).strict());

/** Generated identifiers belong in selector.ids, never in the source-load identity. */
export function modelLoadMappingsContract(loadIds: string[]) {
  return z.toJSONSchema(z.array(modelLoadMappingsSchema.element.extend({ loadId: z.enum(loadIds) })));
}

/** Node positions and member endpoint geometry use the same explicit selector contract. */
export function selectRecords(records: ModelRecord[], selector: ModelSelector, model?: ModelRecord): ModelRecord[] {
  const nodes = Array.isArray(model?.nodes) ? model.nodes.filter(isRecord) : [];
  return records.filter(record => {
    if (selector.ids && !selector.ids.includes(String(record.id)) || selector.type && record.type !== selector.type
      || selector.story && record.story !== selector.story || selector.prefix && !String(record.id).startsWith(selector.prefix)) return false;
    const ends = Array.isArray(record.nodes) && record.nodes.length === 2
      ? record.nodes.map(id => nodes.find(node => node.id === id)) : undefined;
    if (selector.parallelTo) {
      if (!ends?.[0] || !ends[1]) return false;
      const delta = ['x', 'y', 'z'].map(axis => Number(ends[1]![axis]) - Number(ends[0]![axis]));
      const axis = ['x', 'y', 'z'].indexOf(selector.parallelTo), length = Math.hypot(...delta);
      if (!Number.isFinite(length) || length < 1e-9 || delta.some((value, index) => index !== axis && Math.abs(value) > length * 1e-8)) return false;
    }
    return [...(selector.coordinate ? [selector.coordinate] : []), ...(selector.coordinates ?? [])].every(coordinate => {
      const a = ends?.[0]?.[coordinate.axis], b = ends?.[1]?.[coordinate.axis];
      const value = ends ? a === undefined || b === undefined ? NaN
        : coordinate.at === 'start' ? Number(a) : coordinate.at === 'end' ? Number(b) : (Number(a) + Number(b)) / 2
        : Number(record[coordinate.axis]);
      return Number.isFinite(value) && (coordinate.eq === undefined || Math.abs(value - coordinate.eq) < 1e-8)
        && (coordinate.gt === undefined || value > coordinate.gt + 1e-8) && (coordinate.gte === undefined || value >= coordinate.gte - 1e-8)
        && (coordinate.lt === undefined || value < coordinate.lt - 1e-8) && (coordinate.lte === undefined || value <= coordinate.lte + 1e-8);
    });
  });
}
