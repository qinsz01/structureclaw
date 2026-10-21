import type { EngineeringDraft } from '../shared/types/agent.js';
import { isRecord, type ModelRecord } from './model-state.js';
import { coordinates, dot, memberGeometry, scale, subtract, unit, type Vector3 } from './member-geometry.js';

export interface PhysicsDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  entityIds: string[];
  message: { en: string; zh: string };
  details?: ModelRecord;
}
export interface PhysicsCheck {
  valid: boolean;
  diagnostics: PhysicsDiagnostic[];
  stability: { freeModes: number; rank: number; dofs: number } | null;
  loadTotals: Record<string, Vector3>;
}
const records = (value: unknown): ModelRecord[] => Array.isArray(value) ? value.filter(isRecord) : [];
const endRelease = (element: ModelRecord, end: 'i' | 'j', axis: string): boolean => {
  const releases = isRecord(element.releases) ? element.releases : {};
  const flags = releases[end] ?? releases[end === 'i' ? 'releaseI' : 'releaseJ'];
  return isRecord(flags) && flags[axis] === true;
};

/** Kinematic rank of positive-stiffness line elements: equivalent to the nullspace of K=BᵀDB.
 * Each beam contributes axial, torsional and unreleased end-curvature constraints. Rotations
 * that no member resists are omitted as solver gauge DOFs, rather than counted as mechanisms.
 */
export function checkModelPhysics(model: ModelRecord, draft?: EngineeringDraft): PhysicsCheck {
  const nodes = records(model.nodes), elements = records(model.elements);
  const diagnostics: PhysicsDiagnostic[] = [];
  const add = (code: string, entityIds: string[], en: string, zh: string, details?: ModelRecord, severity: 'error' | 'warning' = 'error') => {
    diagnostics.push({ code, severity, entityIds, message: { en, zh }, ...(details ? { details } : {}) });
  };
  const connected = new Map(nodes.map(node => [String(node.id), new Set<string>()]));
  const pairs = new Map<string, string>();
  const usable: ModelRecord[] = [];
  for (const element of elements) {
    const id = String(element.id), ends = Array.isArray(element.nodes) ? element.nodes.map(String) : [];
    if (ends.length !== 2 || ends.some(end => !connected.has(end))) {
      add('INVALID_MEMBER_CONNECTIVITY', [id], 'A line member needs two existing end nodes.', '线构件必须连接两个已有端点。'); continue;
    }
    const a = nodes.find(node => String(node.id) === ends[0])!, b = nodes.find(node => String(node.id) === ends[1])!;
    const delta = subtract(coordinates(b), coordinates(a)), length = Math.hypot(...delta);
    if (!Number.isFinite(length) || length < 1e-9) {
      add('ZERO_LENGTH_MEMBER', [id, ...ends], 'The member has zero or invalid length.', '构件长度为零或无效。'); continue;
    }
    const pair = [...ends].sort().join('\0');
    if (pairs.has(pair)) add('DUPLICATE_MEMBER', [pairs.get(pair)!, id], 'Members duplicate the same node pair.', '构件重复连接同一对节点。');
    else pairs.set(pair, id);
    connected.get(ends[0]!)!.add(ends[1]!); connected.get(ends[1]!)!.add(ends[0]!);
    if (element.type === 'beam' && Math.hypot(delta[0], delta[1]) < length * 1e-7) {
      add('VERTICAL_BEAM_ROLE', [id], 'A vertical frame member must declare its column role, or explicitly document a different physical purpose.', '竖向框架构件应声明为柱，或明确说明其他物理用途。', undefined,
        isRecord(element.metadata) && typeof element.metadata.roleReason === 'string' ? 'warning' : 'error');
    }
    if (!['beam', 'column', 'truss', 'brace'].includes(String(element.type))) {
      add('STABILITY_CHECK_UNSUPPORTED', [id], 'Kinematic stability checking requires beam, column or axial truss/brace members.', '运动学稳定性检查要求梁、柱或纯轴力桁架/支撑构件。'); continue;
    }
    usable.push(element);
  }
  const orphan = [...connected].filter(([, neighbours]) => !neighbours.size).map(([id]) => id);
  if (orphan.length) add('ORPHAN_NODES', orphan, 'Nodes are not connected to any member.', '存在未连接任何构件的孤立节点。');
  const seen = new Set<string>(), components: string[][] = [];
  for (const [id] of connected) {
    if (seen.has(id) || orphan.includes(id)) continue;
    const component = [id]; seen.add(id);
    for (let i = 0; i < component.length; i++) for (const other of connected.get(component[i]!)!) if (!seen.has(other)) { seen.add(other); component.push(other); }
    components.push(component);
  }
  if (components.length > 1) add('DISCONNECTED_COMPONENTS', components.flat(), 'The model has separate connected components; each needs its own stable supports.', '模型含多个不相连的部分，每一部分均需独立稳定支承。', { components }, 'warning');
  for (const component of components) if (!nodes.some(node => component.includes(String(node.id)) && Array.isArray(node.restraints) && node.restraints.some(value => value === true))) {
    add('SUPPORTS_MISSING', component, 'This connected component has no supports.', '该连通部分没有支座约束。');
  }
  let stability: PhysicsCheck['stability'] = null;
  if (usable.length && !diagnostics.some(item => ['ZERO_LENGTH_MEMBER', 'INVALID_MEMBER_CONNECTIVITY', 'STABILITY_CHECK_UNSUPPORTED'].includes(item.code))) {
    try {
      stability = kinematicRank(model, nodes.filter(node => !orphan.includes(String(node.id))), usable);
      if (stability.freeModes) add('KINEMATIC_MECHANISM', [], 'The supported structure has unrestrained rigid-body motion or internal mechanisms.', '支承后的结构仍有未约束刚体运动或内部机构。', stability);
    } catch (error) {
      add('INVALID_KINEMATICS', [], 'Member axes or kinematic coefficients are invalid or numerically unresolvable.', '构件局部轴或运动学系数无效，或无法进行可靠的数值校核。', { error: String(error) });
    }
  }
  let loadTotals: Record<string, Vector3> = {};
  try {
    loadTotals = appliedLoadTotals(model);
    const expected = draft ? expectedLoads(model, draft) : undefined;
    if (expected) for (const [id, total] of Object.entries(expected)) {
      const actual = loadTotals[id] ?? [0, 0, 0];
      if (total.some((value, index) => Math.abs(value - actual[index]!) > 1e-6 * Math.max(1, Math.abs(value)))) {
        add('LOAD_TOTAL_MISMATCH', [id], 'The applied load total differs from the confirmed request.', '施加荷载总量与已确认输入不一致。', { expected: total, actual });
      }
    }
    if (draft?.loads?.length && !expected) add('LOAD_TOTAL_UNVERIFIABLE', [], 'Draft load targets are not explicit enough for an independent total check; inspect the reported totals.', '草稿荷载目标尚不足以独立核对总量，请检查所列荷载总和。', undefined, 'warning');
  } catch (error) {
    add('LOAD_TARGET_INVALID', [], 'A load has an invalid target or reference frame.', '荷载目标或参考坐标系无效。', { error: String(error) });
  }
  return { valid: !diagnostics.some(item => item.severity === 'error'), diagnostics, stability, loadTotals };
}

function kinematicRank(model: ModelRecord, nodes: ModelRecord[], elements: ModelRecord[]) {
  const planar = isRecord(model.coordinate_system) && model.coordinate_system.dimension === '2d';
  const translations = planar ? [0, 2] : [0, 1, 2];
  const rotationBases = new Map(nodes.map(node => [String(node.id), [] as Vector3[]]));
  const geometry = elements.map(element => ({ element, ...memberGeometry(model, element) }));
  for (const item of geometry.filter(item => ['beam', 'column'].includes(String(item.element.type)))) {
    for (const [end, node] of [['i', item.start], ['j', item.end]] as const) {
      const basis = rotationBases.get(String(node.id))!;
      for (const [index, axis] of item.axes.entries()) {
        if (planar && Math.abs(axis[1]) < 0.9 || endRelease(item.element, end, ['rx', 'ry', 'rz'][index]!)) continue;
        let residual = [...axis] as Vector3;
        for (const prior of basis) residual = subtract(residual, scale(prior, dot(residual, prior)));
        if (Math.hypot(...residual) > 1e-8) basis.push(unit(residual));
      }
    }
  }
  let dofs = 0;
  const indices = new Map(nodes.map(node => [String(node.id), {
    t: translations.map(() => dofs++), r: rotationBases.get(String(node.id))!.map(() => dofs++),
  }]));
  const pivots = new Map<number, Map<number, number>>();
  const row = (terms: Array<[number, number]>) => {
    const values = new Map<number, number>();
    for (const [index, value] of terms) values.set(index, (values.get(index) ?? 0) + value);
    if ([...values.values()].some(value => !Number.isFinite(value))) throw new Error('NON_FINITE_KINEMATIC_COEFFICIENT');
    const largest = Math.max(0, ...Array.from(values.values(), Math.abs));
    if (largest < 1e-12) return;
    for (const [key, value] of values) values.set(key, value / largest);
    while (values.size) {
      if ([...values.values()].some(value => !Number.isFinite(value))) throw new Error('NON_FINITE_KINEMATIC_ELIMINATION');
      for (const [key, value] of values) if (Math.abs(value) < 1e-9) values.delete(key);
      if (!values.size) return;
      const pivot = Math.min(...values.keys()), value = values.get(pivot)!;
      const prior = pivots.get(pivot);
      if (prior) { for (const [key, coefficient] of prior) values.set(key, (values.get(key) ?? 0) - value * coefficient); }
      else { for (const [key, coefficient] of values) values.set(key, coefficient / value); pivots.set(pivot, values); return; }
    }
  };
  const t = (node: ModelRecord, axis: Vector3, factor = 1): Array<[number, number]> => indices.get(String(node.id))!.t.map((id, index) => [id, axis[translations[index]!]! * factor]);
  const r = (node: ModelRecord, axis: Vector3, factor = 1): Array<[number, number]> => indices.get(String(node.id))!.r.map((id, index) => [id, dot(axis, rotationBases.get(String(node.id))![index]!) * factor]);
  for (const node of nodes) {
    const flags = Array.isArray(node.restraints) ? node.restraints : [];
    for (const direction of [0, 1, 2]) {
      const axis = [0, 0, 0] as Vector3; axis[direction] = 1;
      if (flags[direction] === true) row(t(node, axis));
      if (flags[direction + 3] === true) row(r(node, axis));
    }
  }
  for (const { element, start, end, length, axes: [x, y, z] } of geometry) {
    row([...t(end, x), ...t(start, x, -1)]);
    if (['truss', 'brace'].includes(String(element.type))) continue;
    if (!planar) row([...r(end, x), ...r(start, x, -1)]);
    for (const [axisName, rotation, deflection, sign] of [['ry', y, z, 1], ['rz', z, y, -1]] as const) {
      if (planar && Math.abs(rotation[1]) < 0.9) continue;
      for (const [endName, node] of [['i', start], ['j', end]] as const) if (!endRelease(element, endName, axisName)) {
        row([...r(node, rotation), ...t(end, deflection, sign / length), ...t(start, deflection, -sign / length)]);
      }
    }
  }
  return { rank: pivots.size, dofs, freeModes: dofs - pivots.size };
}

export function appliedLoadTotals(model: ModelRecord): Record<string, Vector3> {
  return Object.fromEntries(records(model.load_cases).map(loadCase => {
    const total: Vector3 = [0, 0, 0];
    for (const load of records(loadCase.loads)) {
      const distributed = load.type === 'distributed';
      const vector = (distributed ? ['wx', 'wy', 'wz'] : ['fx', 'fy', 'fz']).map((key, index) => Number(load[key] ?? (Array.isArray(load.forces) ? load.forces[index] : 0))) as Vector3;
      let global = vector;
      let factor = 1;
      if (load.element !== undefined) {
        const element = records(model.elements).find(item => item.id === load.element);
        if (!element) throw new Error(`Unknown element ${load.element}`);
        const geometry = memberGeometry(model, element);
        if (distributed) factor = Number(load.end ?? geometry.length) - Number(load.start ?? 0);
        if (load.reference_frame === 'element-local') global = [0, 1, 2].map(index => geometry.axes.reduce((sum, axis, j) => sum + axis[index]! * vector[j]!, 0)) as Vector3;
      } else if (!records(model.nodes).some(node => node.id === load.node)) throw new Error(`Unknown load node ${load.node}`);
      for (const index of [0, 1, 2]) total[index]! += global[index]! * factor;
    }
    return [String(loadCase.id), total];
  }));
}

function expectedLoads(model: ModelRecord, draft: EngineeringDraft): Record<string, Vector3> | undefined {
  if (draft.model && Array.isArray(draft.model.load_cases)) return appliedLoadTotals(draft.model);
  if (draft.loadCases) return appliedLoadTotals({ ...model, load_cases: draft.loadCases });
  if (!draft.loads?.length) return undefined;
  const cases = new Map<string, ModelRecord[]>();
  for (const load of draft.loads) {
    const target = load.target;
    if (!target || !load.direction) return undefined;
    const index = { globalX: 0, globalY: 1, globalZ: 2, gravity: 2 }[load.direction];
    const value = load.magnitude * (load.direction === 'gravity' ? -1 : 1);
    const nodal = load.unit === 'kN';
    if (nodal && !records(model.nodes).some(node => node.id === target) || !nodal && !records(model.elements).some(element => element.id === target)) return undefined;
    const id = load.caseId ?? (records(model.load_cases).length === 1 ? String(records(model.load_cases)[0]!.id) : 'LC1');
    const rows = cases.get(id) ?? [];
    rows.push({ type: nodal ? 'nodal' : 'distributed', [nodal ? 'node' : 'element']: target,
      [(nodal ? ['fx', 'fy', 'fz'] : ['wx', 'wy', 'wz'])[index]!]: value });
    cases.set(id, rows);
  }
  return appliedLoadTotals({ ...model, load_cases: [...cases].map(([id, loads]) => ({ id, loads })) });
}

export class ModelPhysicsError extends Error {
  readonly code = 'MODEL_PHYSICS_INVALID';
  constructor(readonly check: PhysicsCheck) {
    super(JSON.stringify({ success: false, errorCode: 'MODEL_PHYSICS_INVALID', modelBuilt: false, ...check,
      instruction: 'Resolve these physical diagnostics without removing confirmed inputs. / 请修正这些物理诊断，不得删减已确认输入。' }));
    this.name = 'ModelPhysicsError';
  }
}
