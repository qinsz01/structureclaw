import type { ModelRecord } from '../../engineering/model-state.js';
import type { Vector3 } from '../../engineering/member-geometry.js';
import { EngineeringValidationError } from '../../engineering/validation-error.js';

export class GeometryIdentityError extends EngineeringValidationError {
  constructor(readonly details: Record<string, unknown>) {
    super(`MODEL_ID_MAPPING_INVALID: ${JSON.stringify(details)} / 编号映射未对应实际生成实体，请按有效键修正，不得静默忽略`);
  }
}

export interface FrameGeometryOptions {
  dimension: '2d' | '3d'; bayWidthsX: number[]; bayWidthsY?: number[]; storeyHeights: number[];
  baseRestraint: 'fixed' | 'pinned'; origin?: Vector3; prefix?: string; nodeIds?: Record<string, string>;
  material?: string; columnSection?: string; beamSection?: string; includeStories?: boolean;
  memberIds?: Record<string, string>;
  storyIds?: Record<string, string>;
}
export const accumulate = (lengths: number[]): number[] => lengths.reduce<number[]>((values, length) => [...values, values[values.length - 1]! + length], [0]);

/** Extracted from the frame builders. Ordering and default IDs retain specialised behaviour. */
export function regularFrameGeometry(options: FrameGeometryOptions) {
  const x = accumulate(options.bayWidthsX), y = options.dimension === '3d' ? accumulate(options.bayWidthsY!) : [0], z = accumulate(options.storeyHeights);
  const origin = options.origin ?? [0, 0, 0], prefix = options.prefix ?? '';
  const nodeKeys = new Set<string>(), memberKeys = new Set<string>(), storyKeys = new Set<string>();
  const nodeId = (story: number, i: number, j: number) => {
    const key = `${story},${i},${j}`; nodeKeys.add(key);
    return options.nodeIds?.[key] ?? `${prefix}N${story}_${i}${options.dimension === '3d' ? `_${j}` : ''}`;
  };
  const nodes: ModelRecord[] = [], elements: ModelRecord[] = [];
  const storyId = (story: number) => { storyKeys.add(String(story)); return options.storyIds?.[String(story)] ?? `${prefix}F${story}`; };
  const storyField = (story: number) => options.includeStories === false ? {} : { story: storyId(story) };
  const memberId = (local: string) => { memberKeys.add(local); return options.memberIds?.[local] ?? prefix + local; };
  const restraints = options.baseRestraint === 'fixed' ? [true, true, true, true, true, true] : [true, true, true, false, false, false];
  let index = 1;
  for (let story = 0; story < z.length; story++) for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length; j++) {
    nodes.push({ id: nodeId(story, i, j), x: x[i]! + origin[0], y: y[j]! + origin[1], z: z[story]! + origin[2],
      ...(story ? storyField(story) : { restraints: [...restraints] }) });
  }
  for (let story = 1; story < z.length; story++) for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length; j++) {
    elements.push({ id: memberId(`C${index++}`), type: 'column', nodes: [nodeId(story - 1, i, j), nodeId(story, i, j)],
      material: options.material ?? '1', section: options.columnSection ?? '1', ...storyField(story) });
  }
  for (let story = 1; story < z.length; story++) for (let i = 0; i < x.length - 1; i++) for (let j = 0; j < y.length; j++) {
    elements.push({ id: memberId(`${options.dimension === '3d' ? 'BX' : 'B'}${index++}`), type: 'beam', nodes: [nodeId(story, i, j), nodeId(story, i + 1, j)],
      material: options.material ?? '1', section: options.beamSection ?? '2', ...storyField(story) });
  }
  if (options.dimension === '3d') for (let story = 1; story < z.length; story++) for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length - 1; j++) {
    elements.push({ id: memberId(`BY${index++}`), type: 'beam', nodes: [nodeId(story, i, j), nodeId(story, i, j + 1)],
      material: options.material ?? '1', section: options.beamSection ?? '2', ...storyField(story) });
  }
  const stories = options.storeyHeights.map((height, i) => ({ id: storyId(i + 1), height, elevation: origin[2] + z[i]! }));
  const invalidMappings = ([['nodeIds', nodeKeys], ['memberIds', memberKeys], ['storyIds', storyKeys]] as const).flatMap(([field, keys]) => {
    const invalidKeys = Object.keys(options[field] ?? {}).filter(key => !keys.has(key));
    return invalidKeys.length ? [{ field, invalidKeys, availableKeys: [...keys] }] : [];
  });
  if (invalidMappings.length) throw new GeometryIdentityError({ invalidMappings });
  return { nodes, elements, stories };
}

export interface TrussGeometryOptions {
  span: number; height: number; panels: number; topology: 'pratt' | 'howe' | 'warren' | 'trapezoidal' | 'generic';
  prefix?: string; origin?: Vector3; material?: string; section?: string;
}

/** Existing panel-truss geometry, shared by the specialised template and operations. */
export function trussPanelGeometry(options: TrussGeometryOptions) {
  const { span, height, panels, topology } = options;
  const prefix = options.prefix ?? '', origin = options.origin ?? [0, 0, 0];
  const nodes: ModelRecord[] = [], elements: ModelRecord[] = [];
  for (let i = 0; i <= panels; i++) nodes.push({ id: `${prefix}B${i}`, x: origin[0] + i * span / panels, y: origin[1], z: origin[2],
    ...(i === 0 ? { restraints: [true, true, true, false, false, false] } : i === panels ? { restraints: [false, true, true, false, false, false] } : {}) });
  for (let i = 0; i <= panels; i++) {
    const x = i * span / panels;
    nodes.push({ id: `${prefix}T${i}`, x: origin[0] + x, y: origin[1],
      z: origin[2] + (topology === 'trapezoidal' ? Math.max(height - Math.abs(x - span / 2) * 0.1, height * 0.4) : height) });
  }
  const add = (id: string, a: string, b: string) => elements.push({ id: prefix + id, type: 'truss', nodes: [prefix + a, prefix + b], material: options.material ?? '1', section: options.section ?? '1' });
  for (let i = 0; i < panels; i++) { add(`BC${i}`, `B${i}`, `B${i + 1}`); add(`TC${i}`, `T${i}`, `T${i + 1}`); }
  for (let i = 0; i <= panels; i++) {
    add(`WV${i}`, `B${i}`, `T${i}`);
    if (i < panels) {
      const reverse = topology === 'pratt' ? i >= panels / 2 : topology === 'warren' ? i % 2 === 1 : i < panels / 2;
      add(`WD${i}`, `B${reverse ? i : i + 1}`, `T${reverse ? i + 1 : i}`);
    }
  }
  return { nodes, elements };
}

export function polylineGeometry(points: Vector3[], segments: number, prefix: string, nodeIds: Record<string, string> = {}, type = 'beam') {
  const nodes: ModelRecord[] = [], elements: ModelRecord[] = [];
  for (let edge = 0; edge < points.length - 1; edge++) for (let part = 0; part <= segments; part++) {
    if (edge && part === 0) continue;
    const index = edge * segments + part, fraction = part / segments;
    const point = points[edge]!.map((value, axis) => value + (points[edge + 1]![axis]! - value) * fraction);
    nodes.push({ id: nodeIds[String(index)] ?? `${prefix}N${index}`, x: point[0], y: point[1], z: point[2] });
    if (nodes.length > 1) elements.push({ id: `${prefix}E${index}`, type, nodes: [nodes[nodes.length - 2]!.id, nodes[nodes.length - 1]!.id] });
  }
  return { nodes, elements };
}

export function arcGeometry(center: Vector3, radius: number, startDegrees: number, endDegrees: number, segments: number,
  plane: 'xz' | 'xy' | 'yz', prefix: string, nodeIds: Record<string, string> = {}, type = 'beam') {
  const axes = plane === 'xz' ? [0, 2] : plane === 'xy' ? [0, 1] : [1, 2];
  const points: Vector3[] = Array.from({ length: segments + 1 }, (_, index) => {
    const angle = (startDegrees + (endDegrees - startDegrees) * index / segments) * Math.PI / 180;
    const point = [...center] as Vector3;
    point[axes[0]!]! += radius * Math.cos(angle); point[axes[1]!]! += radius * Math.sin(angle);
    return point;
  });
  return polylineGeometry(points, 1, prefix, nodeIds, type);
}
