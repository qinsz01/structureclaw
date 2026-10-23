import { frameNodalLoads } from '../../../../skill-shared/modelling/frame-loads.js';
import { regularFrameGeometry } from '../../../../skill-shared/modelling/geometry.js';
/** Spatial concrete frame local model. */
import { accumulateCoords, n3dId, buildCommonModelFields } from './records.js';
import type { ConcreteFrameModel } from './records.js';
import type { ConcreteMaterialProps, RebarMaterialProps, SectionProps } from './materials.js';
import type { DraftState } from '../../../../shared/types/agent.js';
import { normalizeFloorLoadsByStory, buildStoryGravityNodalLoads, buildStoryFloorLoadFields, build3dConcreteBeamLineLoads, buildConcreteLoadCaseBundle } from './loads.js';
import { buildElementReferenceVectors } from '../../../../agent-runtime/reference-vectors.js';

export function buildConcreteFrame3dLocalModel(options: {
  storyCount: number;
  bayCountX: number;
  bayCountY: number;
  storyHeightsM: number[];
  bayWidthsXM: number[];
  bayWidthsYM: number[];
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
  const xCoords = accumulateCoords(options.bayWidthsXM);
  const yCoords = accumulateCoords(options.bayWidthsYM);
  const zCoords = accumulateCoords(options.storyHeightsM);
  const floorLoads = normalizeFloorLoadsByStory(options.floorLoads);
  const { nodes, elements } = regularFrameGeometry({ dimension: '3d', bayWidthsX: options.bayWidthsXM, bayWidthsY: options.bayWidthsYM, storeyHeights: options.storyHeightsM, baseRestraint: options.frameBaseSupportType as 'fixed' | 'pinned' });
  for (const element of elements) { element.concrete_grade = options.frameConcreteGrade; element.rebar_grade = options.frameRebarGrade; }
  const deadLoads: Array<Record<string, unknown>> = [];
  const liveLoads: Array<Record<string, unknown>> = [];
  const lateralLoads: Array<Record<string, unknown>> = [];

  const levelNodeCount = xCoords.length * yCoords.length;
  for (const load of floorLoads) {
    const storyIdx = load.story;
    if (storyIdx <= 0 || storyIdx >= zCoords.length) continue;
    const storyId = `F${storyIdx}`;
    const nodeIds = xCoords.flatMap((_x, xIdx) => yCoords.map((_y, yIdx) => n3dId(storyIdx, xIdx, yIdx)));
    deadLoads.push(...buildStoryGravityNodalLoads(storyId, nodeIds, load.verticalKN, 'dead'));
    liveLoads.push(...buildStoryGravityNodalLoads(storyId, nodeIds, load.liveLoadKN, 'live'));
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
        if (nodeLoad.fx !== undefined || nodeLoad.fy !== undefined) lateralLoads.push(nodeLoad);
      }
    }
  }

  const elementReferenceVectors = buildElementReferenceVectors(elements, nodes);
  const stories = options.storyHeightsM.map((height, index) => {
    const storyIdx = index + 1;
    const fl = floorLoads.find((load) => load.story === storyIdx);
    const floorAreaM2 = xCoords[xCoords.length - 1] * yCoords[yCoords.length - 1];
    const deadLoad = fl?.verticalKN ? fl.verticalKN / floorAreaM2 : undefined;
    const liveLoad = fl?.liveLoadKN ? fl.liveLoadKN / floorAreaM2 : undefined;
    return {
      id: `F${storyIdx}`,
      height,
      elevation: zCoords[index],
      standard_floor_group: 'SF1',
      load_area_m2: floorAreaM2,
      ...buildStoryFloorLoadFields(deadLoad, liveLoad),
    };
  });
  const lineLoads = build3dConcreteBeamLineLoads(options.engineeringDraft, options.storyCount, elements);
  const loadCaseBundle = buildConcreteLoadCaseBundle(deadLoads, liveLoads, lineLoads, lateralLoads, {
    engineeringLoads: options.engineeringDraft?.loads,
    nodalLoads: frameNodalLoads(options.engineeringDraft?.loads, nodes),
    includeWind: options.wind !== undefined,
    includeSeismic: options.siteSeismic !== undefined,
    frameDimension: '3d',
    loadCombinations: options.engineeringDraft?.analysis?.loadCombinations,
  });
  const common = buildCommonModelFields({
    ...options,
    metadata: {
      frameDimension: '3d',
      inputEvidence: structuredClone(options.engineeringDraft?.inputEvidence ?? []),
      elementReferenceVectors,
      bayCountX: options.bayCountX,
      bayCountY: options.bayCountY,
      geometry: {
        storyHeightsM: options.storyHeightsM,
        bayWidthsXM: options.bayWidthsXM,
        bayWidthsYM: options.bayWidthsYM,
      },
    },
  });

  return {
    ...common,
    nodes,
    elements,
    stories,
    ...loadCaseBundle,
    storyCount: options.storyCount,
    bayCountX: options.bayCountX,
    bayCountY: options.bayCountY,
    storyHeightsM: options.storyHeightsM,
    bayWidthsXM: options.bayWidthsXM,
    bayWidthsYM: options.bayWidthsYM,
    frameDimension: '3d',
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
