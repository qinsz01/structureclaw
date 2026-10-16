import type { MemberResponse, RecoveryModel } from './member-response.js';
import { isRecord, type ModelRecord } from './model-state.js';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const metrics = {
  displacement: 'maxAbsDisplacement', axialForce: 'maxAbsAxialForce', shearForce: 'maxAbsShearForce',
  moment: 'maxAbsMoment', reaction: 'maxAbsReaction', reactionMoment: 'maxAbsReactionMoment',
} as const;
type Quantity = keyof typeof metrics;
const controlFields = {
  displacement: 'controlNodeDisplacement', axialForce: 'controlElementAxialForce',
  shearForce: 'controlElementShearForce', moment: 'controlElementMoment', reaction: 'controlNodeReaction',
  reactionMoment: 'controlNodeReactionMoment',
} as const;

/** Preserve direct solver extrema and include verified member samples, never display interpolation.
 * Vector resultants are evaluated at one station; this is a sampled, not continuous, envelope.
 */
export function withRecoveredStaticEnvelope(
  model: RecoveryModel, data: ModelRecord, members: MemberResponse[], selection: ModelRecord,
): ModelRecord {
  const envelope: ModelRecord = { ...(isRecord(data.envelope) ? data.envelope : {}) };
  const locations: ModelRecord = {};
  const resultKey = `${String(selection.kind)}:${String(selection.id)}`;
  const elements = new Map(model.elements.map(row => [row.id, row]));
  const nodes = new Map(model.nodes.map(row => [row.id, row]));
  // Keep direct solver extrema even if a legacy result has no recoverable raw
  // representation. Such a location deliberately carries no invented station.
  for (const quantity of Object.keys(metrics) as Quantity[]) {
    const previous = envelope[metrics[quantity]], control = envelope[controlFields[quantity]];
    if (quantity === 'reactionMoment' && !finite(previous)) continue;
    envelope[metrics[quantity]] = finite(previous) && previous >= 0 ? previous : 0;
    if (finite(previous) && previous >= 0) {
      const isNode = quantity === 'displacement' || quantity === 'reaction' || quantity === 'reactionMoment';
      locations[quantity] = { kind: typeof control === 'string' && control ? isNode ? 'node' : 'member' : 'envelope',
        ...(typeof control === 'string' && control ? { [isNode ? 'nodeId' : 'elementId']: control } : {}),
        provenance: 'solver-direct-envelope', resultKey };
    }
  }
  const update = (quantity: Quantity, magnitude: number | undefined, location: ModelRecord) => {
    if (!finite(magnitude)) return;
    const metric = metrics[quantity], previous = envelope[metric];
    const locationKnown = isRecord(locations[quantity]) && locations[quantity].provenance !== 'solver-direct-envelope';
    if (finite(previous) && (magnitude < previous || magnitude === previous && locationKnown)) return;
    envelope[metric] = magnitude;
    locations[quantity] = { ...location, resultKey };
    envelope[controlFields[quantity]] = quantity === 'displacement' || quantity === 'reaction' || quantity === 'reactionMoment'
      ? location.nodeId ?? '' : location.elementId ?? '';
    if (quantity === 'displacement') envelope.controlElementDisplacement = location.elementId ?? '';
  };
  const vectorMagnitude = (values: unknown[]) => values.every(finite) ? Math.hypot(...values) : undefined;
  const endMagnitude = (end: ModelRecord, components: string[], legacy: string) =>
    vectorMagnitude(components.map(key => end[key])) ?? (finite(end[legacy]) ? Math.abs(end[legacy]) : undefined);

  for (const [nodeId, raw] of Object.entries(isRecord(data.displacements) ? data.displacements : {})) {
    if (isRecord(raw)) update('displacement', vectorMagnitude([raw.ux, raw.uy, raw.uz]),
      { kind: 'node', nodeId, provenance: 'solver-direct' });
  }
  for (const [elementId, raw] of Object.entries(isRecord(data.forces) ? data.forces : {})) {
    if (!isRecord(raw)) continue;
    const element = elements.get(elementId);
    const a = element && nodes.get(element.nodes[0]);
    const b = element && nodes.get(element.nodes[1]);
    const length = a && b ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : undefined;
    for (const [key, index] of [['n1', 0], ['n2', 1]] as const) {
      const end = raw[key];
      if (!isRecord(end)) continue;
      const location = { kind: 'member', elementId, nodeId: element?.nodes[index],
        positionM: index === 0 ? 0 : length, side: index === 0 ? 'right' : 'left', provenance: 'solver-direct' };
      update('axialForce', finite(end.N) ? Math.abs(end.N) : finite(raw.axial) ? Math.abs(raw.axial) : undefined, location);
      update('shearForce', endMagnitude(end, ['V2', 'V3'], 'V'), location);
      update('moment', endMagnitude(end, ['M2', 'M3'], 'M'), location);
    }
  }
  const reactions = Object.entries(isRecord(data.reactions) ? data.reactions : {});
  for (const [quantity, components, unit] of [
    ['reaction', ['fx', 'fy', 'fz'], 'kN'], ['reactionMoment', ['mx', 'my', 'mz'], 'kN·m'],
  ] as const) {
    // A legacy scalar may mix force and moment units; signed raw components are authoritative.
    if (reactions.some(([, raw]) => isRecord(raw) && components.some(component => finite(raw[component])))) {
      envelope[metrics[quantity]] = 0;
      delete locations[quantity];
      delete envelope[controlFields[quantity]];
    }
    for (const [nodeId, raw] of reactions) {
      if (!isRecord(raw)) continue;
      for (const component of components) if (finite(raw[component])) {
        update(quantity, Math.abs(raw[component]), { kind: 'node', nodeId, component, unit, provenance: 'solver-direct' });
      }
    }
  }
  for (const member of members) {
    if (!['recovered', 'truss'].includes(member.state)) continue;
    const element = elements.get(member.id);
    for (const sample of member.samples) {
      if (!finite(sample.x)) continue;
      const nodeId = sample.x === 0 ? element?.nodes[0] : sample.x === member.length ? element?.nodes[1] : undefined;
      const location = { kind: 'member', elementId: member.id, positionM: sample.x,
        side: sample.side ?? (sample.x === member.length ? 'left' : 'right'),
        ...(nodeId ? { nodeId } : {}), provenance: 'mechanics-recovery' };
      update('displacement', vectorMagnitude(sample.displacement), location);
      update('axialForce', finite(sample.N) ? Math.abs(sample.N) : undefined, location);
      update('shearForce', vectorMagnitude([sample.V2, sample.V3]), location);
      update('moment', vectorMagnitude([sample.M2, sample.M3]), location);
    }
  }
  envelope.method = 'solver-direct-and-mechanics-recovery-sampled';
  envelope.controlLocations = locations;
  const summary: ModelRecord = { ...(isRecord(data.summary) ? data.summary : {}) };
  if (finite(envelope.maxAbsDisplacement)) Object.assign(summary, {
    maxDisplacement: envelope.maxAbsDisplacement, maxAbsDisplacement: envelope.maxAbsDisplacement,
    maxDisplacementNode: envelope.controlNodeDisplacement || null, maxDisplacementLocation: locations.displacement,
  });
  return { ...data, envelope, summary };
}
