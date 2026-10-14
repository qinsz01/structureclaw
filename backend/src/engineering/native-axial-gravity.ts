import { isRecord, type ModelRecord } from './model-state.js';
import type { RecoveryModel, Vec } from '../skill-shared/member-response.js';
import type { nativeRigidMember } from './native-rigid-offsets.js';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const close = (a: number, b: number) => Math.abs(a-b) <= 16*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b));
const vector = (value: unknown, expected: number[]): value is number[] => Array.isArray(value)
  && value.length === expected.length && value.every((v,i) => finite(v) && close(v,expected[i]));
const fail = (code = 'NATIVE_AXIAL_GRAVITY_UNVERIFIED'): never => { throw new Error(code); };
const decimal = (value: number) => Number(Number(value.toPrecision(15)).toPrecision(6));

/** Recover the physical uniform field from the audited equivalent axial load vector.
 * Native interior point-load forces are deliberately not used as uniform-load samples.
 */
export function yjkConsistentAxialGravity(model: RecoveryModel, context: ModelRecord, gravity: ModelRecord,
  segment: ModelRecord, rigid: ReturnType<typeof nativeRigidMember>): Array<{ a: number; b: number; q: Vec }> {
  const compilation = gravity.consistentLoadCompilation;
  const effective = context.effectiveLoads;
  const offsets = context.effectiveRigidOffsets;
  if (context.engine !== 'yjk' || !isRecord(compilation) || compilation.verified !== true
    || compilation.schema !== 'sclaw-yjk-consistent-axial-gravity/v1'
    || compilation.method !== 'axial-uniform-load-exact-virtual-work'
    || compilation.sourceModelHash !== (context.compiledModelHash ?? context.physicalModelHash)
    || !digest(compilation.sourceModelHash) || !digest(compilation.geometryFeaSha256)
    || !digest(compilation.sourceFeaSha256) || !isRecord(effective) || effective.verified !== true
    || compilation.sourceFeaSha256 !== effective.sourceFeaSha256 || !isRecord(offsets)
    || compilation.sourceFeaSha256 !== offsets.sourceFeaSha256 || !rigid || rigid.domain !== 'elastic-span'
    || !Array.isArray(compilation.members)) return fail();
  const matches = compilation.members.filter(row => isRecord(row) && row.sourceSegmentId === segment.sourceSegmentId);
  if (matches.length !== 1) return fail();
  const row = matches[0] as ModelRecord;
  const member = model.elements.find(item => item.id === segment.physicalElementId);
  const length = Number(segment.endM), net = rigid.end-rigid.start;
  if (!member || member.type !== 'column' || segment.startM !== 0 || segment.sourceSegmentId !== member.id
    || row.physicalElementId !== member.id || row.startM !== 0 || row.endM !== length
    || row.loadCaseId !== gravity.loadCaseId || !finite(row.elasticLengthM) || !close(row.elasticLengthM,net)
    || !Array.isArray(row.sourceNodeIds) || row.sourceNodeIds.length !== 2
    || row.sourceNodeIds.some((id,i) => id !== member.nodes[i])
    || !Array.isArray(row.nativeNodeIds) || row.nativeNodeIds.length !== 2 || row.nativeNodeIds[0] === row.nativeNodeIds[1]
    || row.nativeInteriorFieldSemantics !== 'computational-load-vector; not-physical-uniform-load'
    || !Array.isArray(row.sourceIntensityVectorKnM) || !vector(row.sourceIntensityVectorKnM,segment.intensityVectorKnM as Vec)
    || row.sourceIntensityVectorKnM[0] !== 0 || row.sourceIntensityVectorKnM[1] !== 0) return fail();
  const [first,last] = member.nodes.map(id => model.nodes.find(node => node.id === id));
  if (!first || !last || first.x !== last.x || first.y !== last.y || !close(Math.abs(last.z-first.z),length)) return fail();
  const constraints = isRecord(context.effectiveConstraints) ? context.effectiveConstraints : {};
  const supports = isRecord(constraints.supports) ? constraints.supports : {};
  const nodes = isRecord(supports.nodes) ? supports.nodes : {};
  if (supports.passed !== true || supports.sourceFeaSha256 !== compilation.sourceFeaSha256
    || member.nodes.some(id => !isRecord(nodes[id]) || typeof nodes[id].nativeNodeId !== 'string')) return fail();
  const nativeIdFor = (id: string) => isRecord(nodes[id]) ? nodes[id].nativeNodeId : undefined;
  const indices = row.nativeNodeIds.map(id => member.nodes.findIndex(node => nativeIdFor(node) === id));
  if (indices.some(index => index < 0) || indices[0] === indices[1]) return fail();
  const authored = row.sourceIntensityVectorKnM[2], sourceRigid = [rigid.start,length-rigid.end];
  if (!vector(row.nativeRigidLengthsM,indices.map(index => sourceRigid[index]))) return fail();
  const nativeRigid = row.nativeRigidLengthsM;
  let rigidSource = rigid.evidence.source as ModelRecord;
  const fields = isRecord(rigidSource.readbackFields) ? rigidSource.readbackFields : {};
  if (Array.isArray(fields.segments)) {
    const segments = fields.segments.filter(item => isRecord(item) && item.sourceSegmentId === segment.sourceSegmentId);
    if (segments.length !== 1 || !isRecord(segments[0].source)) return fail();
    rigidSource = segments[0].source;
  }
  if (rigidSource.nativeFrameId !== row.nativeFrameId || !isRecord(rigidSource.readbackFields)
    || !vector(rigidSource.readbackFields['FE.RZL'],row.nativeRigidLengthsM as Vec)) return fail();
  const planned = row.point, executed = row.executedPoint;
  if (!isRecord(planned) || !isRecord(executed) || planned.nativePositionM !== length/2
    || !vector(planned.forceVectorKn,[0,0,authored*net]) || executed.nativePositionM !== decimal(length/2)
    || !vector(executed.forceVectorKn,[0,0,decimal(authored*net)])
    || !Array.isArray(executed.nativeValues) || executed.nativeValues.length !== 2
    || executed.nativeValues[0] !== executed.nativePositionM || !finite(executed.nativeValues[1])) return fail();
  const nativeAxialZ = (indices[0] === 0 ? last.z-first.z : first.z-last.z)/length;
  const actualZ = executed.nativeDirection === 'GZ' ? executed.nativeValues[1]
    : executed.nativeDirection === 'LX' ? executed.nativeValues[1]*nativeAxialZ : NaN;
  if (!finite(actualZ) || !close(actualZ,executed.forceVectorKn[2])
    || !Array.isArray(row.consistentEndForceVectorKn) || row.consistentEndForceVectorKn.length !== 2
    || row.consistentEndForceVectorKn.some((value,i) => !vector(value,[0,0,authored*(net/2+nativeRigid[i])]))
    || !Array.isArray(row.rigidSegmentNodeLoads) || !Array.isArray(row.nativeNodeAggregates)) return fail();
  const portions = [{a:rigid.start,b:rigid.end,q:[0,0,actualZ/net] as Vec}];
  const armCount = sourceRigid.filter(value => value > 0).length;
  if (row.rigidSegmentNodeLoads.length !== armCount || row.nativeNodeAggregates.length !== armCount) return fail();
  for (const [index,arm] of sourceRigid.entries()) {
    if (!arm) continue;
    const nodeId = member.nodes[index], nativeId = nativeIdFor(nodeId);
    const loads = row.rigidSegmentNodeLoads.filter(item => isRecord(item) && item.sourceNodeId === nodeId);
    const aggregates = row.nativeNodeAggregates.filter(item => isRecord(item) && item.sourceNodeId === nodeId);
    if (loads.length !== 1 || aggregates.length !== 1 || loads[0].nativeNodeId !== nativeId
      || aggregates[0].nativeNodeId !== nativeId || !finite(loads[0].lengthM) || !close(loads[0].lengthM,arm)
      || !vector(loads[0].forceVectorKn,[0,0,authored*arm])) return fail();
    const aggregate = aggregates[0];
    // A rounded sum cannot establish an individual member's share. Do not invent
    // a distribution when another member/action contributes to the same record.
    if (!vector(aggregate.sourceTotalForceVectorKn,[0,0,authored*arm])) return fail('NATIVE_AXIAL_GRAVITY_NODE_SHARE_UNVERIFIED');
    if (!vector(aggregate.executedTotalForceVectorKn,[0,0,decimal(authored*arm)])) return fail();
    portions.push({a:index === 0 ? 0 : rigid.end,b:index === 0 ? rigid.start : length,
      q:[0,0,aggregate.executedTotalForceVectorKn[2]/arm]});
  }
  return portions.sort((a,b) => a.a-b.a);
}
