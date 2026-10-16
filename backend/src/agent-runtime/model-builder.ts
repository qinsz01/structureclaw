import {
  FIXED_RESTRAINT,
  PINNED_RESTRAINT,
  ROLLER_X_RESTRAINT,
  STRUCTURAL_COORDINATE_SEMANTICS,
  withCanonicalCoordinateContract,
} from './coordinate-semantics.js';
import { buildElementReferenceVectors } from './reference-vectors.js';
import { buildExplicitDraftModel, validateExplicitModel } from './explicit-model.js';
import { applyTemplateProperties } from './template-properties.js';
import type {
  DraftLoadPosition,
  DraftLoadType,
  DraftState,
  DraftSupportType,
  EngineeringDraftLoad,
  FrameBaseSupportType,
} from '../shared/types/agent.js';

function buildFixedRestraint(baseSupport: FrameBaseSupportType): boolean[] {
  if (baseSupport === 'pinned') {
    return [...PINNED_RESTRAINT];
  }
  return [...FIXED_RESTRAINT];
}

function accumulateCoordinates(lengths: number[]): number[] {
  const coordinates = [0];
  for (const value of lengths) {
    coordinates.push(coordinates[coordinates.length - 1] + value);
  }
  return coordinates;
}

function get2dNodeId(storyIndex: number, bayNodeIndex: number): string {
  return `N${storyIndex}_${bayNodeIndex}`;
}

function get3dNodeId(storyIndex: number, xIndex: number, yIndex: number): string {
  return `N${storyIndex}_${xIndex}_${yIndex}`;
}

function buildFrame2dModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
  const bayWidths = state.bayWidthsM!;
  const storyHeights = state.storyHeightsM!;
  const floorLoads = state.floorLoads!;
  const xCoordinates = accumulateCoordinates(bayWidths);
  const zCoordinates = accumulateCoordinates(storyHeights);
  const baseSupport = state.frameBaseSupportType || 'fixed';
  const nodes: Array<Record<string, unknown>> = [];
  const elements: Array<Record<string, unknown>> = [];
  const loadCases = [{ id: 'LC1', type: 'other', loads: [] as Array<Record<string, unknown>> }];
  let elementId = 1;

  for (let storyIndex = 0; storyIndex < zCoordinates.length; storyIndex += 1) {
    for (let bayNodeIndex = 0; bayNodeIndex < xCoordinates.length; bayNodeIndex += 1) {
      const node: Record<string, unknown> = {
        id: get2dNodeId(storyIndex, bayNodeIndex),
        x: xCoordinates[bayNodeIndex],
        y: 0,
        z: zCoordinates[storyIndex],
      };
      if (storyIndex === 0) {
        node.restraints = buildFixedRestraint(baseSupport);
      }
      nodes.push(node);
    }
  }

  for (let storyIndex = 1; storyIndex < zCoordinates.length; storyIndex += 1) {
    for (let bayNodeIndex = 0; bayNodeIndex < xCoordinates.length; bayNodeIndex += 1) {
      elements.push({
        id: `C${elementId}`,
        type: 'column',
        nodes: [get2dNodeId(storyIndex - 1, bayNodeIndex), get2dNodeId(storyIndex, bayNodeIndex)],
        material: '1',
        section: '1',
      });
      elementId += 1;
    }
  }

  for (let storyIndex = 1; storyIndex < zCoordinates.length; storyIndex += 1) {
    for (let bayIndex = 0; bayIndex < bayWidths.length; bayIndex += 1) {
      elements.push({
        id: `B${elementId}`,
        type: 'beam',
        nodes: [get2dNodeId(storyIndex, bayIndex), get2dNodeId(storyIndex, bayIndex + 1)],
        material: '1',
        section: '2',
      });
      elementId += 1;
    }
  }

  const levelNodeCount = xCoordinates.length;
  for (const load of floorLoads) {
    const storyIndex = load.story;
    if (storyIndex <= 0 || storyIndex >= zCoordinates.length) {
      continue;
    }
    const verticalPerNode = load.verticalKN !== undefined ? -load.verticalKN / levelNodeCount : undefined;
    const lateralPerNode = load.lateralXKN !== undefined ? load.lateralXKN / levelNodeCount : undefined;
    for (let bayNodeIndex = 0; bayNodeIndex < xCoordinates.length; bayNodeIndex += 1) {
      const nodeLoad: Record<string, unknown> = { node: get2dNodeId(storyIndex, bayNodeIndex) };
      if (verticalPerNode !== undefined) {
        nodeLoad.fz = verticalPerNode;
      }
      if (lateralPerNode !== undefined) {
        nodeLoad.fx = lateralPerNode;
      }
      if (Object.keys(nodeLoad).length > 1) {
        loadCases[0].loads.push(nodeLoad);
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
    load_cases: loadCases,
    load_combinations: [],
    metadata: {
      ...metadata,
      coordinateSemantics: STRUCTURAL_COORDINATE_SEMANTICS,
      baseSupport,
      storyCount: storyHeights.length,
      bayCount: bayWidths.length,
      geometry: {
        storyHeightsM: storyHeights,
        bayWidthsM: bayWidths,
      },
    },
  };
}

function buildFrame3dModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
  const bayWidthsX = state.bayWidthsXM!;
  const bayWidthsY = state.bayWidthsYM!;
  const storyHeights = state.storyHeightsM!;
  const floorLoads = state.floorLoads!;
  const xCoordinates = accumulateCoordinates(bayWidthsX);
  const yCoordinates = accumulateCoordinates(bayWidthsY);
  const zCoordinates = accumulateCoordinates(storyHeights);
  const baseSupport = state.frameBaseSupportType || 'fixed';
  const nodes: Array<Record<string, unknown>> = [];
  const elements: Array<Record<string, unknown>> = [];
  const loadCases = [{ id: 'LC1', type: 'other', loads: [] as Array<Record<string, unknown>> }];
  let elementId = 1;

  for (let storyIndex = 0; storyIndex < zCoordinates.length; storyIndex += 1) {
    for (let xIndex = 0; xIndex < xCoordinates.length; xIndex += 1) {
      for (let yIndex = 0; yIndex < yCoordinates.length; yIndex += 1) {
        const node: Record<string, unknown> = {
          id: get3dNodeId(storyIndex, xIndex, yIndex),
          x: xCoordinates[xIndex],
          y: yCoordinates[yIndex],
          z: zCoordinates[storyIndex],
        };
        if (storyIndex === 0) {
          node.restraints = buildFixedRestraint(baseSupport);
        }
        nodes.push(node);
      }
    }
  }

  for (let storyIndex = 1; storyIndex < zCoordinates.length; storyIndex += 1) {
    for (let xIndex = 0; xIndex < xCoordinates.length; xIndex += 1) {
      for (let yIndex = 0; yIndex < yCoordinates.length; yIndex += 1) {
        elements.push({
          id: `C${elementId}`,
          type: 'column',
          nodes: [get3dNodeId(storyIndex - 1, xIndex, yIndex), get3dNodeId(storyIndex, xIndex, yIndex)],
          material: '1',
          section: '1',
        });
        elementId += 1;
      }
    }
  }

  for (let storyIndex = 1; storyIndex < zCoordinates.length; storyIndex += 1) {
    for (let xIndex = 0; xIndex < bayWidthsX.length; xIndex += 1) {
      for (let yIndex = 0; yIndex < yCoordinates.length; yIndex += 1) {
        elements.push({
          id: `BX${elementId}`,
          type: 'beam',
          nodes: [get3dNodeId(storyIndex, xIndex, yIndex), get3dNodeId(storyIndex, xIndex + 1, yIndex)],
          material: '1',
          section: '2',
        });
        elementId += 1;
      }
    }
    for (let xIndex = 0; xIndex < xCoordinates.length; xIndex += 1) {
      for (let yIndex = 0; yIndex < bayWidthsY.length; yIndex += 1) {
        elements.push({
          id: `BY${elementId}`,
          type: 'beam',
          nodes: [get3dNodeId(storyIndex, xIndex, yIndex), get3dNodeId(storyIndex, xIndex, yIndex + 1)],
          material: '1',
          section: '2',
        });
        elementId += 1;
      }
    }
  }

  const levelNodeCount = xCoordinates.length * yCoordinates.length;
  for (const load of floorLoads) {
    const storyIndex = load.story;
    if (storyIndex <= 0 || storyIndex >= zCoordinates.length) {
      continue;
    }
    const verticalPerNode = load.verticalKN !== undefined ? -load.verticalKN / levelNodeCount : undefined;
    const lateralXPerNode = load.lateralXKN !== undefined ? load.lateralXKN / levelNodeCount : undefined;
    const lateralYPerNode = load.lateralYKN !== undefined ? load.lateralYKN / levelNodeCount : undefined;
    for (let xIndex = 0; xIndex < xCoordinates.length; xIndex += 1) {
      for (let yIndex = 0; yIndex < yCoordinates.length; yIndex += 1) {
        const nodeLoad: Record<string, unknown> = { node: get3dNodeId(storyIndex, xIndex, yIndex) };
        if (verticalPerNode !== undefined) {
          nodeLoad.fz = verticalPerNode;
        }
        if (lateralXPerNode !== undefined) {
          nodeLoad.fx = lateralXPerNode;
        }
        if (lateralYPerNode !== undefined) {
          nodeLoad.fy = lateralYPerNode;
        }
        if (Object.keys(nodeLoad).length > 1) {
          loadCases[0].loads.push(nodeLoad);
        }
      }
    }
  }

  const elementReferenceVectors = buildElementReferenceVectors(elements, nodes);

  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    nodes,
    elements,
    materials: [],
    sections: [],
    load_cases: loadCases,
    load_combinations: [],
    metadata: {
      ...metadata,
      coordinateSemantics: STRUCTURAL_COORDINATE_SEMANTICS,
      elementReferenceVectors,
      baseSupport,
      storyCount: storyHeights.length,
      bayCountX: bayWidthsX.length,
      bayCountY: bayWidthsY.length,
      geometry: {
        storyHeightsM: storyHeights,
        bayWidthsXM: bayWidthsX,
        bayWidthsYM: bayWidthsY,
      },
    },
  };
}

function buildBeamNodes(length: number, supportType: DraftSupportType, loadPositionM?: number) {
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

function buildOverhangingBeamNodes(simpleSpan: number, overhangLength: number) {
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

function buildBeamLoads(
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

function getTrussTopology(state: DraftState): string {
  const topology = state.skillState?.trussTopology;
  return typeof topology === 'string' ? topology : 'generic';
}

function getTrussLoadChord(state: DraftState): 'top' | 'bottom' {
  return state.skillState?.trussLoadChord === 'bottom' ? 'bottom' : 'top';
}

function clampTrussPanelCount(value: number | undefined, span: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.max(2, Math.min(30, Math.round(span / 3)));
  }
  return Math.max(2, Math.min(30, Math.round(value)));
}

function buildTrussTopElevation(topology: string, x: number, span: number, height: number): number {
  if (topology === 'trapezoidal') {
    return Math.max(height - Math.abs(x - span / 2) * 0.1, height * 0.4);
  }
  return height;
}

function buildExplicitTrussTopology(state: DraftState): {
  nodes: Array<Record<string, unknown>>;
  elements: Array<Record<string, unknown>>;
} | null {
  const topology = state.engineeringDraft?.topology;
  if (!topology?.nodes?.length || !topology.members?.length) return null;
  const nodeIds = new Set(topology.nodes.map((node) => node.id));
  if (nodeIds.size !== topology.nodes.length
    || topology.members.some((member) => !nodeIds.has(member.nodes[0]) || !nodeIds.has(member.nodes[1]))) {
    return null;
  }

  const nodes = topology.nodes.map((node) => ({
    id: node.id,
    x: node.x,
    y: node.y,
    z: node.z,
    ...(node.restraints
      ? {
          restraints: node.restraints[0] || node.restraints[2]
            ? [
                node.restraints[0],
                true,
                node.restraints[2],
                node.restraints[3],
                node.restraints[4],
                node.restraints[5],
              ]
            : [...node.restraints],
        }
      : {}),
  }));
  if (!nodes.some((node) => 'restraints' in node)) {
    const minZ = Math.min(...topology.nodes.map((node) => node.z));
    const baseNodes = topology.nodes
      .filter((node) => Math.abs(node.z - minZ) <= 1e-9)
      .sort((left, right) => left.x - right.x || left.y - right.y);
    const left = nodes.find((node) => node.id === baseNodes[0]?.id);
    const right = nodes.find((node) => node.id === baseNodes[baseNodes.length - 1]?.id);
    if (left) left.restraints = [...PINNED_RESTRAINT];
    if (right && right !== left) right.restraints = [...ROLLER_X_RESTRAINT];
  }

  return {
    nodes,
    elements: topology.members.map((member, index) => ({
      id: member.id ?? `E${index + 1}`,
      type: 'truss',
      nodes: [...member.nodes],
      material: '1',
      section: '1',
    })),
  };
}

function buildExplicitTrussLoads(
  state: DraftState,
  nodes: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const nodeIds = new Set(nodes.map((node) => String(node.id)));
  const coordinates = nodes.filter((node): node is Record<string, unknown> & {
    id: string;
    x: number;
    z: number;
  } => (
    typeof node.id === 'string'
    && typeof node.x === 'number'
    && typeof node.z === 'number'
  ));
  const minX = Math.min(...coordinates.map((node) => Number(node.x)));
  const maxX = Math.max(...coordinates.map((node) => Number(node.x)));
  const minZ = Math.min(...coordinates.map((node) => Number(node.z)));

  function semanticTargetIds(load: EngineeringDraftLoad): string[] {
    const role = `${load.location?.nodeRole ?? ''} ${load.target ?? ''}`.trim().toLowerCase();
    const chord = role.includes('top') || role.includes('upper') || role.includes('上弦')
      ? 'top'
      : role.includes('bottom') || role.includes('lower') || role.includes('下弦')
        ? 'bottom'
        : undefined;
    const locationX = load.location?.xM;
    if (typeof locationX === 'number' && Number.isFinite(locationX)) {
      const nodesAtLocation = coordinates.filter(
        (node) => Math.abs(Number(node.x) - locationX) <= 1e-9,
      );
      const locatedTargets = chord
        ? nodesAtLocation.filter((node) => (
            chord === 'top'
              ? Number(node.z) > minZ + 1e-9
              : Math.abs(Number(node.z) - minZ) <= 1e-9
          ))
        : nodesAtLocation.length === 1
          ? nodesAtLocation
          : [];
      if (locatedTargets.length > 0) {
        return locatedTargets
          .sort((left, right) => (
            Number(left.z) - Number(right.z)
            || Number(left.x) - Number(right.x)
            || String(left.id).localeCompare(String(right.id))
          ))
          .map((node) => String(node.id));
      }
    }
    if (!chord) return [];

    return coordinates
      .filter((node) => (
        Number(node.x) > minX + 1e-9
        && Number(node.x) < maxX - 1e-9
        && (chord === 'top'
          ? Number(node.z) > minZ + 1e-9
          : Math.abs(Number(node.z) - minZ) <= 1e-9)
      ))
      .sort((left, right) => (
        Number(left.x) - Number(right.x)
        || Number(left.z) - Number(right.z)
        || String(left.id).localeCompare(String(right.id))
      ))
      .map((node) => String(node.id));
  }

  return (state.engineeringDraft?.loads ?? []).flatMap((load) => {
    const target = load.target?.trim();
    if (load.kind !== 'point' && load.kind !== 'nodal') return [];
    const targets = target && nodeIds.has(target) ? [target] : semanticTargetIds(load);
    if (targets.length === 0) return [];
    const component = load.direction === 'globalX' ? 'fx' : load.direction === 'globalY' ? 'fy' : 'fz';
    const sign = component === 'fz' && load.direction !== 'globalZ' ? -1 : 1;
    return targets.map((node) => ({ node, [component]: sign * load.magnitude }));
  });
}

function buildTrussModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
  const span = state.lengthM!;
  const panelCount = clampTrussPanelCount(state.bayCount, span);
  const height = state.heightM ?? span / 6;
  const load = state.loadKN!;
  const topology = getTrussTopology(state);
  const panelLength = span / panelCount;
  const fixed = [...PINNED_RESTRAINT];
  const roller = [...ROLLER_X_RESTRAINT];
  const explicitTopology = buildExplicitTrussTopology(state);
  const nodes: Array<Record<string, unknown>> = explicitTopology?.nodes ?? [];
  const elements: Array<Record<string, unknown>> = explicitTopology?.elements ?? [];

  for (let i = 0; !explicitTopology && i <= panelCount; i += 1) {
    const node: Record<string, unknown> = {
      id: `B${i}`,
      x: i * panelLength,
      y: 0,
      z: 0,
    };
    if (i === 0) {
      node.restraints = fixed;
    } else if (i === panelCount) {
      node.restraints = roller;
    }
    nodes.push(node);
  }

  for (let i = 0; !explicitTopology && i <= panelCount; i += 1) {
    const x = i * panelLength;
    nodes.push({
      id: `T${i}`,
      x,
      y: 0,
      z: buildTrussTopElevation(topology, x, span, height),
    });
  }

  for (let i = 0; !explicitTopology && i < panelCount; i += 1) {
    elements.push({
      id: `BC${i}`,
      type: 'truss',
      nodes: [`B${i}`, `B${i + 1}`],
      material: '1',
      section: '1',
    });
    elements.push({
      id: `TC${i}`,
      type: 'truss',
      nodes: [`T${i}`, `T${i + 1}`],
      material: '1',
      section: '1',
    });
  }

  for (let i = 0; !explicitTopology && i <= panelCount; i += 1) {
    elements.push({
      id: `WV${i}`,
      type: 'truss',
      nodes: [`B${i}`, `T${i}`],
      material: '1',
      section: '1',
    });
    if (i < panelCount) {
      const diagonalNodes = i < panelCount / 2
        ? [`B${i}`, `T${i + 1}`]
        : [`B${i + 1}`, `T${i}`];
      elements.push({
        id: `WD${i}`,
        type: 'truss',
        nodes: diagonalNodes,
        material: '1',
        section: '1',
      });
    }
  }

  const loadChord = getTrussLoadChord(state);
  const loadPrefix = loadChord === 'bottom' ? 'B' : 'T';
  const loadNodeIndexes = state.loadPosition === 'middle-joint'
    ? [Math.max(1, Math.min(panelCount - 1, Math.round(panelCount / 2)))]
    : Array.from({ length: Math.max(0, panelCount - 1) }, (_, index) => index + 1);
  const explicitLoads = buildExplicitTrussLoads(state, nodes);
  const nodalLoads = explicitLoads.length > 0
    ? explicitLoads
    : loadNodeIndexes.map((index) => ({ node: `${loadPrefix}${index}`, fz: -load }));

  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    nodes,
    elements,
    materials: [],
    sections: [],
    load_cases: [
      { id: 'LC1', type: 'other', loads: nodalLoads },
    ],
    load_combinations: [],
    metadata: {
      ...metadata,
      trussTopology: topology,
      topologySource: explicitTopology ? 'engineering-draft' : 'generated',
      loadChord,
      panelCount,
      panelCountDefaulted: state.bayCount === undefined,
      heightDefaulted: state.heightM === undefined,
      geometry: {
        spanM: span,
        heightM: height,
        panelLengthM: panelLength,
      },
    },
  };
}

function readSignedNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readPositiveNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item > 0);
  return values.length > 0 ? values : undefined;
}

function readNonNegativeNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0);
  return values.length > 0 ? values : undefined;
}

function addCoordinate(coordinates: Set<number>, value: number | undefined, length: number): void {
  if (value === undefined || value <= 0 || value >= length) {
    return;
  }
  coordinates.add(Number(value.toFixed(9)));
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(9));
}

function coordinateMatches(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

function readRecordArray(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const records = value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  return records.length ? records : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = readPositiveNumber(value);
  return parsed === undefined ? undefined : Math.max(1, Math.round(parsed));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const SEISMIC_MEMBER_EVIDENCE_KEYS = [
  'seismicCapacity',
  'capacityChecks',
  'capacityDesign',
  'strongShearWeakBending',
  'shearCompression',
  'jointCore',
  'jointData',
  'flatBeam',
  'columnPosition',
  'columnCategory',
  'wallData',
  'shearWallData',
  'boundaryElement',
  'boundaryElements',
  'steelSeismicDetailing',
  'steelDetailing',
  'seismicDetailing',
] as const;

function pickSeismicMemberEvidenceFields(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return Object.fromEntries(
    SEISMIC_MEMBER_EVIDENCE_KEYS
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, record[key]]),
  );
}

function collectSeismicMemberEvidence(
  value: unknown,
  evidenceById: Map<string, Record<string, unknown>>,
  unmatched: Record<string, unknown>[],
): void {
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    return;
  }
  const byElementId = asRecord(record['byElementId']);
  for (const [elementId, evidence] of Object.entries(byElementId)) {
    const picked = pickSeismicMemberEvidenceFields(evidence);
    if (Object.keys(picked).length) {
      evidenceById.set(elementId, { ...(evidenceById.get(elementId) ?? {}), ...picked });
    }
  }
  for (const collectionKey of ['elements', 'members', 'items']) {
    const collection = record[collectionKey];
    if (!Array.isArray(collection)) {
      continue;
    }
    for (const item of collection) {
      const itemRecord = asRecord(item);
      const elementId = typeof itemRecord['elementId'] === 'string'
        ? itemRecord['elementId']
        : typeof itemRecord['id'] === 'string'
          ? itemRecord['id']
          : undefined;
      const picked = pickSeismicMemberEvidenceFields(itemRecord);
      if (elementId && Object.keys(picked).length) {
        evidenceById.set(elementId, { ...(evidenceById.get(elementId) ?? {}), ...picked });
      } else if (Object.keys(picked).length) {
        unmatched.push(picked);
      }
    }
  }
  const direct = pickSeismicMemberEvidenceFields(record);
  if (Object.keys(direct).length) {
    const elementId = typeof record['elementId'] === 'string'
      ? record['elementId']
      : typeof record['id'] === 'string'
        ? record['id']
        : undefined;
    if (elementId) {
      evidenceById.set(elementId, { ...(evidenceById.get(elementId) ?? {}), ...direct });
    } else {
      unmatched.push(direct);
    }
  }
}

function collectSeismicMemberEvidenceFromState(state: DraftState): {
  byElementId: Map<string, Record<string, unknown>>;
  unmatched: Record<string, unknown>[];
} {
  const byElementId = new Map<string, Record<string, unknown>>();
  const unmatched: Record<string, unknown>[] = [];
  const engineeringDraft = asRecord(state.engineeringDraft);
  const skillState = asRecord(state.skillState);
  const seismicWorkflow = asRecord(skillState['seismicWorkflow']);
  collectSeismicMemberEvidence(engineeringDraft['seismicMemberEvidence'], byElementId, unmatched);
  collectSeismicMemberEvidence(skillState['seismicMemberEvidence'], byElementId, unmatched);
  collectSeismicMemberEvidence(skillState['memberEvidence'], byElementId, unmatched);
  collectSeismicMemberEvidence(seismicWorkflow['seismicMemberEvidence'], byElementId, unmatched);
  collectSeismicMemberEvidence(seismicWorkflow['memberEvidence'], byElementId, unmatched);
  return { byElementId, unmatched };
}

function attachSeismicMemberEvidence(model: Record<string, unknown>, state: DraftState): Record<string, unknown> {
  const { byElementId, unmatched } = collectSeismicMemberEvidenceFromState(state);
  if (byElementId.size === 0 && unmatched.length === 0) {
    return model;
  }
  const elements = Array.isArray(model.elements)
    ? model.elements.map((element) => {
      const elementRecord = asRecord(element);
      const id = typeof elementRecord['id'] === 'string' ? elementRecord['id'] : undefined;
      const evidence = id ? byElementId.get(id) : undefined;
      if (!evidence) {
        return element;
      }
      return {
        ...elementRecord,
        ...Object.fromEntries(Object.entries(evidence).filter(([key]) => elementRecord[key] === undefined)),
      };
    })
    : model.elements;
  const matchedIds = Array.from(byElementId.keys()).filter((id) => (
    Array.isArray(model.elements)
      && model.elements.some((element) => asRecord(element)['id'] === id)
  ));
  const unmatchedById = Object.fromEntries(
    Array.from(byElementId.entries()).filter(([id]) => !matchedIds.includes(id)),
  );
  const metadata = {
    ...asRecord(model.metadata),
    ...(matchedIds.length ? { seismicMemberEvidenceElementIds: matchedIds } : {}),
    ...((unmatched.length || Object.keys(unmatchedById).length)
      ? { unmatchedSeismicMemberEvidence: { byElementId: unmatchedById, items: unmatched } }
      : {}),
  };
  return {
    ...model,
    elements,
    metadata,
  };
}

function isSemanticDistributedLoad(load: Record<string, unknown>): boolean {
  return load.kind === 'distributed' || load.kind === 'line' || load.unit === 'kN/m';
}

function isSemanticPointLoad(load: Record<string, unknown>): boolean {
  return load.kind === 'point' || load.kind === 'nodal' || load.unit === 'kN';
}

function semanticPointLoadX(load: Record<string, unknown>, state: DraftState, length: number): number {
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

function buildSemanticBeamModel(
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

function buildColumnModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
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

function getContinuousBeamSpanLengths(state: DraftState): number[] {
  const explicit = readPositiveNumberArray(state.skillState?.spanLengthsM);
  if (explicit?.length) {
    return explicit;
  }
  const span = state.spanLengthM!;
  const spanCount = Math.max(2, readPositiveInteger(state.skillState?.spanCount) ?? 2);
  return Array.from({ length: spanCount }, () => span);
}

function buildContinuousBeamModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
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

function buildPortalFrameModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
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

function buildBaseModel(state: DraftState): Record<string, unknown> {
  const metadata = {
    source: 'markdown-skill-draft',
    inferredType: state.inferredType,
    frameDimension: state.frameDimension === '3d' ? '3d' : '2d',
  };
  if (state.inferredType === 'frame') {
    if (state.frameDimension === '3d') {
      return buildFrame3dModel(state, metadata);
    }
    return buildFrame2dModel(state, metadata);
  }
  if (state.inferredType === 'truss') {
    return buildTrussModel(state, metadata);
  }
  if (state.inferredType === 'column') {
    return buildColumnModel(state, metadata);
  }
  if (state.inferredType === 'double-span-beam') {
    return buildContinuousBeamModel(state, metadata);
  }
  if (state.inferredType === 'portal-frame') {
    return buildPortalFrameModel(state, metadata);
  }
  const length = state.lengthM!;
  const load = state.loadKN!;
  const supportType = state.supportType || 'cantilever';
  const semanticBeamLoads = readRecordArray(state.skillState?.beamLoads);
  if (semanticBeamLoads?.length) {
    return buildSemanticBeamModel(state, metadata, semanticBeamLoads);
  }
  const simpleSpan = readPositiveNumber(state.skillState?.simpleSpanM);
  const overhangLength = readPositiveNumber(state.skillState?.overhangLengthM);
  const beamNodes = supportType === 'simply-supported' && simpleSpan !== undefined && overhangLength !== undefined
    ? buildOverhangingBeamNodes(simpleSpan, overhangLength)
    : buildBeamNodes(length, supportType, state.loadPositionM);
  const beamLoads = buildBeamLoads(load, state.loadType, state.loadPosition, beamNodes.pointNodeId, beamNodes.endNodeId);
  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    nodes: beamNodes.nodes,
    elements: beamNodes.elements,
    materials: [],
    sections: [],
    load_cases: [
      { id: 'LC1', type: 'other', loads: beamLoads },
    ],
    load_combinations: [],
    metadata: { ...metadata, supportType, loadPositionM: state.loadPositionM, simpleSpanM: simpleSpan, overhangLengthM: overhangLength },
  };
}

export function buildModel(state: DraftState): Record<string, unknown> {
  const explicit = buildExplicitDraftModel(state);
  if (explicit) return explicit;
  const dimension = state.inferredType === 'frame' && state.frameDimension === '3d' ? '3d' : '2d';
  return validateExplicitModel(withCanonicalCoordinateContract(
    attachSeismicMemberEvidence(applyTemplateProperties(buildBaseModel(state), state), state),
    dimension,
  ));
}
