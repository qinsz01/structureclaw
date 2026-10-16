import type { RecoveryModel, Vec } from './member-response.js';
import { isRecord, type ModelRecord } from './model-state.js';
import { nativeRigidMember } from './native-rigid-offsets.js';
import { pkpmExecutedUniformLoad } from './native-load-readback.js';
import { yjkConsistentAxialGravity } from './native-axial-gravity.js';

const keys = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'] as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
type Cut = { positionM: number; side: unknown; components: ModelRecord; source: unknown; localAxes?: unknown };
type Line = { a: number; b: number; q: Vec; slope: Vec };
type Point = { x: number; force: Vec; moment: Vec };
const fail = (details?: ModelRecord): never => { throw new Error('NATIVE_FORCE_RECOVERY_UNVERIFIED', { cause: details }); };
const vector = (row: ModelRecord, names: string[]): Vec => names.map(key => {
  const value = row[key] ?? 0;
  if (!finite(value)) return fail();
  return value;
}) as Vec;
const dot = (a: Vec, b: Vec) => a.reduce((sum, value, index) => sum + value * b[index], 0);

/** Signed cut equilibrium; no constitutive law, displacement or interpolation. */
export function nativeForceRecovery(model: RecoveryModel, data: ModelRecord, memberId: string,
  rows: Cut[], length: number, factors: Record<string, number> | undefined) {
  const context = isRecord(data.nativeContext) ? data.nativeContext : {};
  if (context.linearStatic !== true || context.effectiveSettingsVerified !== true || context.stationConventionsVerified !== true
    || ['engine','engineVersion','physicalModelHash','stiffnessHash','settingsHash'].some(key=>typeof context[key]!=='string'||!context[key])
    || !factors || !Object.keys(factors).length) return fail();
  const rawModel = model as unknown as ModelRecord;
  if (!isRecord(rawModel.analysis_control) || typeof rawModel.analysis_control.self_weight !== 'boolean'
    || model.stories?.some(story => Array.isArray(story.floor_loads) && story.floor_loads.length)) return fail();
  const member = model.elements.find(row => row.id === memberId);
  if (!member) return fail();
  const rigid = nativeRigidMember(rawModel, context, member, length);
  if (rigid) {
    const offsets = context.effectiveRigidOffsets as ModelRecord;
    if (offsets.sourceLoadSemanticsPreserved !== true || !isRecord(offsets.loadCompilation)
      || typeof offsets.loadCompilation.method !== 'string' || !offsets.loadCompilation.method
      || offsets.loadCompilation.sourceFeaSha256 !== offsets.sourceFeaSha256) return fail();
  }
  const elastic = rigid?.domain === 'elastic-span';
  const origin = elastic ? rigid.start : 0, finish = elastic ? rigid.end : length;
  const closePosition = (a: number, b: number) => Math.abs(a - b) <= 8 * Number.EPSILON * Math.max(1, length);
  const start = rows.find(row => closePosition(row.positionM, origin) && (row.side === 'right' || elastic && row.side === 'continuous'));
  const end = rows.find(row => closePosition(row.positionM, finish) && (row.side === 'left' || elastic && row.side === 'continuous'));
  if (!start || !end || !Array.isArray(start.localAxes) || start.localAxes.length !== 3) return fail();
  if (rows.some(row => row.positionM < origin && !closePosition(row.positionM, origin)
    || row.positionM > finish && !closePosition(row.positionM, finish)
    || keys.some(key => !finite(row.components[key])))) return fail();
  const axes = start.localAxes as Vec[];
  if (axes.some(axis => !Array.isArray(axis) || axis.length !== 3 || !axis.every(finite))
    || axes.some((axis, i) => axes.some((other, j) => Math.abs(dot(axis, other) - (i === j ? 1 : 0)) > 1e-9))
    || rows.some(row => JSON.stringify(row.localAxes) !== JSON.stringify(axes))) return fail();
  const first = member && model.nodes.find(node => node.id === member.nodes[0]);
  const last = member && model.nodes.find(node => node.id === member.nodes[1]);
  if (!first || !last || axes[0].some((v, i) => Math.abs(v - ([last.x-first.x,last.y-first.y,last.z-first.z][i]/length)) > 1e-9)) return fail();
  const local = (value: Vec, load: ModelRecord, factor: number): Vec => {
    if (load.reference_frame !== undefined && !['global', 'element-local'].includes(String(load.reference_frame))) return fail();
    return (load.reference_frame === 'element-local' ? value : axes.map(axis => dot(value, axis))).map(v => v * factor) as Vec;
  };
  const lines: Line[] = [], points: Point[] = [];
  const effectiveLoads = isRecord(context.effectiveLoads) ? context.effectiveLoads : {};
  const gravity = isRecord(effectiveLoads.selfWeight) ? effectiveLoads.selfWeight : {};
  let loadBasis = 'authored-loads';
  if (rawModel.analysis_control.self_weight) {
    if (effectiveLoads.verified !== true || !/^[a-f0-9]{64}$/i.test(String(effectiveLoads.sourceFeaSha256))
      || gravity.enabled !== true || typeof gravity.loadCaseId !== 'string'
      || !model.load_cases.some(row => row.id === gravity.loadCaseId)
      || !Array.isArray(gravity.members) || !Array.isArray(gravity.physicalCompilation)) return fail();
    const segments = gravity.physicalCompilation.filter(row => isRecord(row) && row.physicalElementId === memberId)
      .sort((a, b) => Number(a.startM) - Number(b.startM));
    if (!segments.length) return fail();
    const factor = factors[gravity.loadCaseId] ?? 0;
    if (!finite(factor)) return fail();
    let cursor = 0;
    const used = new Set<string>();
    const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    const executed = gravity.executedCompilation;
    if (executed !== undefined && (!Array.isArray(executed) || context.engine !== 'yjk'
      || !isRecord(gravity.inputQuantization) || gravity.inputQuantization.source !== 'fea.dat'
      || gravity.inputQuantization.significantDigits !== 6)) return fail();
    const executedSegments = Array.isArray(executed)
      ? executed.filter(row => isRecord(row) && row.physicalElementId === memberId) : undefined;
    if (!executedSegments && isRecord(gravity.consistentLoadCompilation)
      && Array.isArray(gravity.consistentLoadCompilation.members)
      && gravity.consistentLoadCompilation.members.some(row => isRecord(row) && row.physicalElementId === memberId)) return fail();
    if (executedSegments && executedSegments.length !== segments.length) return fail();
    for (const segment of segments) {
      const { startM, endM, sourceSegmentId, intensityVectorKnM } = segment;
      if (!finite(startM) || !finite(endM) || startM < 0 || endM > length || startM >= endM || !close(startM, cursor)
        || typeof sourceSegmentId !== 'string' || used.has(sourceSegmentId)
        || !Array.isArray(intensityVectorKnM) || intensityVectorKnM.length !== 3 || !intensityVectorKnM.every(finite)) return fail();
      const native = gravity.members.filter(row => isRecord(row) && row.elementId === sourceSegmentId);
      if (native.length !== 1 || !finite(native[0].lengthM) || !close(native[0].lengthM, endM - startM)
        || !Array.isArray(native[0].intensityVectorKnM) || native[0].intensityVectorKnM.length !== 3
        || !Array.isArray(native[0].totalForceVectorKn) || native[0].totalForceVectorKn.length !== 3
        || intensityVectorKnM.some((value, i) => !finite(native[0].intensityVectorKnM[i])
          || !finite(native[0].totalForceVectorKn[i]) || !close(value, native[0].intensityVectorKnM[i])
          || !close(value * (endM - startM), native[0].totalForceVectorKn[i]))) return fail();
      used.add(sourceSegmentId);
      let effectiveVector = intensityVectorKnM as Vec;
      if (executedSegments) {
        const matches = executedSegments.filter(row => row.sourceSegmentId === sourceSegmentId);
        if (matches.length !== 1) return fail();
        const actual = matches[0];
        if (actual.executionMethod === 'consistent-axial-load-vector') {
          if (actual.startM !== startM || actual.endM !== endM || !Array.isArray(actual.intensityVectorKnM)
            || actual.intensityVectorKnM.length !== 3 || actual.intensityVectorKnM.some((value: unknown,i: number) => value !== intensityVectorKnM[i])) return fail();
          const portions = yjkConsistentAxialGravity(model,context,gravity,segment,rigid);
          for (const portion of portions) lines.push({a:portion.a,b:portion.b,q:local(portion.q,{reference_frame:'global'},factor),slope:[0,0,0]});
          loadBasis = 'audited-native-input';
          cursor = endM;
          continue;
        }
        if (actual.executionMethod !== undefined || isRecord(gravity.consistentLoadCompilation)
          && Array.isArray(gravity.consistentLoadCompilation.members)
          && gravity.consistentLoadCompilation.members.some(row => isRecord(row) && row.sourceSegmentId === sourceSegmentId)) return fail();
        if (actual.startM !== startM || actual.endM !== endM || !Array.isArray(actual.intensityVectorKnM)
          || actual.intensityVectorKnM.length !== 3 || actual.intensityVectorKnM.some((value: unknown, index: number) =>
            !finite(value) || Math.abs(value - Number(intensityVectorKnM[index].toPrecision(6)))
              > 8 * Number.EPSILON * Math.max(1, Math.abs(value)))) return fail();
        effectiveVector = actual.intensityVectorKnM as Vec;
        loadBasis = 'audited-native-input';
      }
      lines.push({ a: startM, b: endM, q: local(effectiveVector, { reference_frame: 'global' }, factor), slope: [0, 0, 0] });
      cursor = endM;
    }
    if (!close(cursor, length)) return fail();
  } else if (gravity.enabled === true) return fail();
  for (const [caseId, factor] of Object.entries(factors)) {
    const loadCase = model.load_cases.find(row => row.id === caseId);
    if (!loadCase || !finite(factor)) return fail();
    for (const [sourceIndex, load] of loadCase.loads.entries()) {
      if (load.element !== memberId) continue;
      if (load.type === 'point') {
        if (!finite(load.position) || load.position < 0 || load.position > length) return fail();
        points.push({x:load.position,force:local(vector(load,['fx','fy','fz']),load,factor),
          moment:local(vector(load,['mx','my','mz']),load,factor)});
      } else if (load.type === 'distributed') {
        const a = load.start ?? 0, b = load.end ?? length;
        if (!finite(a) || !finite(b) || a < 0 || b > length || a >= b) return fail();
        if (load.distribution === 'piecewise_linear') {
          if (!Array.isArray(load.points) || load.points.length < 2) return fail();
          const ordinates = load.points;
          if (ordinates.some((p, i) => !isRecord(p) || !finite(p.position) || p.position < 0 || p.position > 1
            || (i > 0 && p.position <= ordinates[i-1].position))) return fail();
          if (ordinates[0].position * length > a || ordinates.at(-1).position * length < b) return fail();
          for (let index = 0; index < ordinates.length - 1; index++) {
            const left = ordinates[index], right = ordinates[index + 1];
            const origin = left.position * length, finish = right.position * length;
            const lo = Math.max(origin,a), hi = Math.min(finish,b);
            if (hi <= lo) continue;
            const q0=local(vector(left,['wx','wy','wz']),load,factor), q1=local(vector(right,['wx','wy','wz']),load,factor);
            const slope=q0.map((v,i)=>(q1[i]-v)/(finish-origin)) as Vec;
            lines.push({a:lo,b:hi,q:q0.map((v,i)=>v+slope[i]*(lo-origin)) as Vec,slope});
          }
        } else {
          if (load.distribution !== undefined && load.distribution !== 'uniform') return fail();
          const authored = vector(load,['wx','wy','wz']);
          const executed = rigid ? pkpmExecutedUniformLoad(context,caseId,sourceIndex,memberId,length,[rigid.start,rigid.end],authored) : undefined;
          if (executed && rigid) {
            if (a !== 0 || b !== length || load.reference_frame !== undefined && load.reference_frame !== 'global') return fail();
            // The native text bridge changes only the elastic-span intensity.
            // Loads physically on each rigid arm keep their authored integrals.
            for (const [lo,hi,q] of [[0,rigid.start,authored],[rigid.start,rigid.end,executed],[rigid.end,length,authored]] as [number,number,Vec][]) {
              if (hi>lo) lines.push({a:lo,b:hi,q:local(q,load,factor),slope:[0,0,0]});
            }
            loadBasis = 'audited-native-input';
          } else lines.push({a,b,q:local(authored,load,factor),slope:[0,0,0]});
        }
      } else return fail();
    }
  }
  const integrals = (x: number, side: 'left' | 'right') => {
    // Adding solver segment lengths may move the same physical cut by one
    // floating-point ulp (e.g. 1.7 -> 1.7000000000000002). Preserve its side.
    const coincident = points.find(point=>Math.abs(point.x-x)<=8*Number.EPSILON*Math.max(1,length));
    if(coincident) x=coincident.x;
    const force=[0,0,0], lever=[0,0,0], moment=[0,0,0];
    for (const line of lines) {
      const t=Math.max(0,Math.min(x,line.b)-line.a);
      for(let i=0;i<3;i++) {
        const integral=line.q[i]*t+line.slope[i]*t*t/2;
        force[i]+=integral;
        lever[i]+=(x-line.a)*integral-line.q[i]*t*t/2-line.slope[i]*t*t*t/3;
      }
    }
    for(const point of points) if(point.x>0 && (point.x<x || (point.x===x && side==='right'))) {
      for(let i=0;i<3;i++) { force[i]+=point.force[i]; lever[i]+=point.force[i]*(x-point.x); moment[i]+=point.moment[i]; }
    }
    return { x, force, lever, moment };
  };
  const anchor = integrals(start.positionM, start.side === 'left' ? 'left' : 'right');
  const at = (x: number, side: 'left' | 'right') => {
    if (!finite(x) || x < 0 || x > length || (x === 0 && side !== 'right') || (x === length && side !== 'left')) return fail();
    const target = integrals(x, side), dx = target.x - anchor.x;
    const force = target.force.map((value, i) => value - anchor.force[i]);
    const lever = target.lever.map((value, i) => value - anchor.lever[i] - anchor.force[i] * dx);
    const moment = target.moment.map((value, i) => value - anchor.moment[i]);
    const c = start.components as Record<typeof keys[number], number>;
    return {N:c.N-force[0],Vy:c.Vy+force[1],Vz:c.Vz+force[2],T:c.T-moment[0],
      My:c.My-c.Vz*dx-lever[2]-moment[1],Mz:c.Mz+c.Vy*dx+lever[1]-moment[2]};
  };
  // Existing frozen commercial force tolerances check closure; this does not
  // alter solver acceptance tolerances, raw values or benchmark references.
  for(const row of rows) {
    if(row.side==='continuous' && points.some(p=>p.x===row.positionM)) return fail();
    const expected=at(Math.min(length,row.positionM),row.side==='left'?'left':'right');
    for (const key of keys) {
      const actual = Number(row.components[key]), tolerance = Math.max(1e-5, 1e-5*Math.abs(actual));
      if (Math.abs(expected[key]-actual) > tolerance) return fail({ code: 'NATIVE_STATION_EQUILIBRIUM_MISMATCH',
        memberId, positionM: row.positionM, side: row.side, component: key, nativeValue: actual,
        recoveredValue: expected[key], absoluteDifference: Math.abs(expected[key]-actual), tolerance,
        unit: ['T','My','Mz'].includes(key) ? 'kN.m' : 'kN' });
    }
  }
  return {at,breakpoints:[...new Set([0,length,...(rigid ? [rigid.start, rigid.end] : []),...lines.flatMap(line=>[line.a,line.b]),...points.map(point=>point.x)])].sort((a,b)=>a-b),
    jumps:[...new Set(points.map(point=>point.x).filter(x=>x>0&&x<length))],
    source:{kind:'section-equilibrium',method:'exact-load-integration',loadBasis,factors:{...factors},anchor:start.source,
      anchorPositionM:start.positionM,anchorSide:start.side,
      verification:'all-native-stations',units:{force:'kN',moment:'kN.m'},nativeContext:context}};
}
