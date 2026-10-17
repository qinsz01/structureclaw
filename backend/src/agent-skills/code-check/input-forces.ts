/** Member force states and deflections recovered from analysis results for code checking. */
import type { recoverAnalysisMembers } from '../../engineering/member-response-query.js';
import { asRecord, hasRecordKeys } from './input-context.js';

/**
 * Take the larger absolute value of two numbers; returns undefined if both are falsy.
 */
export const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export type ForceState = { source: string; station: string | number; positionM?: number; segmentId?: string; side?: string; forces: Record<string, number>; unsupportedReason?: string };

/** A rigid translation/rotation of the member is not its serviceability deflection. */
export function memberDeflection(member: ReturnType<typeof recoverAnalysisMembers>[number] | undefined) {
  if (!member || member.state !== 'recovered' || !member.axes || !member.samples.length || member.length <= 0) return undefined;
  const first = member.samples[0]!, last = member.samples.at(-1)!;
  let governing: { valueMm: number; positionM: number; componentsLocalMm: number[] } | undefined;
  for (const sample of member.samples) {
    const ratio = sample.x / member.length;
    const relative = sample.displacement.map((value, i) => value - (1 - ratio) * first.displacement[i]! - ratio * last.displacement[i]!);
    const transverse = [member.axes[1]!, member.axes[2]!].map(axis => axis.reduce((sum, value, i) => sum + value * relative[i]!, 0) * 1000);
    const valueMm = Math.hypot(...transverse);
    if (!governing || valueMm > governing.valueMm) governing = { valueMm, positionM: sample.x, componentsLocalMm: transverse };
  }
  return governing && { ...governing, source: 'mechanics-recovery',
    definition: 'transverse-displacement-relative-to-endpoint-chord', numericalScope: 'sampled-member-response' };
}

/** The beam template may contain several physical members, e.g. at a point load.
 * Only an unbranched, collinear, simply-supported/cantilever beam has an implicit
 * whole-span reference. Never infer such a group for a frame or continuous beam.
 */
export function standaloneBeamDeflection(model: Record<string, unknown>, members: Map<string, ReturnType<typeof recoverAnalysisMembers>[number]>, data: Record<string, unknown>) {
  const metadata = asRecord(model['metadata']), coordinates = asRecord(model['coordinate_system']);
  if (coordinates['dimension'] !== '2d' || metadata['inferredType'] !== undefined && metadata['inferredType'] !== 'beam') return;
  let support = metadata['supportType'];
  if (support !== undefined && !['simply-supported', 'cantilever'].includes(String(support))) return;
  const elements = Array.isArray(model['elements']) ? model['elements'].map(asRecord) : [];
  if (!elements.length) return;
  const nodes = new Map((Array.isArray(model['nodes']) ? model['nodes'].map(asRecord) : []).map(node => [String(node['id']), node]));
  const adjacency = new Map<string, string[]>();
  for (const element of elements) {
    const ends = element['nodes'];
    if (element['type'] !== 'beam' || !Array.isArray(ends) || ends.length !== 2
      || Object.keys(asRecord(element['releases'])).length || Object.keys(asRecord(element['offsets'])).length
      || members.get(String(element['id']))?.state !== 'recovered') return;
    for (const id of ends) adjacency.set(String(id), [...(adjacency.get(String(id)) ?? []), String(element['id'])]);
  }
  const endpoints = [...adjacency].filter(([, edges]) => edges.length === 1).map(([id]) => id);
  if (endpoints.length !== 2 || [...adjacency.values()].some(edges => edges.length > 2)) return;
  // Traversal excludes a disconnected cycle plus an otherwise valid open chain.
  const visited = new Set<string>(), pending = [endpoints[0]!];
  while (pending.length) {
    const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id);
    for (const element of elements.filter(element => (element['nodes'] as string[]).includes(id))) pending.push(...element['nodes'] as string[]);
  }
  if (visited.size !== adjacency.size) return;
  const vertical = coordinates['plane'] === 'xz' ? 2 : 1, rotation = vertical === 2 ? 4 : 5;
  const restrained = (id: string, dof: number) => (nodes.get(id)?.['restraints'] as unknown[] | undefined)?.[dof] === true;
  if ([...adjacency.keys()].some(id => !endpoints.includes(id) && [0, vertical, rotation].some(dof => restrained(id, dof)))) return;
  // Explicit models need not carry template metadata. Infer only these two
  // endpoint conditions from the actual restraints on the verified beam chain.
  if (support === undefined) {
    const fixed = endpoints.filter(id => [0, vertical, rotation].every(dof => restrained(id, dof)));
    if (fixed.length === 1 && ![0, vertical, rotation].some(dof => restrained(endpoints.find(id => id !== fixed[0])!, dof))) support = 'cantilever';
    else if (endpoints.every(id => restrained(id, vertical)) && !endpoints.some(id => restrained(id, rotation))) support = 'simply-supported';
    else return;
  }
  if (support === 'simply-supported' && elements.length === 1) return;
  if (support === 'simply-supported' && (!endpoints.every(id => restrained(id, vertical)) || endpoints.some(id => restrained(id, rotation)))) return;
  if (support === 'cantilever') {
    const fixed = endpoints.filter(id => [0, vertical, rotation].every(dof => restrained(id, dof)));
    if (fixed.length !== 1 || [0, vertical, rotation].some(dof => restrained(endpoints.find(id => id !== fixed[0])!, dof))) return;
    endpoints.sort(id => id === fixed[0] ? -1 : 1);
  }
  const point = (id: string) => ['x', 'y', 'z'].map(key => Number(nodes.get(id)?.[key]));
  const start = point(endpoints[0]!), end = point(endpoints[1]!);
  const delta = end.map((value, i) => value - start[i]!), span = Math.hypot(...delta);
  if (!(span > 0) || !Number.isFinite(span)) return;
  const axis = delta.map(value => value / span);
  const position = (point: number[]) => point.reduce((sum, value, i) => sum + (value - start[i]!) * axis[i]!, 0);
  if ([...adjacency.keys()].some(id => {
    const p = point(id), x = position(p);
    return x < -1e-9 || x > span + 1e-9 || Math.hypot(...p.map((value, i) => value - start[i]! - x * axis[i]!)) > 1e-9;
  })) return;
  const samples = [...members.values()].flatMap(member => member.samples.map(sample => ({ ...sample, memberId: member.id })));
  const atStart = samples.find(sample => Math.abs(position(sample.position)) < 1e-9);
  const atEnd = samples.find(sample => Math.abs(position(sample.position) - span) < 1e-9);
  if (!atStart || !atEnd) return;
  const fixedDisplacements = asRecord(asRecord(data['displacements'])[endpoints[0]!]);
  const angle = fixedDisplacements[vertical === 2 ? 'ry' : 'rz'];
  if (support === 'cantilever' && !finiteNumber(angle)) return;
  let governing: { valueMm: number; positionM: number; memberId: string } | undefined;
  for (const sample of samples) {
    const x = position(sample.position);
    const offset = sample.position.map((value, i) => value - start[i]!);
    const rigidRotation = vertical === 2 ? [Number(angle) * offset[2]!, 0, -Number(angle) * offset[0]!]
      : [-Number(angle) * offset[1]!, Number(angle) * offset[0]!, 0];
    const relative = sample.displacement.map((value, i) => value - atStart.displacement[i]!
      - (support === 'simply-supported' ? x / span * (atEnd.displacement[i]! - atStart.displacement[i]!) : rigidRotation[i]!));
    const longitudinal = relative.reduce((sum, value, i) => sum + value * axis[i]!, 0);
    const valueMm = Math.hypot(...relative.map((value, i) => value - longitudinal * axis[i]!)) * 1000;
    if (!governing || valueMm > governing.valueMm) governing = { valueMm, positionM: x, memberId: sample.memberId };
  }
  return governing && { ...governing, source: 'mechanics-recovery', serviceabilityLengthMm: span * 1000,
    referenceNodeIds: endpoints, definition: support === 'simply-supported' ? 'transverse-displacement-relative-to-whole-span-chord' : 'transverse-displacement-relative-to-fixed-end',
    numericalScope: 'sampled-member-response' };
}

export function forceUnitFactors(analysis: Record<string, unknown>, data: Record<string, unknown>): { force: number; moment: number } | undefined {
  const meta = asRecord(analysis['meta']);
  const units = asRecord(meta['units'] ?? data['units']);
  if (units['force'] === 'kN' && ['kN.m', 'kN·m'].includes(String(units['moment']))) return { force: 1000, moment: 1e6 };
  if (units['force'] === 'N' && ['N.mm', 'N·mm'].includes(String(units['moment']))) return { force: 1, moment: 1 };
  // Documented compatibility for old built-in responses, never infer units from value size.
  if (!hasRecordKeys(units) && ['builtin-opensees', 'builtin-pkpm'].includes(String(meta['analysisAdapterKey'] ?? meta['engineId']))) return { force: 1000, moment: 1e6 };
  return undefined;
}

export function codeCheckForceState(raw: Record<string, unknown>, factors: { force: number; moment: number }, source: string, station: string | number, bendingAxis: 2 | 3 = 2): ForceState {
  const forces: Record<string, number> = {};
  for (const name of ['N', 'V2', 'V3', 'V']) if (finiteNumber(raw[name])) forces[name] = raw[name] * factors.force;
  for (const name of ['T', 'M2', 'M3', 'M', 'Mx', 'M_service']) if (finiteNumber(raw[name])) forces[name] = raw[name] * factors.moment;
  const canonical = finiteNumber(raw['M2']) || finiteNumber(raw['V3']);
  if (canonical) {
    // Select the explicit section axis; never use 3-D vector magnitudes.
    const moment = bendingAxis === 2 ? 'M2' : 'M3', shear = bendingAxis === 2 ? 'V3' : 'V2';
    if (finiteNumber(forces[moment])) forces['Mx'] = forces[moment];
    if (finiteNumber(forces[shear])) forces['V'] = forces[shear];
  } else if (finiteNumber(forces['M'])) forces['Mx'] = forces['M'];
  const biaxial = canonical && (bendingAxis === 2 ? ['M3', 'T', 'V2'] : ['M2', 'T', 'V3']).some(key => finiteNumber(raw[key]) && Math.abs(raw[key]) > 1e-12);
  return { source, station, forces, ...(biaxial ? { unsupportedReason: 'Biaxial bending, transverse shear or torsion requires a supported combined check / 双向弯曲、横向剪切或扭转尚缺相应组合验算。' } : {}) };
}
