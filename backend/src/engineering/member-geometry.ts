import { isRecord, type ModelRecord } from './model-state.js';

export type Vector3 = [number, number, number];
export const dot = (a: Vector3, b: Vector3): number => a.reduce((sum, value, index) => sum + value * b[index]!, 0);
export const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const scale = (a: Vector3, value: number): Vector3 => a.map(component => component * value) as Vector3;
export const subtract = (a: Vector3, b: Vector3): Vector3 => a.map((value, index) => value - b[index]!) as Vector3;
export const coordinates = (node: ModelRecord): Vector3 => [Number(node.x), Number(node.y), Number(node.z)];
export function unit(vector: Vector3): Vector3 {
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length < 1e-10) throw new Error('INVALID_MEMBER_AXES / 构件局部轴无效');
  return scale(vector, 1 / length);
}

/** Same global-to-local axes as the analysis runtime, including planar rotations. */
export function memberGeometry(model: ModelRecord, element: ModelRecord) {
  const nodes = (Array.isArray(model.nodes) ? model.nodes : []).filter(isRecord);
  const ends = Array.isArray(element.nodes) ? element.nodes : [];
  const start = nodes.find(node => node.id === ends[0]), end = nodes.find(node => node.id === ends[1]);
  if (!start || !end) throw new Error('MEMBER_NODE_REQUIRED / 缺少构件端点');
  const delta = subtract(coordinates(end), coordinates(start));
  const length = Math.hypot(...delta), x = unit(delta);
  const planar = isRecord(model.coordinate_system) && model.coordinate_system.dimension === '2d';
  const vectors = isRecord(model.metadata) && isRecord(model.metadata.elementReferenceVectors) ? model.metadata.elementReferenceVectors : {};
  const reference = Array.isArray(vectors[String(element.id)]) ? vectors[String(element.id)] as Vector3 : Math.abs(x[2]) > 0.9 ? [1, 0, 0] as Vector3 : [0, 0, 1] as Vector3;
  const y = planar ? [0, 1, 0] as Vector3 : unit(cross(reference, x));
  const z = unit(cross(x, y));
  const angle = Number(element.rotation_angle ?? 0) * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  const axes: [Vector3, Vector3, Vector3] = [x,
    y.map((value, index) => c * value + s * z[index]!) as Vector3,
    z.map((value, index) => c * value - s * y[index]!) as Vector3];
  return { start, end, length, axes };
}
