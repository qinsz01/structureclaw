/** Single-span beam and column template models. */
import type { DraftSupportType, DraftLoadType, DraftLoadPosition, DraftState } from '../../shared/types/agent.js';
import { FIXED_RESTRAINT, PINNED_RESTRAINT, ROLLER_X_RESTRAINT } from '../../engineering/coordinate-semantics.js';
import { readNonNegativeNumber, readNonNegativeNumberArray, roundCoordinate, readFiniteNumber, accumulateCoordinates, readPositiveNumberArray, addCoordinate, coordinateMatches, readRecordArray } from './readers.js';

export function buildBeamNodes(length: number, supportType: DraftSupportType, loadPositionM?: number) {
  const fixedRestraint = FIXED_RESTRAINT;
  const pinnedRestraint = PINNED_RESTRAINT;
  const rollerRestraint = ROLLER_X_RESTRAINT;
  let leftRestraint: boolean[] = [...fixedRestraint];
  let rightRestraint: boolean[] | undefined;

  if (supportType === 'simply-supported') {
    leftRestraint = [...pinnedRestraint];
    rightRestraint = [...rollerRestraint];
  } else if (supportType === 'fixed-fixed') {
    rightRestraint = [...fixedRestraint];
  } else if (supportType === 'fixed-pinned') {
    rightRestraint = [...pinnedRestraint];
  }

  const position = typeof loadPositionM === 'number' && loadPositionM > 0 && loadPositionM < length
    ? loadPositionM
    : length / 2;

  return {
    nodes: [
      { id: '1', x: 0, y: 0, z: 0, restraints: leftRestraint },
      { id: '2', x: position, y: 0, z: 0 },
      rightRestraint
        ? { id: '3', x: length, y: 0, z: 0, restraints: rightRestraint }
        : { id: '3', x: length, y: 0, z: 0 },
    ],
    elements: [
      { id: '1', type: 'beam', nodes: ['1', '2'], material: '1', section: '1' },
      { id: '2', type: 'beam', nodes: ['2', '3'], material: '1', section: '1' },
    ],
    pointNodeId: '2',
    endNodeId: '3',
  };
}

export function buildOverhangingBeamNodes(simpleSpan: number, overhangLength: number) {
  const pinnedRestraint = PINNED_RESTRAINT;
  const rollerRestraint = ROLLER_X_RESTRAINT;
  const totalLength = simpleSpan + overhangLength;

  return {
    nodes: [
      { id: '1', x: 0, y: 0, z: 0, restraints: [...pinnedRestraint] },
      { id: '2', x: simpleSpan, y: 0, z: 0, restraints: [...rollerRestraint] },
      { id: '3', x: totalLength, y: 0, z: 0 },
    ],
    elements: [
      { id: '1', type: 'beam', nodes: ['1', '2'], material: '1', section: '1' },
      { id: '2', type: 'beam', nodes: ['2', '3'], material: '1', section: '1' },
    ],
    pointNodeId: '2',
    endNodeId: '3',
  };
}

export function buildBeamLoads(
  loadKN: number,
  loadType: DraftLoadType | undefined,
  loadPosition: DraftLoadPosition | undefined,
  pointNodeId: string,
  endNodeId: string,
) {
  if (loadType === 'distributed' || loadPosition === 'full-span') {
    return [
      { type: 'distributed', element: '1', wz: -loadKN, wy: 0 },
      { type: 'distributed', element: '2', wz: -loadKN, wy: 0 },
    ];
  }

  const targetNodeId = loadPosition === 'end' ? endNodeId : pointNodeId;
  return [{ node: targetNodeId, fz: -loadKN }];
}

function isSemanticDistributedLoad(load: Record<string, unknown>): boolean {
  return load.kind === 'distributed' || load.kind === 'line' || load.unit === 'kN/m';
}

function isSemanticPointLoad(load: Record<string, unknown>): boolean {
  return load.kind === 'point' || load.kind === 'nodal' || load.unit === 'kN';
}

export function semanticPointLoadX(load: Record<string, unknown>, state: DraftState, length: number): number {
  const location = load.location && typeof load.location === 'object' && !Array.isArray(load.location)
    ? load.location as Record<string, unknown>
    : undefined;
  const explicitX = readNonNegativeNumber(load.xM) ?? readNonNegativeNumber(location?.xM);
  if (explicitX !== undefined) return explicitX;
  const target = typeof load.target === 'string' ? load.target.toLowerCase() : '';
  const topologyNode = state.engineeringDraft?.topology?.nodes?.find(
    (node) => node.id.trim().toLowerCase() === target.trim(),
  );
  if (topologyNode && topologyNode.x >= 0 && topologyNode.x <= length) {
    return topologyNode.x;
  }
  if (target.includes('end') || target.includes('free') || target.includes('端')) return length;
  return state.loadPositionM ?? length / 2;
}

function beamSupportCoordinates(state: DraftState, supportType: DraftSupportType, length: number): number[] {
  const explicit = readNonNegativeNumberArray(state.engineeringDraft?.boundary?.supportPositionsM)
    ?.map(roundCoordinate)
    .filter((x) => x >= 0 && x <= length);

  if (explicit?.length) {
    return Array.from(new Set(explicit)).sort((left, right) => left - right);
  }

  if (supportType === 'cantilever') {
    return [0];
  }
  return [0, length];
}

function semanticDistributedLoadElements(
  load: Record<string, unknown>,
  elements: Array<Record<string, unknown>>,
  coordinates: number[],
  spanLengths: number[] | undefined,
  state: DraftState,
): Array<Record<string, unknown>> {
  const location = load.location && typeof load.location === 'object' && !Array.isArray(load.location)
    ? load.location as Record<string, unknown>
    : undefined;
  const spanIndex = readFiniteNumber(location?.spanIndex ?? load.spanIndex);
  if (spanIndex !== undefined && spanLengths?.length) {
    if (!Number.isInteger(spanIndex) || spanIndex < 1) return [];
    const boundaries = accumulateCoordinates(spanLengths);
    if (spanIndex >= boundaries.length) return [];
    const start = boundaries[spanIndex - 1];
    const end = boundaries[spanIndex];
    return elements.filter((_element, index) => {
      const midpoint = (coordinates[index] + coordinates[index + 1]) / 2;
      return midpoint >= start - 1e-9 && midpoint <= end + 1e-9;
    });
  }

  let candidates = elements;
  let targetResolved = false;
  const target = typeof load.target === 'string' ? load.target.trim().toLowerCase() : '';
  if (target && !['beam', 'full-span', 'all'].includes(target)) {
    const directMatches = elements.filter(
      (element) => String(element.id ?? '').trim().toLowerCase() === target,
    );
    const topologyMember = state.engineeringDraft?.topology?.members?.find(
      (member) => member.id?.trim().toLowerCase() === target,
    );
    if (directMatches.length > 0) {
      candidates = directMatches;
      targetResolved = true;
    } else if (topologyMember) {
      const topologyNodes = new Map(
        (state.engineeringDraft?.topology?.nodes ?? []).map((node) => [node.id, node]),
      );
      const endpoints = topologyMember.nodes.map((nodeId) => topologyNodes.get(nodeId));
      if (endpoints.every((node) => node !== undefined)) {
        const start = Math.min(endpoints[0]!.x, endpoints[1]!.x);
        const end = Math.max(endpoints[0]!.x, endpoints[1]!.x);
        candidates = elements.filter((_element, index) => {
          const midpoint = (coordinates[index] + coordinates[index + 1]) / 2;
          return midpoint >= start - 1e-9 && midpoint <= end + 1e-9;
        });
        targetResolved = candidates.length > 0;
      }
    }
  }

  if (targetResolved) return candidates;
  if (spanIndex === undefined) return candidates;
  if (!Number.isInteger(spanIndex) || spanIndex < 1) return [];
  const boundaries = spanLengths?.length
    ? accumulateCoordinates(spanLengths)
    : [0, coordinates[coordinates.length - 1]];
  if (spanIndex >= boundaries.length) return [];
  const start = boundaries[spanIndex - 1];
  const end = boundaries[spanIndex];
  return candidates.filter((element) => {
    const index = elements.indexOf(element);
    const midpoint = (coordinates[index] + coordinates[index + 1]) / 2;
    return midpoint >= start - 1e-9 && midpoint <= end + 1e-9;
  });
}

function beamSupportRestraint(supportType: DraftSupportType, supportIndex: number): boolean[] | undefined {
  const fixed = [...FIXED_RESTRAINT];
  const pinned = [...PINNED_RESTRAINT];
  const roller = [...ROLLER_X_RESTRAINT];

  if (supportType === 'cantilever') {
    return supportIndex === 0 ? fixed : undefined;
  }
  if (supportType === 'fixed-fixed') {
    return fixed;
  }
  if (supportType === 'fixed-pinned') {
    return supportIndex === 0 ? fixed : pinned;
  }
  return supportIndex === 0 ? pinned : roller;
}

export function buildSemanticBeamModel(
  state: DraftState,
  metadata: Record<string, unknown>,
  semanticLoads: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const length = state.lengthM!;
  const supportType = state.supportType || 'cantilever';
  const hasDistributedLoad = semanticLoads.some(isSemanticDistributedLoad);
  const spanLengths = readPositiveNumberArray(state.engineeringDraft?.geometry?.spanLengthsM);
  const spanBreaks: number[] = [];
  let runningSpan = 0;
  for (const spanLength of spanLengths ?? []) {
    runningSpan += spanLength;
    if (runningSpan > 0 && runningSpan < length) {
      spanBreaks.push(roundCoordinate(runningSpan));
    }
  }
  const pointLoadXs = semanticLoads
    .filter(isSemanticPointLoad)
    .map((load) => semanticPointLoadX(load, state, length));
  const coordinateSet = new Set<number>([0, length]);
  const supportXs = beamSupportCoordinates(state, supportType, length);
  if (hasDistributedLoad) {
    addCoordinate(coordinateSet, length / 2, length);
  }
  for (const x of pointLoadXs) {
    addCoordinate(coordinateSet, x, length);
  }
  for (const x of spanBreaks) {
    addCoordinate(coordinateSet, x, length);
  }
  for (const x of supportXs) {
    if (x === 0 || x === length) {
      coordinateSet.add(x);
    } else {
      addCoordinate(coordinateSet, x, length);
    }
  }
  const coordinates = Array.from(coordinateSet).sort((left, right) => left - right);
  const nodes = coordinates.map((x, index) => {
    const node: Record<string, unknown> = { id: `${index + 1}`, x, y: 0, z: 0 };
    const supportIndex = supportXs.findIndex((supportX) => coordinateMatches(supportX, x));
    const restraints = supportIndex >= 0 ? beamSupportRestraint(supportType, supportIndex) : undefined;
    if (restraints) {
      node.restraints = restraints;
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
  const loads: Array<Record<string, unknown>> = [];
  for (const load of semanticLoads) {
    const magnitude = typeof load.magnitude === 'number' && Number.isFinite(load.magnitude) ? load.magnitude : undefined;
    if (magnitude === undefined) continue;
    if (isSemanticDistributedLoad(load)) {
      for (const element of semanticDistributedLoadElements(load, elements, coordinates, spanLengths, state)) {
        const axis = load.direction === 'globalX' ? 'wx' : load.direction === 'globalY' ? 'wy' : 'wz';
        loads.push({ type: 'distributed', element: element.id, ...(axis === 'wz' ? { wy: 0 } : {}), [axis]: axis === 'wz' && load.direction !== 'globalZ' ? -magnitude : magnitude });
      }
      continue;
    }
    if (isSemanticPointLoad(load)) {
      const x = semanticPointLoadX(load, state, length);
      const nodeIndex = coordinates.findIndex((coordinate) => coordinateMatches(coordinate, x));
      const targetNode = nodeIndex >= 0 ? `${nodeIndex + 1}` : `${Math.max(1, Math.round(coordinates.length / 2))}`;
      const direction = typeof load.direction === 'string' ? load.direction : undefined;
      if (direction === 'globalX') {
        loads.push({ node: targetNode, fx: magnitude });
      } else if (direction === 'globalY') {
        loads.push({ node: targetNode, fy: magnitude });
      } else {
        loads.push({ node: targetNode, fz: direction === 'globalZ' ? magnitude : -magnitude });
      }
    }
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
    metadata: { ...metadata, supportType, semanticLoadCount: semanticLoads.length },
  };
}

export function buildColumnModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
  const height = state.heightM ?? state.lengthM!;
  const axialLoad = state.loadKN!;
  const materialFamily = state.skillState?.materialFamily === 'concrete' ? 'concrete' : 'steel';
  const semanticColumnLoads = readRecordArray(state.skillState?.columnLoads);
  const modelLoads = semanticColumnLoads?.map((load) => {
    const fx = readFiniteNumber(load.fxKN);
    const fy = readFiniteNumber(load.fyKN);
    const fz = readFiniteNumber(load.fzKN);
    return {
      node: '2',
      ...(fx !== undefined && { fx }),
      ...(fy !== undefined && { fy }),
      ...(fz !== undefined && { fz }),
    };
  }).filter((load) => Object.keys(load).length > 1);
  const loads = modelLoads?.length ? modelLoads : [{ node: '2', fz: -axialLoad }];

  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    nodes: [
      { id: '1', x: 0, y: 0, z: 0, restraints: [true, true, true, true, true, true] },
      { id: '2', x: 0, y: 0, z: height },
    ],
    elements: [
      { id: '1', type: 'column', nodes: ['1', '2'], material: '1', section: '1' },
    ],
    materials: [],
    sections: [],
    load_cases: [
      { id: 'LC1', type: 'other', loads },
    ],
    load_combinations: [],
    metadata: {
      ...metadata,
      materialFamily,
      geometry: {
        heightM: height,
        sectionWidthM: state.skillState?.sectionWidthM,
        sectionDepthM: state.skillState?.sectionDepthM,
      },
    },
  };
}
