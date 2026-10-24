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
export const modelSelectorContract = z.toJSONSchema(modelSelectorSchema);
export const modelLoadMappingsSchema = z.array(z.object({ loadId: id, selector: modelSelectorSchema,
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
