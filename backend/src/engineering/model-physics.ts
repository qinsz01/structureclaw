import type { EngineeringDraft } from '../shared/types/agent.js';
import { isRecord, type ModelRecord } from './model-state.js';
import { coordinates, dot, memberGeometry, scale, subtract, unit, type Vector3 } from './member-geometry.js';
import { modelSelectorSchema, modelLoadMappingsSchema, selectRecords } from './model-selection.js';

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
    if (['truss', 'brace'].includes(String(element.type)) && isRecord(element.releases)
      && Object.values(element.releases).some(end => isRecord(end) && Object.values(end).some(flag => flag === true))) {
      const active = Object.values(element.releases).filter(isRecord).flatMap(end => Object.entries(end).filter(([, flag]) => flag === true).map(([dof]) => dof));
      const equivalent = active.every(dof => ['rx', 'ry', 'rz'].includes(dof)) && (!isRecord(element.offsets) || !Object.keys(element.offsets).length);
      if (equivalent) add('AXIAL_ROTATION_RELEASES_REDUNDANT', [id], 'Axial members already have free rotations. Authored rotational release flags are retained and realized by the axial formulation; no user decision is needed.',
        '纯轴力构件本身不传递转矩；原转动释放定义保留，由纯轴力单元实现等价铰接，无需用户另选建模方式。', { releases: element.releases }, 'warning');
      else add('AXIAL_MEMBER_RELEASES_UNSUPPORTED', [id], 'Translational end releases or released offsets on an axial member are unsupported; do not silently remove confirmed input.',
        '纯轴力构件的平移端释放或带偏心端释放尚不支持，不得静默删除已确认输入。');
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
    const conflictingLoads = draft?.metadata?.zeroLoads === true
      ? draft.loads?.filter(load => Number.isFinite(load.magnitude) && load.magnitude !== 0) ?? [] : [];
    if (conflictingLoads.length) add('ZERO_LOADS_CONFLICT', conflictingLoads.flatMap(load => load.id ? [load.id] : []),
      'The zero-load declaration conflicts with nonzero declared loads. Resolve the conflicting input before building; neither declaration was changed.',
      '无外荷载声明与已声明的非零荷载矛盾。请先明确矛盾输入，再建模；两项原始声明均未改写。');
    const expectedTargets = new Map<string, Vector3>();
    const expected = draft ? expectedLoads(model, draft, expectedTargets) : undefined;
    if (expected) for (const [id, total] of Object.entries(expected)) {
      const actual = loadTotals[id] ?? [0, 0, 0];
      if (total.some((value, index) => Math.abs(value - actual[index]!) > 1e-6 * Math.max(1, Math.abs(value)))) {
        add('LOAD_TOTAL_MISMATCH', [id], 'The applied load total differs from the confirmed request.', '施加荷载总量与已确认输入不一致。', { expected: total, actual });
      }
    }
    if (expected && (draft?.loads?.some(load => load.selector) || isRecord(model.metadata) && model.metadata.loadMappings !== undefined)) for (const [key, total] of expectedTargets) {
      const [caseId, collection, target] = JSON.parse(key) as [string, string, string];
      const loadCase = records(model.load_cases).find(row => row.id === caseId);
      const actual = appliedLoadTotals({ ...model, load_cases: [{ id: caseId,
        loads: records(loadCase?.loads).filter(load => load[collection] === target) }] })[caseId]!;
      if (total.some((value, index) => Math.abs(value - actual[index]!) > 1e-6 * Math.max(1, Math.abs(value)))) {
        add('LOAD_TARGET_MISMATCH', [caseId, target], 'Applied loads do not match the confirmed target group.',
          '施加荷载与已确认的目标分组不一致。', { expected: total, actual });
      }
    }
    // A stable candidate is not evidence that every declared load was applied.
    // Unresolved selectors require explicit input mapping, never guessed coverage.
    if (draft?.loads?.length && !expected) add('LOAD_TOTAL_UNVERIFIABLE', [],
      'Declared load targets are unresolved, so their totals cannot be independently verified. Resolve them to explicit node/member IDs or confirmed load cases before building; do not omit or guess loads.',
      '已声明荷载的作用目标尚未落实，无法独立核对总量。请先明确节点/构件编号或已确认的完整荷载工况，再建模；不得遗漏或猜测荷载。');
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
      let vector = (distributed ? ['wx', 'wy', 'wz'] : ['fx', 'fy', 'fz']).map((key, index) => Number(load[key] ?? (Array.isArray(load.forces) ? load.forces[index] : 0))) as Vector3;
      let global = vector;
      let factor = 1;
      if (load.element !== undefined) {
        const element = records(model.elements).find(item => item.id === load.element);
        if (!element) throw new Error(`Unknown element ${load.element}`);
        const geometry = memberGeometry(model, element);
        if (distributed) factor = Number(load.end ?? geometry.length) - Number(load.start ?? 0);
        if (distributed && Array.isArray(load.points)) {
          const points = records(load.points);
          if (points.length < 2) throw new Error('Invalid piecewise load / 分段荷载至少需要两个控制点');
          vector = [0, 0, 0]; factor = 1;
          for (let i = 1; i < points.length; i++) {
            const a = points[i - 1]!, b = points[i]!;
            const start = Number(a.position), end = Number(b.position);
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 1 || end <= start) throw new Error('Invalid load fractions / 荷载相对位置无效');
            for (const [axis, key] of ['wx', 'wy', 'wz'].entries()) vector[axis]! += (Number(a[key] ?? 0) + Number(b[key] ?? 0)) * (end - start) * geometry.length / 2;
          }
        }
        global = vector;
        if (load.reference_frame === 'element-local') global = [0, 1, 2].map(index => geometry.axes.reduce((sum, axis, j) => sum + axis[index]! * vector[j]!, 0)) as Vector3;
      } else if (!records(model.nodes).some(node => node.id === load.node)) throw new Error(`Unknown load node ${load.node}`);
      for (const index of [0, 1, 2]) total[index]! += global[index]! * factor;
    }
    return [String(loadCase.id), total];
  }));
}

/** LLM-authored mappings resolve identities only: confirmed loads and explicit scopes remain immutable. */
function resolvedLoads(model: ModelRecord, draft: EngineeringDraft) {
  const input = isRecord(model.metadata) ? model.metadata.loadMappings : undefined;
  if (input === undefined || !draft.loads?.length) return draft.loads;
  const parsed = modelLoadMappingsSchema.safeParse(input);
  if (!parsed.success) throw new Error(`LOAD_MAPPING_INVALID: ${JSON.stringify(parsed.error.issues)}`);
  const seen = new Set<string>();
  const loads = structuredClone(draft.loads ?? []);
  for (const mapping of parsed.data) {
    const sources = loads.filter(load => load.id === mapping.loadId);
    if (sources.length !== 1 || seen.has(mapping.loadId)) throw new Error(`LOAD_MAPPING_ID_INVALID: ${mapping.loadId}`);
    seen.add(mapping.loadId);
    const source = sources[0]!;
    if (source.selector || source.location && Object.entries(source.location).some(([key, value]) => key !== 'story' && value !== undefined)) {
      throw new Error(`LOAD_MAPPING_SCOPE_CONFLICT: ${mapping.loadId}`);
    }
    const available = records(source.unit === 'kN' ? model.nodes : model.elements);
    const targets = selectRecords(available, mapping.selector, model);
    if (!targets.length || mapping.selector.ids?.some(id => !targets.some(row => row.id === id))) throw new Error(`LOAD_MAPPING_UNRESOLVED: ${mapping.loadId}`);
    if (available.some(row => row.id === source.target) && (targets.length !== 1 || targets[0]!.id !== source.target)) {
      throw new Error(`LOAD_MAPPING_TARGET_CONFLICT: ${mapping.loadId}`);
    }
    if (source.location?.story !== undefined) {
      const story = source.location.story, heights = draft.geometry?.storyHeightsM;
      if (!heights || story < 1 || story > heights.length) throw new Error(`LOAD_MAPPING_STORY_UNVERIFIABLE: ${mapping.loadId}`);
      const base = Math.min(...records(model.nodes).map(node => Number(node.z)));
      const lower = base + heights.slice(0, story - 1).reduce((sum, height) => sum + height, 0), upper = lower + heights[story - 1]!;
      if (targets.some(row => {
        const z = source.unit === 'kN' ? [Number(row.z)] : [memberGeometry(model, row).start.z, memberGeometry(model, row).end.z].map(Number);
        return !z.every(Number.isFinite) || Math.abs(Math.max(...z) - upper) > 1e-8 || Math.min(...z) < lower - 1e-8;
      })) throw new Error(`LOAD_MAPPING_STORY_CONFLICT: ${mapping.loadId}`);
    }
    delete source.target; delete source.location;
    source.selector = mapping.selector;
  }
  return loads;
}

function expectedLoads(model: ModelRecord, draft: EngineeringDraft, expectedTargets: Map<string, Vector3>): Record<string, Vector3> | undefined {
  draft = { ...draft, loads: resolvedLoads(model, draft) };
  const grouped = draft.loads?.some(load => load.selector);
  if (!grouped && draft.model && Array.isArray(draft.model.load_cases)) return appliedLoadTotals(draft.model);
  // An extractor may name cases before it has generated the individual load targets.
  // Empty case placeholders cannot override separately declared physical loads as zero.
  if (!grouped && (draft.loadCases?.some(loadCase => records(loadCase.loads).length > 0) || draft.metadata?.zeroLoads === true)) {
    return appliedLoadTotals({ ...model, load_cases: draft.loadCases ?? [] });
  }
  if (!draft.loads?.length) return undefined;
  const cases = new Map<string, ModelRecord[]>();
  for (const load of draft.loads) {
    if (!load.direction || !['kN', 'kN/m'].includes(load.unit)) return undefined;
    const index = { globalX: 0, globalY: 1, globalZ: 2, gravity: 2 }[load.direction];
    const value = load.magnitude * (load.direction === 'gravity' ? -1 : 1);
    const nodal = load.unit === 'kN';
    const available = records(nodal ? model.nodes : model.elements);
    let targets: ModelRecord[];
    if (load.selector) {
      const parsed = modelSelectorSchema.safeParse(load.selector);
      if (!parsed.success || load.target || load.location) return undefined;
      targets = selectRecords(available, parsed.data, model);
      if (!targets.length || parsed.data.ids?.some(id => !targets.some(row => row.id === id))) return undefined;
    } else {
      targets = available.filter(row => row.id === load.target);
      if (targets.length !== 1) return undefined;
    }
    const id = load.caseId ?? (records(model.load_cases).length === 1 ? String(records(model.load_cases)[0]!.id) : 'LC1');
    const rows = cases.get(id) ?? [];
    for (const target of targets) {
      rows.push({ type: nodal ? 'nodal' : 'distributed', [nodal ? 'node' : 'element']: target.id,
        [(nodal ? ['fx', 'fy', 'fz'] : ['wx', 'wy', 'wz'])[index]!]: value });
      const key = JSON.stringify([id, nodal ? 'node' : 'element', target.id]);
      const total = expectedTargets.get(key) ?? [0, 0, 0];
      total[index]! += value * (nodal ? 1 : memberGeometry(model, target).length);
      expectedTargets.set(key, total);
    }
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
