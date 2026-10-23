import { frameNodalLoads } from '../../../../skill-shared/modelling/frame-loads.js';
import { regularFrameGeometry } from '../../../../skill-shared/modelling/geometry.js';
/** Planar concrete frame local model. */
import { accumulateCoords, n2dId, buildCommonModelFields } from './records.js';
import type { ConcreteFrameModel } from './records.js';
import type { ConcreteMaterialProps, RebarMaterialProps, SectionProps } from './materials.js';
import type { DraftState } from '../../../../shared/types/agent.js';
import { normalizeFloorLoadsByStory, buildStoryGravityNodalLoads, buildStoryFloorLoadFields, build2dConcreteBeamLineLoads, buildConcreteLoadCaseBundle } from './loads.js';

export function buildConcreteFrame2dLocalModel(options: {
  storyCount: number;
  bayCount: number;
  storyHeightsM: number[];
  bayWidthsM: number[];
  floorLoads: NonNullable<ConcreteFrameModel['floorLoads']>;
  frameBaseSupportType: string;
  frameConcreteGrade: string;
  frameRebarGrade?: string;
  frameColumnSection: string;
  frameBeamSection: string;
  concreteProps: ConcreteMaterialProps;
  rebarProps?: RebarMaterialProps;
  columnProps: SectionProps;
  beamProps: SectionProps;
  siteSeismic?: Record<string, unknown>;
  wind?: Record<string, unknown>;
  analysisControl?: Record<string, unknown>;
  engineeringDraft?: DraftState['engineeringDraft'];
}): ConcreteFrameModel {
  const xCoords = accumulateCoords(options.bayWidthsM);
  const zCoords = accumulateCoords(options.storyHeightsM);
  const floorLoads = normalizeFloorLoadsByStory(options.floorLoads);
  const { nodes, elements } = regularFrameGeometry({ dimension: '2d', bayWidthsX: options.bayWidthsM, storeyHeights: options.storyHeightsM, baseRestraint: options.frameBaseSupportType as 'fixed' | 'pinned' });
  for (const element of elements) { element.concrete_grade = options.frameConcreteGrade; element.rebar_grade = options.frameRebarGrade; }
  const deadLoads: Array<Record<string, unknown>> = [];
  const liveLoads: Array<Record<string, unknown>> = [];
  const lateralLoads: Array<Record<string, unknown>> = [];

  const levelNodeCount = xCoords.length;
  for (const load of floorLoads) {
    const storyIdx = load.story;
    if (storyIdx <= 0 || storyIdx >= zCoords.length) continue;
    const storyId = `F${storyIdx}`;
    const nodeIds = xCoords.map((_x, bayIdx) => n2dId(storyIdx, bayIdx));
    deadLoads.push(...buildStoryGravityNodalLoads(storyId, nodeIds, load.verticalKN, 'dead'));
    liveLoads.push(...buildStoryGravityNodalLoads(storyId, nodeIds, load.liveLoadKN, 'live'));
    const lPerNode = load.lateralXKN !== undefined ? load.lateralXKN / levelNodeCount : undefined;
    for (let bayIdx = 0; bayIdx < xCoords.length; bayIdx++) {
      const nodeLoad: Record<string, unknown> = {
        type: 'nodal',
        node: n2dId(storyIdx, bayIdx),
        story: storyId,
        source: 'story_lateral_loads',
      };
      if (lPerNode !== undefined) nodeLoad.fx = lPerNode;
      if (nodeLoad.fx !== undefined) lateralLoads.push(nodeLoad);
    }
  }

  const stories = options.storyHeightsM.map((height, index) => {
    const storyIdx = index + 1;
    const fl = floorLoads.find((load) => load.story === storyIdx);
    const floorAreaM2 = Math.max(xCoords[xCoords.length - 1], 1);
    const deadLoad = fl?.verticalKN ? fl.verticalKN / floorAreaM2 : undefined;
    const liveLoad = fl?.liveLoadKN ? fl.liveLoadKN / floorAreaM2 : undefined;
    return {
      id: `F${storyIdx}`,
      height,
      elevation: zCoords[index],
      standard_floor_group: 'SF1',
      ...buildStoryFloorLoadFields(deadLoad, liveLoad),
    };
  });
  const lineLoads = build2dConcreteBeamLineLoads(options.engineeringDraft, options.storyCount, elements);
  const loadCaseBundle = buildConcreteLoadCaseBundle(deadLoads, liveLoads, lineLoads, lateralLoads, {
    engineeringLoads: options.engineeringDraft?.loads,
    nodalLoads: frameNodalLoads(options.engineeringDraft?.loads, nodes),
    includeWind: options.wind !== undefined,
    includeSeismic: options.siteSeismic !== undefined,
    frameDimension: '2d',
    loadCombinations: options.engineeringDraft?.analysis?.loadCombinations,
  });
  const common = buildCommonModelFields({
    ...options,
    metadata: {
      frameDimension: '2d',
      inputEvidence: structuredClone(options.engineeringDraft?.inputEvidence ?? []),
      bayCount: options.bayCount,
      geometry: { storyHeightsM: options.storyHeightsM, bayWidthsM: options.bayWidthsM },
    },
  });

  return {
    ...common,
    nodes,
    elements,
    stories,
    ...loadCaseBundle,
    storyCount: options.storyCount,
    bayCount: options.bayCount,
    storyHeightsM: options.storyHeightsM,
    bayWidthsM: options.bayWidthsM,
    frameDimension: '2d',
    frameConcreteGrade: options.frameConcreteGrade,
    frameRebarGrade: options.frameRebarGrade,
    frameColumnSection: options.frameColumnSection,
    frameBeamSection: options.frameBeamSection,
    concreteProps: options.concreteProps,
    rebarProps: options.rebarProps,
    columnProps: options.columnProps,
    beamProps: options.beamProps,
    floorLoads,
    frameBaseSupportType: options.frameBaseSupportType,
  };
}
