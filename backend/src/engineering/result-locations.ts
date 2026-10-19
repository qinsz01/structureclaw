import { isRecord } from './model-record.js';

type ModelGeometry = { nodes?: unknown; elements?: unknown };
export type GlobalPoint = { x: number; y: number; z: number };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Physical member axis, from its first node; coordinates retain the model's length unit (SI: m). */
export function memberGlobalPoint(model: ModelGeometry | undefined, elementId: unknown, position: unknown): GlobalPoint | undefined {
  const element = Array.isArray(model?.elements) ? model.elements.find(row => isRecord(row) && row.id === elementId) : undefined;
  if (!isRecord(element) || !Array.isArray(element.nodes) || element.nodes.length !== 2 || !Array.isArray(model?.nodes)) return undefined;
  const nodeIds = element.nodes;
  const start = model.nodes.find(row => isRecord(row) && row.id === nodeIds[0]);
  const end = model.nodes.find(row => isRecord(row) && row.id === nodeIds[1]);
  if (!isRecord(start) || !isRecord(end)) return undefined;
  const { x: ax, y: ay, z: az } = start, { x: bx, y: by, z: bz } = end;
  if (![ax, ay, az, bx, by, bz].every(finite)) return undefined;
  const a = { x: ax as number, y: ay as number, z: az as number };
  const b = { x: bx as number, y: by as number, z: bz as number };
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  if (!length) return undefined;
  if (position === 'n1') return a;
  if (position === 'n2') return b;
  const roundoff = 8 * Number.EPSILON * Math.max(1, length);
  if (!finite(position) || position < -roundoff || position > length + roundoff) return undefined;
  const fraction = Math.max(0, Math.min(length, position)) / length;
  return { x: a.x + fraction * (b.x - a.x), y: a.y + fraction * (b.y - a.y), z: a.z + fraction * (b.z - a.z) };
}

export function withGlobalMemberLocation<T extends Record<string, unknown>>(model: ModelGeometry | undefined, location: T): T & { global?: GlobalPoint } {
  const global = memberGlobalPoint(model, location.elementId ?? (location.kind === 'member' ? location.id : undefined),
    location.positionM ?? location.position ?? location.end);
  return global ? { ...location, global } : location;
}

/** Add coordinates to public result locations without changing their local fields or saved source evidence. */
export function withGlobalResultLocations(model: ModelGeometry | undefined, data: Record<string, unknown>): Record<string, unknown> {
  const locations = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
    .map(([key, row]) => [key, isRecord(row) ? withGlobalMemberLocation(model, row) : row]));
  const envelope = isRecord(data.envelope) ? data.envelope : undefined;
  const summary = isRecord(data.summary) ? data.summary : undefined;
  const extrema = isRecord(data.memberResponseExtrema) ? data.memberResponseExtrema : undefined;
  return { ...data,
    ...(envelope && isRecord(envelope.controlLocations) ? { envelope: { ...envelope, controlLocations: locations(envelope.controlLocations) } } : {}),
    ...(summary && isRecord(summary.maxDisplacementLocation) ? { summary: { ...summary,
      maxDisplacementLocation: withGlobalMemberLocation(model, summary.maxDisplacementLocation) } } : {}),
    ...(extrema && isRecord(extrema.values) ? { memberResponseExtrema: { ...extrema, values: locations(extrema.values) } } : {}),
    ...(Array.isArray(data.memberResponses) ? { memberResponses: data.memberResponses.map(member => {
      if (!isRecord(member) || !Array.isArray(member.samples)) return member;
      return { ...member, samples: member.samples.map(sample => {
        if (!isRecord(sample)) return sample;
        const global = memberGlobalPoint(model, member.id, sample.x);
        return global ? { ...sample, global } : sample;
      }) };
    }) } : {}),
    ...(isRecord(data.memberStations) ? { memberStations: Object.fromEntries(Object.entries(data.memberStations).map(([id, rows]) =>
      [id, Array.isArray(rows) ? rows.map(row => {
        if (!isRecord(row)) return row;
        const global = memberGlobalPoint(model, id, row.positionM);
        return global ? { ...row, global } : row;
      }) : rows])) } : {}),
  };
}
