import { frameNodalLoads } from '../../../skill-shared/modelling/frame-loads.js';
import { regularFrameGeometry } from '../../../skill-shared/modelling/geometry.js';
import { computeMissingCriticalKeys } from '../../../agent-runtime/draft-guidance.js';
import { STRUCTURAL_COORDINATE_SEMANTICS, withCanonicalCoordinateContract } from '../../../engineering/coordinate-semantics.js';
import { buildElementReferenceVectors } from '../../../agent-runtime/reference-vectors.js';
import { buildExplicitDraftModel, validateExplicitModel } from '../../../agent-runtime/explicit-model.js';
import type { DraftState } from '../../../shared/types/agent.js';
import { REQUIRED_KEYS } from './constants.js';
import { applyTemplateProperties } from '../../../agent-runtime/template-properties.js';
import { buildFrameMemberPointLoads, normalizeFloorLoadsByStory, buildStoryFloorLoadFields, build2dBeamLineLoads, buildFrameLoadCaseBundle, hasFloorLoadValue, build3dBeamLineLoads, hasFrameAnalysisLoadInput } from './model/loads.js';
import type { FrameNamedLoad } from './model/loads.js';
import { accumulateCoords, n2dId, n3dId } from './model/geometry.js';
import { buildExplicitFrameTopologyModel } from './model/explicit-topology.js';

function buildFrame2dLocalModel(
  state: DraftState,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const bayWidths = state.bayWidthsM!;
  const storyHeights = state.storyHeightsM!;
  const floorLoads = normalizeFloorLoadsByStory(state.floorLoads ?? []);
  const baseSupport = (state.frameBaseSupportType as string | undefined) ?? 'fixed';
  const xCoords = accumulateCoords(bayWidths);
  const zCoords = accumulateCoords(storyHeights);
  const { nodes, elements } = regularFrameGeometry({ dimension: '2d', bayWidthsX: bayWidths, storeyHeights: storyHeights, baseRestraint: baseSupport as 'fixed' | 'pinned' });
  const lateralLoads: FrameNamedLoad[] = [];

  const levelNodeCount = xCoords.length;
  for (const load of floorLoads) {
    const storyIdx = load.story;
    if (storyIdx <= 0 || storyIdx >= zCoords.length) continue;
    const storyId = `F${storyIdx}`;
    const lPerNode = load.lateralXKN !== undefined ? load.lateralXKN / levelNodeCount : undefined;
    for (let bayIdx = 0; bayIdx < xCoords.length; bayIdx++) {
      const nodeLoad: Record<string, unknown> = {
        type: 'nodal',
        node: n2dId(storyIdx, bayIdx),
        story: storyId,
        source: 'story_lateral_loads',
      };
      if (lPerNode !== undefined) nodeLoad.fx = lPerNode;
      if (nodeLoad.fx !== undefined) lateralLoads.push({ record: nodeLoad });
    }
  }
  lateralLoads.push(...frameNodalLoads(state.engineeringDraft?.loads, nodes));

  const stories = storyHeights.map((h, i) => {
    const storyIdx = i + 1;
    const fl = floorLoads.find((l) => l.story === storyIdx);
    const floorAreaM2 = Math.max(xCoords[xCoords.length - 1], 1);
    const deadLoad = fl?.verticalKN ? fl.verticalKN / floorAreaM2 : undefined;
    const liveLoad = fl?.liveLoadKN ? fl.liveLoadKN / floorAreaM2 : undefined;
    return {
      id: `F${storyIdx}`,
      height: h,
      elevation: zCoords[i],
      standard_floor_group: 'SF1',
      ...buildStoryFloorLoadFields(deadLoad, liveLoad),
    };
  });
  const lineLoads = [...build2dBeamLineLoads(state, storyHeights.length, elements), ...buildFrameMemberPointLoads(state, elements, nodes)];
  const loadCaseBundle = buildFrameLoadCaseBundle(
    state,
    hasFloorLoadValue(floorLoads, 'verticalKN'),
    hasFloorLoadValue(floorLoads, 'liveLoadKN'),
    lineLoads,
    lateralLoads,
  );

  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    nodes,
    elements,
    materials: [],
    sections: [],
    stories,
    ...loadCaseBundle,
    metadata: {
      ...metadata,
      coordinateSemantics: STRUCTURAL_COORDINATE_SEMANTICS,
      baseSupport,
      ...(!state.frameBaseSupportType ? { templateAssumptions: [{ field: 'boundary.frameBaseSupportType', value: 'fixed', en: 'Unstated frame bases default to fixed.', zh: '未说明柱脚时默认刚接。' }] } : {}),
      storyCount: storyHeights.length,
      bayCount: bayWidths.length,
      geometry: { storyHeightsM: storyHeights, bayWidthsM: bayWidths },
    },
  };
}

function buildFrame3dLocalModel(
  state: DraftState,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const bayWidthsX = state.bayWidthsXM!;
  const bayWidthsY = state.bayWidthsYM!;
  const storyHeights = state.storyHeightsM!;
  const floorLoads = normalizeFloorLoadsByStory(state.floorLoads ?? []);
  const baseSupport = (state.frameBaseSupportType as string | undefined) ?? 'fixed';
  const xCoords = accumulateCoords(bayWidthsX);
  const yCoords = accumulateCoords(bayWidthsY);
  const zCoords = accumulateCoords(storyHeights);
  const { nodes, elements } = regularFrameGeometry({ dimension: '3d', bayWidthsX: bayWidthsX, bayWidthsY: bayWidthsY, storeyHeights: storyHeights, baseRestraint: baseSupport as 'fixed' | 'pinned' });
  const lateralLoads: FrameNamedLoad[] = [];

  const levelNodeCount = xCoords.length * yCoords.length;
  for (const load of floorLoads) {
    const storyIdx = load.story;
    if (storyIdx <= 0 || storyIdx >= zCoords.length) continue;
    const storyId = `F${storyIdx}`;
    const lxPerNode = load.lateralXKN !== undefined ? load.lateralXKN / levelNodeCount : undefined;
    const lyPerNode = load.lateralYKN !== undefined ? load.lateralYKN / levelNodeCount : undefined;
    for (let xIdx = 0; xIdx < xCoords.length; xIdx++) {
      for (let yIdx = 0; yIdx < yCoords.length; yIdx++) {
        const nodeLoad: Record<string, unknown> = {
          type: 'nodal',
          node: n3dId(storyIdx, xIdx, yIdx),
          story: storyId,
          source: 'story_lateral_loads',
        };
        if (lxPerNode !== undefined) nodeLoad.fx = lxPerNode;
        if (lyPerNode !== undefined) nodeLoad.fy = lyPerNode;
        if (nodeLoad.fx !== undefined || nodeLoad.fy !== undefined) lateralLoads.push({ record: nodeLoad });
      }
    }
  }

  lateralLoads.push(...frameNodalLoads(state.engineeringDraft?.loads, nodes));

  const elementReferenceVectors = buildElementReferenceVectors(elements, nodes);
  const stories = storyHeights.map((h, i) => {
    const storyIdx = i + 1;
    const fl = floorLoads.find((l) => l.story === storyIdx);
    const floorAreaM2 = Math.max(xCoords[xCoords.length - 1], 1) * Math.max(yCoords[yCoords.length - 1], 1);
    const deadLoad = fl?.verticalKN ? fl.verticalKN / floorAreaM2 : undefined;
    const liveLoad = fl?.liveLoadKN ? fl.liveLoadKN / floorAreaM2 : undefined;
    return {
      id: `F${storyIdx}`,
      height: h,
      elevation: zCoords[i],
      standard_floor_group: 'SF1',
      ...buildStoryFloorLoadFields(deadLoad, liveLoad),
    };
  });
  const lineLoads = [...build3dBeamLineLoads(state, storyHeights.length, elements), ...buildFrameMemberPointLoads(state, elements, nodes)];
  const loadCaseBundle = buildFrameLoadCaseBundle(
    state,
    hasFloorLoadValue(floorLoads, 'verticalKN'),
    hasFloorLoadValue(floorLoads, 'liveLoadKN'),
    lineLoads,
    lateralLoads,
  );

  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    nodes,
    elements,
    materials: [],
    sections: [],
    stories,
    ...loadCaseBundle,
    metadata: {
      ...metadata,
      coordinateSemantics: STRUCTURAL_COORDINATE_SEMANTICS,
      elementReferenceVectors,
      baseSupport,
      ...(!state.frameBaseSupportType ? { templateAssumptions: [{ field: 'boundary.frameBaseSupportType', value: 'fixed', en: 'Unstated frame bases default to fixed.', zh: '未说明柱脚时默认刚接。' }] } : {}),
      storyCount: storyHeights.length,
      bayCountX: bayWidthsX.length,
      bayCountY: bayWidthsY.length,
      geometry: { storyHeightsM: storyHeights, bayWidthsXM: bayWidthsX, bayWidthsYM: bayWidthsY },
    },
  };
}

function buildFrameLocalModel(state: DraftState): Record<string, unknown> {
  const metadata: Record<string, unknown> = { source: 'markdown-skill-draft', inferredType: 'frame', frameDimension: state.frameDimension === '3d' ? '3d' : '2d' };
  const explicitTopologyModel = buildExplicitFrameTopologyModel(state, metadata);
  if (explicitTopologyModel) return explicitTopologyModel;
  if (state.frameDimension === '3d') {
    return buildFrame3dLocalModel(state, metadata);
  }
  return buildFrame2dLocalModel(state, metadata);
}

export function buildFrameModel(state: DraftState): Record<string, unknown> | undefined {
  const explicit = buildExplicitDraftModel(state);
  if (explicit) return explicit;
  const critical = computeMissingCriticalKeys(state).filter((key) => (
    (REQUIRED_KEYS as readonly string[]).includes(key)
    && !(key === 'floorLoads' && hasFrameAnalysisLoadInput(state))
  ));
  if (critical.length > 0) return undefined;
  return validateExplicitModel(withCanonicalCoordinateContract(
    applyTemplateProperties(buildFrameLocalModel(state), state),
    state.frameDimension === '3d' ? '3d' : '2d',
  ));
}
