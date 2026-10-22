import { regularFrameGeometry } from '../../skill-shared/modelling/geometry.js';
/** Regular 2D/3D frame template models. */
import type { DraftState } from '../../shared/types/agent.js';
import { accumulateCoordinates } from './readers.js';
import { STRUCTURAL_COORDINATE_SEMANTICS } from '../../engineering/coordinate-semantics.js';
import { buildElementReferenceVectors } from '../reference-vectors.js';

function get2dNodeId(storyIndex: number, bayNodeIndex: number): string {
  return `N${storyIndex}_${bayNodeIndex}`;
}

function get3dNodeId(storyIndex: number, xIndex: number, yIndex: number): string {
  return `N${storyIndex}_${xIndex}_${yIndex}`;
}

function validateFloorLoadStory(story: number, storyCount: number): void {
  if (!Number.isInteger(story) || story < 1 || story > storyCount) {
    throw new Error('MODEL_EDIT_FIELD_INVALID: floorLoads.story must identify an existing story; the load cannot be discarded. / 楼层荷载必须指定有效楼层，不能丢弃荷载后继续建模。');
  }
}

export function buildFrame2dModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
  const bayWidths = state.bayWidthsM!;
  const storyHeights = state.storyHeightsM!;
  const floorLoads = state.floorLoads!;
  const xCoordinates = accumulateCoordinates(bayWidths);
  const zCoordinates = accumulateCoordinates(storyHeights);
  const baseSupport = state.frameBaseSupportType || 'fixed';
  const { nodes, elements } = regularFrameGeometry({ dimension: '2d', bayWidthsX: bayWidths, storeyHeights: storyHeights, baseRestraint: baseSupport, includeStories: false });
  const loadCases = [{ id: 'LC1', type: 'other', loads: [] as Array<Record<string, unknown>> }];

  const levelNodeCount = xCoordinates.length;
  for (const load of floorLoads) {
    const storyIndex = load.story;
    validateFloorLoadStory(storyIndex, zCoordinates.length - 1);
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
      ...(!state.frameBaseSupportType ? { templateAssumptions: [{ field: 'boundary.frameBaseSupportType', value: 'fixed', en: 'Unstated frame bases default to fixed.', zh: '未说明柱脚时默认刚接。' }] } : {}),
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
  const { nodes, elements } = regularFrameGeometry({ dimension: '3d', bayWidthsX: bayWidthsX, bayWidthsY: bayWidthsY, storeyHeights: storyHeights, baseRestraint: baseSupport, includeStories: false });
  const loadCases = [{ id: 'LC1', type: 'other', loads: [] as Array<Record<string, unknown>> }];

  const levelNodeCount = xCoordinates.length * yCoordinates.length;
  for (const load of floorLoads) {
    const storyIndex = load.story;
    validateFloorLoadStory(storyIndex, zCoordinates.length - 1);
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
      ...(!state.frameBaseSupportType ? { templateAssumptions: [{ field: 'boundary.frameBaseSupportType', value: 'fixed', en: 'Unstated frame bases default to fixed.', zh: '未说明柱脚时默认刚接。' }] } : {}),
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
