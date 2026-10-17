/** Regular 2D/3D frame template models. */
import type { DraftState } from '../../shared/types/agent.js';
import { accumulateCoordinates, buildFixedRestraint } from './readers.js';
import { STRUCTURAL_COORDINATE_SEMANTICS } from '../../engineering/coordinate-semantics.js';
import { buildElementReferenceVectors } from '../reference-vectors.js';

function get2dNodeId(storyIndex: number, bayNodeIndex: number): string {
  return `N${storyIndex}_${bayNodeIndex}`;
}

function get3dNodeId(storyIndex: number, xIndex: number, yIndex: number): string {
  return `N${storyIndex}_${xIndex}_${yIndex}`;
}

export function buildFrame2dModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
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

export function buildFrame3dModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
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
