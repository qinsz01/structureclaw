/** Continuous (double-span) beam and portal frame template models. */
import type { DraftState, EngineeringDraftLoad } from '../../shared/types/agent.js';
import { readPositiveNumberArray, readPositiveInteger, readNonNegativeNumberArray, accumulateCoordinates, readSignedNumber, readNonNegativeNumber, coordinateMatches, readPositiveNumber, buildFixedRestraint } from './readers.js';
import { semanticPointLoadX } from './beam.js';
import { PINNED_RESTRAINT, ROLLER_X_RESTRAINT } from '../../engineering/coordinate-semantics.js';

function getContinuousBeamSpanLengths(state: DraftState): number[] {
  const explicit = readPositiveNumberArray(state.skillState?.spanLengthsM);
  if (explicit?.length) {
    return explicit;
  }
  const span = state.spanLengthM!;
  const spanCount = Math.max(2, readPositiveInteger(state.skillState?.spanCount) ?? 2);
  return Array.from({ length: spanCount }, () => span);
}

export function buildContinuousBeamModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
  const spans = getContinuousBeamSpanLengths(state);
  const totalLength = spans.reduce((sum, span) => sum + span, 0);
  const topologyNodes = state.engineeringDraft?.topology?.nodes ?? [];
  const boundarySupports = readNonNegativeNumberArray(state.engineeringDraft?.boundary?.supportPositionsM)
    ?.filter((x) => x <= totalLength);
  const topologySupports = topologyNodes
    .filter((node) => Array.isArray(node.restraints) && node.restraints.some(Boolean))
    .map((node) => node.x)
    .filter((x) => x >= 0 && x <= totalLength);
  const supportCoordinates = Array.from(new Set(
    boundarySupports?.length
      ? boundarySupports
      : topologySupports.length
        ? topologySupports
        : accumulateCoordinates(spans),
  )).sort((left, right) => left - right);
  const explicitPointLoad = readSignedNumber(state.skillState?.pointLoadKN);
  const pointLoad = explicitPointLoad
    ?? (state.loadType === 'point' || state.loadType === undefined ? state.loadKN : undefined);
  const pointSpanIndex = Math.min(
    spans.length - 1,
    Math.max(
      0,
      (readPositiveInteger(state.skillState?.pointLoadSpanIndex) ?? (spans.indexOf(Math.max(...spans)) + 1)) - 1,
    ),
  );
  const semanticPointLoad = state.engineeringDraft?.loads?.find(
    (load) => load.kind === 'point' || load.kind === 'nodal',
  );
  const semanticPointTarget = semanticPointLoad?.target?.trim().toLowerCase();
  const semanticPointHasExplicitCoordinate = semanticPointLoad?.location?.xM !== undefined
    || (semanticPointTarget !== undefined && topologyNodes.some(
      (node) => node.id.trim().toLowerCase() === semanticPointTarget,
    ));
  const explicitPointLoadX = readNonNegativeNumber(state.skillState?.pointLoadXM)
    ?? (semanticPointLoad && semanticPointHasExplicitCoordinate
      ? semanticPointLoadX(semanticPointLoad as unknown as Record<string, unknown>, state, totalLength)
      : undefined);
  const middleSupportX = supportCoordinates.length > 2
    ? supportCoordinates[Math.floor((supportCoordinates.length - 1) / 2)]
    : undefined;
  const spanBoundaries = accumulateCoordinates(spans);
  const pointLoadX = pointLoad !== undefined
    ? (
        explicitPointLoadX
        ?? (
          explicitPointLoad === undefined
          && (state.loadPosition === undefined || state.loadPosition === 'middle-joint')
          && middleSupportX !== undefined
            ? middleSupportX
            : spanBoundaries[pointSpanIndex] + spans[pointSpanIndex] / 2
        )
      )
    : undefined;
  const coordinates = Array.from(new Set([
    ...supportCoordinates,
    ...topologyNodes.map((node) => node.x).filter((x) => x >= 0 && x <= totalLength),
    ...(pointLoadX !== undefined ? [pointLoadX] : []),
  ])).sort((left, right) => left - right);
  const pinned = [...PINNED_RESTRAINT];
  const roller = [...ROLLER_X_RESTRAINT];
  const nodes = coordinates.map((x, index) => {
    const supportIndex = supportCoordinates.findIndex((supportX) => Math.abs(supportX - x) < 1e-9);
    const topologyNode = topologyNodes.find((node) => Math.abs(node.x - x) < 1e-9);
    const node: Record<string, unknown> = { id: `${index + 1}`, x, y: 0, z: 0 };
    if (topologyNode?.restraints) {
      node.restraints = [...topologyNode.restraints];
    } else if (supportIndex >= 0) {
      node.restraints = supportIndex === 0 ? pinned : roller;
    }
    return node;
  });
  const elements = coordinates.slice(0, -1).map((_x, index) => ({
    id: `${index + 1}`,
    type: 'beam',
    nodes: [`${index + 1}`, `${index + 2}`],
    material: '1',
    section: '1',
  }));
  const distributedLoad = readSignedNumber(state.skillState?.distributedLoadKNM)
    ?? ((state.loadType === 'distributed' || state.loadPosition === 'full-span') ? state.loadKN : undefined);
  const loads: Array<Record<string, unknown>> = [];
  if (distributedLoad !== undefined) {
    for (const element of elements) {
      loads.push({ type: 'distributed', element: element.id, wz: -distributedLoad, wy: 0 });
    }
  }
  if (pointLoad !== undefined && pointLoadX !== undefined) {
    const nodeIndex = coordinates.findIndex((x) => Math.abs(x - pointLoadX) < 1e-9);
    loads.push({ node: `${nodeIndex + 1}`, fz: -pointLoad });
  }

  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    nodes,
    elements,
    materials: [],
    sections: [],
    load_cases: [
      { id: 'LC1', type: 'other', loads },
    ],
    load_combinations: [],
    metadata: {
      ...metadata,
      spanCount: spans.length,
      geometry: {
        spanLengthsM: spans,
      },
    },
  };
}

function getPortalFrameSpanLengths(state: DraftState): number[] {
  const explicit = readPositiveNumberArray(state.skillState?.portalBaySpansM);
  if (explicit?.length) {
    return explicit;
  }
  const span = state.spanLengthM!;
  const bayCount = Math.max(1, readPositiveInteger(state.skillState?.portalBayCount) ?? 1);
  return Array.from({ length: bayCount }, () => span);
}

function portalCraneTargetIndex(
  load: EngineeringDraftLoad,
  xCoordinates: number[],
): number | undefined {
  const explicitX = load.location?.xM;
  if (explicitX !== undefined) {
    const index = xCoordinates.findIndex((x) => coordinateMatches(x, explicitX));
    if (index >= 0) return index;
  }
  const role = `${load.location?.nodeRole ?? ''} ${load.target ?? ''}`.trim().toLowerCase();
  if (role.includes('right') || /右柱|右侧/u.test(role)) return xCoordinates.length - 1;
  if (role.includes('left') || /左柱|左侧/u.test(role)) return 0;
  if (role.includes('middle') || role.includes('center') || role.includes('centre') || /中柱|中间/u.test(role)) {
    return Math.floor((xCoordinates.length - 1) / 2);
  }
  return undefined;
}

function buildPortalCraneLoads(state: DraftState, xCoordinates: number[]): Array<Record<string, unknown>> {
  const loads: Array<Record<string, unknown>> = [];
  for (const load of state.engineeringDraft?.loads ?? []) {
    if (load.kind !== 'point' && load.kind !== 'nodal') continue;
    const targetIndex = portalCraneTargetIndex(load, xCoordinates);
    if (targetIndex === undefined) continue;
    const target = `T${targetIndex}`;
    if (load.direction === 'globalX') {
      loads.push({ node: target, fx: load.magnitude });
    } else if (load.direction === 'globalY') {
      loads.push({ node: target, fy: load.magnitude });
    } else {
      loads.push({ node: target, fz: (load.direction === 'globalZ' ? load.magnitude : -load.magnitude) });
    }
  }
  if (loads.length > 0) return loads;

  const legacyCraneLoad = readSignedNumber(state.skillState?.craneLoadKN);
  if (legacyCraneLoad === undefined) return [];
  const target = xCoordinates.length > 2 ? 'T1' : 'T0';
  return [{ node: target, fz: -legacyCraneLoad }];
}

export function buildPortalFrameModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
  const spans = getPortalFrameSpanLengths(state);
  const xCoordinates = accumulateCoordinates(spans);
  const height = state.heightM!;
  const roofLoad = readSignedNumber(state.skillState?.roofLoadKNM)
    ?? ((state.loadType === 'distributed' || state.loadPosition === 'full-span') ? state.loadKN : undefined);
  const nodalLoad = roofLoad === undefined ? state.loadKN! : undefined;
  const mezzanineHeight = readPositiveNumber(state.skillState?.mezzanineHeightM);
  const mezzanineLength = readPositiveNumber(state.skillState?.mezzanineLengthM);
  const mezzanineLoad = readSignedNumber(state.skillState?.mezzanineLoadKN);
  const hasMezzanine = mezzanineHeight !== undefined
    && mezzanineHeight < height
    && mezzanineLength !== undefined
    && mezzanineLength <= spans[0]
    && spans.length >= 1;
  const baseRestraint = buildFixedRestraint(state.frameBaseSupportType || 'fixed');
  const nodes: Array<Record<string, unknown>> = [];
  const elements: Array<Record<string, unknown>> = [];
  const loads: Array<Record<string, unknown>> = [];

  for (let i = 0; i < xCoordinates.length; i += 1) {
    nodes.push({ id: `B${i}`, x: xCoordinates[i], y: 0, z: 0, restraints: [...baseRestraint] });
    nodes.push({ id: `T${i}`, x: xCoordinates[i], y: 0, z: height });
  }
  if (hasMezzanine) {
    nodes.push({ id: 'M0', x: 0, y: 0, z: mezzanineHeight });
    nodes.push({ id: 'M1', x: mezzanineLength, y: 0, z: mezzanineHeight });
  }

  for (let i = 0; i < xCoordinates.length; i += 1) {
    if (hasMezzanine && i === 0) {
      elements.push({ id: `C${i}a`, type: 'column', nodes: [`B${i}`, 'M0'], material: '1', section: '1' });
      elements.push({ id: `C${i}b`, type: 'column', nodes: ['M0', `T${i}`], material: '1', section: '1' });
    } else {
      elements.push({ id: `C${i}`, type: 'column', nodes: [`B${i}`, `T${i}`], material: '1', section: '1' });
    }
  }
  for (let i = 0; i < spans.length; i += 1) {
    const element = { id: `R${i}`, type: 'beam', nodes: [`T${i}`, `T${i + 1}`], material: '1', section: '1' };
    elements.push(element);
    if (roofLoad !== undefined) {
      loads.push({ type: 'distributed', element: element.id, wz: -roofLoad, wy: 0 });
    }
  }
  if (hasMezzanine) {
    const mezzanineElement = { id: 'MEZ1', type: 'beam', nodes: ['M0', 'M1'], material: '1', section: '1' };
    elements.push(mezzanineElement);
    if (mezzanineLoad !== undefined) {
      loads.push({ type: 'distributed', element: mezzanineElement.id, wz: -mezzanineLoad, wy: 0 });
    }
  }
  if (nodalLoad !== undefined) {
    const perTopNode = -nodalLoad / xCoordinates.length;
    for (let i = 0; i < xCoordinates.length; i += 1) {
      loads.push({ type: 'nodal', node: `T${i}`, forces: [0, 0, perTopNode, 0, 0, 0] });
    }
  }
  loads.push(...buildPortalCraneLoads(state, xCoordinates));

  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    nodes,
    elements,
    materials: [],
    sections: [],
    load_cases: [
      { id: 'LC1', type: 'other', loads },
    ],
    load_combinations: [],
    metadata: {
      ...metadata,
      bayCount: spans.length,
      hasMezzanine,
      geometry: {
        spanLengthsM: spans,
        heightM: height,
        mezzanineHeightM: hasMezzanine ? mezzanineHeight : undefined,
        mezzanineLengthM: hasMezzanine ? mezzanineLength : undefined,
      },
    },
  };
}
