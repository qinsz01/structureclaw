/** Frame model from an explicit draft topology. */
import type { DraftState } from '../../../../shared/types/agent.js';
import { uniqueSortedCoordinates, explicitFrameRestraints, buildBaseRestraint, coordinateIntervals } from './geometry.js';
import { buildFrameMemberPointLoads, normalizeFloorLoadsByStory, buildStoryFloorLoadFields, build3dBeamLineLoads, build2dBeamLineLoads, buildFrameLoadCaseBundle } from './loads.js';
import type { FrameNamedLoad } from './loads.js';
import { buildElementReferenceVectors } from '../../../../agent-runtime/reference-vectors.js';
import { STRUCTURAL_COORDINATE_SEMANTICS } from '../../../../engineering/coordinate-semantics.js';

export function buildExplicitFrameTopologyModel(
  state: DraftState,
  metadata: Record<string, unknown>,
): Record<string, unknown> | null {
  const topology = state.engineeringDraft?.topology;
  if (!topology?.nodes?.length || !topology.members?.length) return null;

  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  if (nodeById.size !== topology.nodes.length
    || topology.members.some((member) => !nodeById.has(member.nodes[0]) || !nodeById.has(member.nodes[1]))) {
    throw new Error('INVALID_EXPLICIT_TOPOLOGY: duplicate nodes or missing member endpoint / 节点重复或构件端点不存在');
  }

  const zCoords = uniqueSortedCoordinates(topology.nodes.map((node) => node.z));
  if (zCoords.length < 2) throw new Error('INVALID_EXPLICIT_TOPOLOGY: frame template requires distinct elevations; use the complete V2 model for other topology / 框架模板需要不同标高，其他拓扑请使用完整V2模型');
  const xCoords = uniqueSortedCoordinates(topology.nodes.map((node) => node.x));
  const yCoords = uniqueSortedCoordinates(topology.nodes.map((node) => node.y));
  const minZ = zCoords[0]!;
  const storyIndexAt = (z: number): number => zCoords.findIndex((value) => Math.abs(value - z) <= 1e-9);
  const baseSupport = (state.frameBaseSupportType as string | undefined) ?? 'fixed';
  const dimension = state.frameDimension === '3d' ? '3d' : '2d';

  const nodes: Array<Record<string, unknown>> = topology.nodes.map((node) => {
    const storyIndex = storyIndexAt(node.z);
    const restraints = explicitFrameRestraints(node.restraints, dimension);
    return {
      id: node.id,
      x: node.x,
      y: node.y,
      z: node.z,
      ...(storyIndex > 0 ? { story: `F${storyIndex}` } : {}),
      ...(restraints
        ? { restraints }
        : Math.abs(node.z - minZ) <= 1e-9
          ? { restraints: buildBaseRestraint(baseSupport) }
          : {}),
    };
  });

  const elements: Array<Record<string, unknown>> = topology.members.map((member, index) => {
    const start = nodeById.get(member.nodes[0])!;
    const end = nodeById.get(member.nodes[1])!;
    const isColumn = Math.abs(start.x - end.x) <= 1e-9
      && Math.abs(start.y - end.y) <= 1e-9
      && Math.abs(start.z - end.z) > 1e-9;
    const storyIndex = storyIndexAt(Math.max(start.z, end.z));
    return {
      id: member.id ?? `E${index + 1}`,
      type: isColumn ? 'column' : 'beam',
      nodes: [...member.nodes],
      material: '1',
      section: isColumn ? '1' : '2',
      ...(storyIndex > 0 ? { story: `F${storyIndex}` } : {}),
    };
  });

  const floorLoads = normalizeFloorLoadsByStory(state.floorLoads ?? []);
  const floorAreaM2 = state.frameDimension === '3d'
    ? (xCoords.at(-1)! - xCoords[0]!) * (yCoords.at(-1)! - yCoords[0]!)
    : xCoords.at(-1)! - xCoords[0]!;
  const stories = coordinateIntervals(zCoords).map((height, index) => {
    const story = index + 1;
    const floorLoad = floorLoads.find((load) => load.story === story);
    const deadLoad = floorLoad?.verticalKN ? floorLoad.verticalKN / floorAreaM2 : undefined;
    const liveLoad = floorLoad?.liveLoadKN ? floorLoad.liveLoadKN / floorAreaM2 : undefined;
    return {
      id: `F${story}`,
      height,
      elevation: zCoords[index],
      standard_floor_group: 'SF1',
      ...buildStoryFloorLoadFields(deadLoad, liveLoad),
    };
  });

  const lateralLoads: FrameNamedLoad[] = [];
  for (const floorLoad of floorLoads) {
    const storyNodes = topology.nodes.filter((node) => storyIndexAt(node.z) === floorLoad.story);
    if (!storyNodes.length) continue;
    for (const node of storyNodes) {
      const record: Record<string, unknown> = {
        type: 'nodal',
        node: node.id,
        story: `F${floorLoad.story}`,
        source: 'story_lateral_loads',
      };
      if (floorLoad.lateralXKN !== undefined) record.fx = floorLoad.lateralXKN / storyNodes.length;
      if (floorLoad.lateralYKN !== undefined) record.fy = floorLoad.lateralYKN / storyNodes.length;
      if (record.fx !== undefined || record.fy !== undefined) lateralLoads.push({ record });
    }
  }

  const lineLoads = state.frameDimension === '3d'
    ? build3dBeamLineLoads(state, stories.length, elements)
    : build2dBeamLineLoads(state, stories.length, elements);
  lineLoads.push(...buildFrameMemberPointLoads(state, elements, nodes));
  const loadCaseBundle = buildFrameLoadCaseBundle(
    state,
    stories.some((story) => 'dead_load' in story),
    stories.some((story) => 'live_load' in story),
    lineLoads,
    lateralLoads,
  );
  const elementReferenceVectors = state.frameDimension === '3d'
    ? buildElementReferenceVectors(elements, nodes)
    : undefined;

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
      topologySource: 'engineering-draft',
      ...(elementReferenceVectors ? { elementReferenceVectors } : {}),
      baseSupport,
      storyCount: stories.length,
      ...(state.frameDimension === '3d'
        ? {
            bayCountX: Math.max(0, xCoords.length - 1),
            bayCountY: Math.max(0, yCoords.length - 1),
            geometry: {
              storyHeightsM: coordinateIntervals(zCoords),
              bayWidthsXM: coordinateIntervals(xCoords),
              bayWidthsYM: coordinateIntervals(yCoords),
            },
          }
        : {
            bayCount: Math.max(0, xCoords.length - 1),
            geometry: {
              storyHeightsM: coordinateIntervals(zCoords),
              bayWidthsM: coordinateIntervals(xCoords),
            },
          }),
    },
  };
}
