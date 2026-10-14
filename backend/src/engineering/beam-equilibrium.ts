import type { DraftState } from '../agent-runtime/types.js';
import { buildStructuralCoordinateSystem } from '../agent-runtime/coordinate-semantics.js';
import { assertResolvedInput } from './input-evidence.js';
import { isRecord, type ModelRecord } from './model-state.js';

function fail(code: string): never { throw new Error(`EQUILIBRIUM_${code}`); }
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const tol = (length: number) => 16 * Number.EPSILON * Math.max(1, length);

/** Read-only V2 geometry/load projection. No fictional material or stiffness. */
export function equilibriumModel(draft: DraftState, evidence?: ModelRecord[]): ModelRecord {
  const d = draft.engineeringDraft;
  assertResolvedInput(evidence);
  assertResolvedInput(d?.inputEvidence);
  if (draft.draftIssues?.some(issue => ['invalid', 'ambiguous', 'conflict'].includes(issue.severity))) fail('INPUT_UNRESOLVED / 存在未解决输入');
  if (!d || draft.inferredType !== 'beam' || d.model) fail('SIMPLE_BEAM_REQUIRED / 仅支持明确的单跨梁');
  if (d.analysis?.engineTarget) fail('SPECIFIED_ENGINE_REQUIRED / 指定引擎必须实际执行');
  if (d.analysis?.type && d.analysis.type !== 'static') fail('STATIC_ONLY / 仅支持静力');
  if ((d.geometry?.spanLengthsM?.length ?? 0) > 1) fail('SINGLE_SPAN_REQUIRED / 不支持连续梁');
  const L = d.geometry?.lengthM ?? draft.lengthM;
  if (!finite(L) || L <= 0) fail('LENGTH_REQUIRED / 需要正数跨度及单位');
  const support = d.boundary?.supportType ?? draft.supportType;
  if (!['simply-supported', 'cantilever'].includes(String(support))) fail('SUPPORT_REQUIRED / 仅支持左铰右滚或左固右自由');
  const restraints = support === 'cantilever'
    ? [[true, true, true, true, true, true], [false, false, false, false, false, false]]
    : [[true, true, true, false, false, false], [false, true, true, false, false, false]];
  let nodeIds = ['A', 'B'], memberId = 'beam';
  if (d.topology?.nodes?.length || d.topology?.members?.length) {
    const nodes = [...(d.topology.nodes ?? [])].sort((a, b) => a.x - b.x), members = d.topology.members ?? [];
    if (nodes.length !== 2 || members.length !== 1 || nodes[0]!.x !== 0 || nodes[1]!.x !== L
      || nodes.some((node, i) => node.y !== 0 || node.z !== 0 || JSON.stringify(node.restraints) !== JSON.stringify(restraints[i]))
      || JSON.stringify(members[0]!.nodes) !== JSON.stringify(nodes.map(n => n.id))
      || Object.keys(members[0]!).some(key => !['id', 'nodes'].includes(key))) fail('SINGLE_SPAN_TOPOLOGY_REQUIRED / 连接必须是明确的单根水平梁及对应支座');
    nodeIds = nodes.map(n => n.id); memberId = members[0]!.id ?? '';
    if (new Set(nodeIds).size !== 2 || nodeIds.some(id => !id) || !memberId) fail('OBJECT_ID_INVALID');
  }
  const positions = d.boundary?.supportPositionsM;
  if (positions) {
    const expected = support === 'cantilever' ? [0] : [0, L];
    if (positions.length !== expected.length || positions.some((x, i) => x !== expected[i])) fail('SUPPORT_POSITION_UNSUPPORTED / 支座位置须与左固悬臂或左铰右滚一致');
  }
  if (d.analysisControl?.self_weight === true) fail('SELF_WEIGHT_DATA_REQUIRED / 计入自重需要明确重量荷载，不能由未知材料截面推测');
  if (Object.entries(d.analysisControl ?? {}).some(([key, value]) => key !== 'self_weight' && value !== false)) fail('ANALYSIS_CONTROL_UNSUPPORTED');
  if (d.loadCases?.length) fail('EXPLICIT_LOAD_CASE_MODEL_REQUIRED');
  if (!d.loads?.length) fail('LOAD_REQUIRED / 需要明确荷载');
  const byCase = new Map<string, ModelRecord[]>();
  d.loads.forEach((load, index) => {
    if (!finite(load.magnitude) || load.magnitude < 0 || load.direction !== 'gravity') fail('VERTICAL_LOAD_REQUIRED / 需要明确向下荷载和单位');
    if (load.location?.spanIndex !== undefined && load.location.spanIndex !== 1 || load.location?.story !== undefined || load.location?.nodeRole !== undefined) fail('LOAD_LOCATION_UNSUPPORTED');
    const caseId = load.caseId ?? 'LC1';
    const loads = byCase.get(caseId) ?? [];
    if (load.kind === 'point' && load.unit === 'kN') {
      const x = load.location?.xM;
      if (!finite(x) || x < 0 || x > L) fail('POINT_POSITION_REQUIRED / 集中力位置必须明确且在梁内');
      loads.push({ id: load.id ?? `${caseId}:load:${index + 1}`, type: 'point', element: memberId, position: x, fz: -load.magnitude, reference_frame: 'global' });
    } else if (['line', 'distributed'].includes(load.kind) && load.unit === 'kN/m') {
      if (load.location?.xM !== undefined || load.target && !/^(beam|full[- ]span|全跨|全长|梁)$/i.test(load.target)) fail('FULL_SPAN_LINE_REQUIRED / 本方法仅支持明确全跨均布载');
      loads.push({ id: load.id ?? `${caseId}:load:${index + 1}`, type: 'distributed', element: memberId, wz: -load.magnitude, reference_frame: 'global' });
    } else fail('LOAD_KIND_UNSUPPORTED');
    byCase.set(caseId, loads);
  });
  return {
    schema_version: '2.2.0', unit_system: 'SI', coordinate_system: buildStructuralCoordinateSystem('2d'),
    nodes: [{ id: nodeIds[0], x: 0, y: 0, z: 0, restraints: restraints[0] },
      { id: nodeIds[1], x: L, y: 0, z: 0, restraints: restraints[1] }],
    elements: [{ id: memberId, type: 'beam', nodes: nodeIds }], materials: [], sections: [],
    load_cases: Array.from(byCase, ([id, loads]) => ({ id, type: 'other', loads })),
    load_combinations: d.analysis?.loadCombinations ?? [], analysis_control: { self_weight: false },
    metadata: { calculationMethod: 'beam-equilibrium', supportType: support, readOnlyProjection: true, inputEvidence: d.inputEvidence ?? [] },
  };
}

function problem(model: ModelRecord, parameters: ModelRecord) {
  const metadata = isRecord(model.metadata) ? model.metadata : {};
  if (metadata.calculationMethod !== 'beam-equilibrium' || metadata.readOnlyProjection !== true
    || !['simply-supported', 'cantilever'].includes(String(metadata.supportType))
    || !Array.isArray(model.nodes) || model.nodes.length !== 2 || !Array.isArray(model.elements) || model.elements.length !== 1
    || !Array.isArray(model.load_cases) || !model.load_cases.length
    || !isRecord(model.analysis_control) || model.analysis_control.self_weight !== false) fail('PROJECTION_INVALID');
  const nodes = model.nodes as ModelRecord[], L = Number(nodes[1]?.x);
  const element = model.elements[0] as ModelRecord;
  if (nodes.some(n => typeof n.id !== 'string' || !n.id) || nodes[0].id === nodes[1].id
    || nodes[0].x !== 0 || nodes[0].y !== 0 || nodes[0].z !== 0
    || nodes[1].y !== 0 || nodes[1].z !== 0 || !finite(L) || L <= 0
    || JSON.stringify(element.nodes) !== JSON.stringify(nodes.map(n => n.id))) fail('PROJECTION_INVALID');
  const cantilever = metadata.supportType === 'cantilever';
  const expectedRestraints = cantilever
    ? [[true, true, true, true, true, true], [false, false, false, false, false, false]]
    : [[true, true, true, false, false, false], [false, true, true, false, false, false]];
  if (model.unit_system !== 'SI' || typeof element.id !== 'string' || !element.id || element.type !== 'beam'
    || Object.keys(element).some(key => !['id', 'type', 'nodes'].includes(key))
    || Object.keys(model.analysis_control as ModelRecord).some(key => key !== 'self_weight')
    || nodes.some((node, i) => JSON.stringify(node.restraints) !== JSON.stringify(expectedRestraints[i]))) fail('PROJECTION_INVALID');
  const cases = model.load_cases as ModelRecord[];
  if (new Set(cases.map(c => c.id)).size !== cases.length || cases.some(c => typeof c.id !== 'string' || !Array.isArray(c.loads))) fail('CASE_INVALID');
  let factors: ModelRecord;
  if (parameters.loadCombinationId) {
    const combination = (model.load_combinations as ModelRecord[]).find(c => c.id === parameters.loadCombinationId);
    if (!isRecord(combination?.factors)) fail('COMBINATION_NOT_FOUND');
    factors = combination!.factors as ModelRecord;
  } else {
    const ids = parameters.loadCaseIds as string[] | undefined;
    if (ids && ids.length !== 1) fail('CASE_SELECTION_REQUIRED');
    factors = { [ids?.[0] ?? String(cases[0]?.id)]: 1 };
  }
  const points: Array<{ x: number; p: number }> = [];
  let q = 0;
  for (const [id, factor] of Object.entries(factors)) {
    if (!finite(factor)) fail('COMBINATION_FACTOR_INVALID');
    const c = cases.find(row => row.id === id);
    if (!c) fail('CASE_NOT_FOUND');
    for (const load of c!.loads as ModelRecord[]) {
      if (!isRecord(load) || load.element !== element.id || load.reference_frame !== 'global') fail('LOAD_KIND_UNSUPPORTED');
      if (load.points !== undefined || load.distribution !== undefined && load.distribution !== 'uniform') fail('LOAD_DISTRIBUTION_UNSUPPORTED');
      if (['fx', 'fy', 'mx', 'my', 'mz', 'qx', 'qy', 'qz', 'wx', 'wy', 'wx_end', 'wy_end', 'wz_end', 'start', 'end', 'start_position', 'end_position']
        .some(key => load[key] !== undefined)) fail('LOAD_COMPONENT_UNSUPPORTED');
      if (load.type === 'point' && load.wz === undefined && finite(load.fz) && finite(load.position) && load.position >= 0 && load.position <= L) {
        points.push({ x: load.position, p: -load.fz * factor });
      } else if (load.type === 'distributed' && load.fz === undefined && load.position === undefined && finite(load.wz)) q += -load.wz * factor;
      else fail('LOAD_KIND_UNSUPPORTED');
    }
  }
  const W = q * L + points.reduce((s, p) => s + p.p, 0);
  const T = q * L * L / 2 + points.reduce((s, p) => s + p.p * p.x, 0);
  const RB = cantilever ? 0 : T / L, RA = W - RB, MA = cantilever ? -T : 0;
  const at = (x: number, side: 'left' | 'right') => {
    if (!finite(x) || x < 0 || x > L || x === 0 && side !== 'right' || x === L && side !== 'left') fail('POSITION_INVALID');
    const before = points.filter(p => p.x < x || p.x === x && side === 'right');
    const V = RA - q * x - before.reduce((s, p) => s + p.p, 0);
    const M = MA + RA * x - q * x * x / 2 - before.reduce((s, p) => s + p.p * (x - p.x), 0);
    return { x, N: 0, V2: 0, V3: V || 0, T: 0, M2: -M || 0, M3: 0 };
  };
  return { L, q, points, RA, RB, MA, at, nodeIds: nodes.map(n => String(n.id)), memberId: String(element.id) };
}

export function equilibriumResponse(model: ModelRecord, parameters: ModelRecord, elementId: string, positionM: number, side: 'left' | 'right') {
  if (!Array.isArray(model.elements) || (model.elements[0] as ModelRecord).id !== elementId) fail('MEMBER_NOT_FOUND');
  return { elementId, positionM, side, method: 'section-equilibrium', state: 'recovered',
    sample: problem(model, parameters).at(positionM, side), units: { position: 'm', force: 'kN', moment: 'kN.m' },
    provenance: 'mechanics-recovery', source: { kind: 'equilibrium-direct', convention: 'sclaw-beam-equilibrium/v1', stiffnessUsed: false } };
}

/** Equilibrium determines forces only; unavailable displacement is never filled with zero. */
export function solveBeamEquilibrium(request: ModelRecord): ModelRecord {
  if (request.type !== undefined && request.type !== 'static') fail('STATIC_ONLY');
  const model = request.model as ModelRecord, parameters = request.parameters as ModelRecord;
  const { L, q, points, RA, RB, MA, at, nodeIds, memberId } = problem(model, parameters);
  const knots = [...new Set([0, L, ...points.map(p => p.x)])].sort((a, b) => a - b);
  const extremaPositions = [...knots];
  for (let i = 0; i < knots.length - 1; i++) {
    if (q !== 0) {
      const root = knots[i]! + at(knots[i]!, 'right').V3 / q;
      if (root > knots[i]! && root < knots[i + 1]!) extremaPositions.push(root);
    }
  }
  const cuts = [...new Set([...extremaPositions, ...Array.from({ length: 41 }, (_, i) => L * i / 40)])].sort((a, b) => a - b);
  const samples = cuts.flatMap(x => points.some(p => Math.abs(p.x - x) <= tol(L)) && x > 0 && x < L
    ? [{ ...at(x, 'left'), position: [x, 0, 0], side: 'left' }, { ...at(x, 'right'), position: [x, 0, 0], side: 'right' }]
    : [{ ...at(x, x === L ? 'left' : 'right'), position: [x, 0, 0], side: x === L ? 'left' : 'right' }]);
  const maxMoment = Math.max(...extremaPositions.map(x => Math.abs(at(x, x === L ? 'left' : 'right').M2)));
  const maxShear = Math.max(...samples.map(s => Math.abs(s.V3)));
  const forceSamples = samples.map(sample => ({ ...sample, provenance: 'mechanics-recovery',
    source: { kind: 'equilibrium-direct', stiffnessUsed: false, convention: 'sclaw-beam-equilibrium/v1' } }));
  const scope = isRecord(request.requestScope) ? request.requestScope : {};
  const missingResponses = Array.isArray(scope.responses) ? scope.responses.filter(field => !['forces', 'reactions'].includes(String(field))) : [];
  return { schema_version: '2.2.0', analysis_type: 'static', success: true, data: {
    status: missingResponses.length ? 'partial' : 'success', analysisMode: 'beam_equilibrium', displacements: undefined,
    ...(missingResponses.length ? { missingCapabilities: missingResponses, missingRequestedResponses: missingResponses } : {}),
    reactions: { [nodeIds[0]!]: { fx: 0, fy: 0, fz: RA, mx: 0, my: MA, mz: 0 }, [nodeIds[1]!]: { fx: 0, fy: 0, fz: RB, mx: 0, my: 0, mz: 0 } },
    forces: { [memberId]: { n1: at(0, 'right'), n2: at(L, 'left') } },
    memberResponses: [{ id: memberId, type: 'beam', length: L, state: 'force-only', reason: 'Equilibrium forces; no displacement computed', method: 'section-equilibrium', samples: forceSamples }],
    envelope: { maxAbsMoment: maxMoment, maxAbsShearForce: maxShear, maxAbsReaction: Math.max(Math.abs(RA), Math.abs(RB)), maxAbsReactionMoment: Math.abs(MA) },
    summary: { nodeCount: 2, elementCount: 1, maxAbsMoment: maxMoment, maxAbsShearForce: maxShear },
    responseDefinition: { available: ['forces', 'reactions'], unavailable: ['displacements', 'rotations', 'stress', 'design'], stiffnessUsed: false,
      forceConvention: 'element-local M2 is negative sagging; V3 is positive left-cut upward shear',
      assumptions: ['first-order equilibrium', 'horizontal single-span beam', 'explicit gravity loads', 'self-weight disabled'] },
    execution: { solver: 'StructureClaw equilibrium', executed: true, method: 'beam-equilibrium/v1', balance: { verticalResidual: RA + RB - q * L - points.reduce((s, p) => s + p.p, 0) } },
  }, meta: { engineId: 'builtin-equilibrium', method: 'equilibrium', coordinateSemantics: 'global-z-up', coordinateContractVersion: 1,
    dimension: '2d', plane: 'xz', dofOrder: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'], activeDofs: ['ux', 'uz', 'ry'],
    elementForceFrame: 'element-local', nodalResultFrame: 'global', forceConvention: 'section-cut-actions',
    componentDefinition: { verticalShear: 'V3', verticalBendingMoment: 'M2', verticalReaction: 'fz', saggingMomentSign: 'negative M2' },
    units: { force: 'kN', moment: 'kN.m' } } };
}
