import { z } from 'zod';
import { modelSelectorSchema as selector } from '../../engineering/model-selection.js';

const number = z.number().finite(), positive = number.positive(), id = z.string().trim().min(1);
const vector = z.tuple([number, number, number]);
const segments = z.number().int().min(1).max(1000);
const memberType = z.enum(['beam', 'column', 'truss', 'brace']);
const base = { id };
const properties = { material: id.optional(), section: id.optional(), type: memberType.optional(), rotation_angle: number.optional(),
  releases: z.record(z.string(), z.unknown()).optional(), design: z.record(z.string(), z.unknown()).optional() };
const load = { ...base, selector, caseId: id, caseType: z.enum(['dead', 'live', 'wind', 'seismic', 'other']).default('other'), vector,
  reference_frame: z.enum(['global', 'element-local']).default('global') };
const position = z.union([z.object({ fraction: number.min(0).max(1) }).strict(), z.object({ distanceM: number.nonnegative() }).strict()]);

export const modellingOperationSchema = z.discriminatedUnion('op', [
  z.object({ ...base, op: z.literal('regular-frame'), dimension: z.enum(['2d', '3d']), bayWidthsX: z.array(positive).min(1), bayWidthsY: z.array(positive).min(1).optional(),
    storeyHeights: z.array(positive).min(1), baseRestraint: z.enum(['fixed', 'pinned']), origin: vector.optional(), nodeIds: z.record(z.string(), id).optional()
      .describe('Map "levelIndex,xIndex,yIndex" to exact node IDs. All indices are zero-based: level 0 is the base, level 1 the first elevated floor; the roof level equals storeyHeights.length. 2D still uses yIndex=0. / 节点映射键为"层索引,X索引,Y索引"，均从0起；层0为基底，层1为首个楼层，屋面层索引等于层高数组长度；二维仍写Y索引0。'),
    material: id.optional(), columnSection: id.optional(), beamSection: id.optional(), memberIds: z.record(z.string(), id).optional(),
    storyIds: z.record(z.string(), id).optional() }).strict(),
  z.object({ ...base, op: z.literal('truss-panels'), span: positive, height: positive, panels: segments,
    topology: z.enum(['pratt', 'howe', 'warren', 'trapezoidal', 'generic']), origin: vector.optional(), material: id.optional(), section: id.optional() }).strict(),
  z.object({ ...base, op: z.literal('polyline'), points: z.array(vector).min(2), segmentsPerEdge: segments.default(1), nodeIds: z.record(z.string(), id).optional(),
    memberType: memberType.default('beam'), material: id.optional(), section: id.optional() }).strict(),
  z.object({ ...base, op: z.literal('arc'), center: vector, radius: positive, startDegrees: number, endDegrees: number, segments, plane: z.enum(['xz', 'xy', 'yz']),
    nodeIds: z.record(z.string(), id).optional(), memberType: memberType.default('beam'), material: id.optional(), section: id.optional() }).strict(),
  z.object({ ...base, op: z.literal('translate'), selector, vector }).strict(),
  z.object({ ...base, op: z.literal('mirror'), selector, axis: z.enum(['x', 'y', 'z']), offset: number.default(0) }).strict(),
  z.object({ ...base, op: z.literal('replicate'), selector, count: segments.describe('Additional copies, excluding the original / 不含原件的新增副本数'), vector, copyLoads: z.boolean().default(false) }).strict(),
  z.object({ ...base, op: z.literal('merge-coincident'), tolerance: positive.default(1e-8), preferredIds: z.array(id).default([]) }).strict(),
  z.object({ ...load, op: z.literal('nodal-load') }).strict(),
  z.object({ ...load, op: z.literal('member-udl'), start: position.optional(), end: position.optional() }).strict(),
  z.object({ ...load, op: z.literal('member-point-load'), position }).strict(),
  z.object({ ...base, op: z.literal('floor-to-beam'), caseId: id, caseType: z.enum(['dead', 'live', 'other']).default('other'),
    z: number, bounds: z.object({ x: z.tuple([number, number]), y: z.tuple([number, number]) }).strict(), pressureKNM2: number,
    distribution: z.enum(['one-way-x', 'one-way-y', 'two-way'])
      .describe('Slab span, not support-beam axis: X span loads Y beams; Y span loads X beams. / 指板跨向：X跨传给Y向梁，Y跨传给X向梁。'), beamSelector: selector.optional() }).strict(),
  z.object({ ...base, op: z.literal('assign-properties'), target: z.literal('elements'), selector, values: z.object(properties).strict() }).strict(),
  z.object({ ...base, op: z.literal('assign-restraints'), selector, restraints: z.tuple([z.boolean(), z.boolean(), z.boolean(), z.boolean(), z.boolean(), z.boolean()]) }).strict(),
]);
export type ModellingOperation = z.infer<typeof modellingOperationSchema>;
export type ModelSelector = z.infer<typeof selector>;
export const modellingOperationsContract = z.toJSONSchema(z.array(modellingOperationSchema));

export class ModellingOperationError extends Error {
  constructor(readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(JSON.stringify({ success: false, errorCode: code, error: 'Modelling operations could not preserve a valid physical model. / 建模操作未能生成并保留有效物理模型。', details }));
    this.name = 'ModellingOperationError';
  }
}
