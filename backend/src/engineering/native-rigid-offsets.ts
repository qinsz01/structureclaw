import { isRecord, type ModelRecord } from './model-state.js';

/** Rigid lengths are read back from the native model, never inferred from a carrier. */
export function nativeRigidMember(model: ModelRecord, context: ModelRecord,
  member: { id: string; nodes: string[] }, length: number) {
  const enabled = isRecord(model.analysis_control) && model.analysis_control.rigid_offsets === true;
  const offsets = context.effectiveRigidOffsets;
  if (!enabled && offsets === undefined) return undefined;
  const fail = (): never => { throw new Error('NATIVE_RIGID_OFFSETS_UNVERIFIED'); };
  if (!enabled || !isRecord(offsets) || offsets.verified !== true
    || !/^[a-f0-9]{64}$/i.test(String(offsets.sourceFeaSha256))
    || offsets.method !== 'native-rigid-end-readback' || !isRecord(offsets.members)) return fail();
  const value = offsets.members[member.id];
  if (!isRecord(value) || !Array.isArray(value.sourceNodeIds)
    || value.sourceNodeIds.length !== 2 || value.sourceNodeIds.some((id, i) => id !== member.nodes[i])
    || !['physicalLengthM', 'elasticStartM', 'elasticEndM', 'startLengthM', 'endLengthM']
      .every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))
    || !['elastic-span', 'physical-endpoints'].includes(String(value.nativeStationDomain))
    || !isRecord(value.source) || !Object.keys(value.source).length) return fail();
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, length);
  const start = Number(value.elasticStartM), end = Number(value.elasticEndM);
  if (!close(Number(value.physicalLengthM), length) || start < 0 || end > length || end <= start
    || !close(Number(value.startLengthM), start) || !close(Number(value.endLengthM), length - end)) return fail();
  return { start, end, domain: String(value.nativeStationDomain), evidence: value };
}
