import { computeMissingCriticalKeys } from '../../../agent-runtime/draft-guidance.js';
import {
  STRUCTURAL_COORDINATE_SEMANTICS,
  withCanonicalCoordinateContract,
} from '../../../engineering/coordinate-semantics.js';
import { isLocalizedFramePointLoad } from '../../../agent-runtime/engineering-draft.js';
import { buildElementReferenceVectors } from '../../../agent-runtime/reference-vectors.js';
import { buildExplicitDraftModel, validateExplicitModel } from '../../../agent-runtime/explicit-model.js';
import type {
  DraftFloorLoad,
  DraftState,
  EngineeringDraftLoad,
  EngineeringDraftLoadCaseType,
  EngineeringDraftLoadCombination,
} from '../../../shared/types/agent.js';
import { REQUIRED_KEYS } from './constants.js';

import { applyTemplateProperties } from '../../../agent-runtime/template-properties.js';
export { getDefaultColumnSection, getDefaultBeamSection, normalizeSteelGrade, normalizeSectionName } from '../../../agent-runtime/template-properties.js';

function accumulateCoords(lengths: number[]): number[] {
  const coords = [0];
  for (const value of lengths) {
    coords.push(coords[coords.length - 1] + value);
  }
  return coords;
}

function buildBaseRestraint(baseSupport: string): boolean[] {
  return baseSupport === 'pinned'
    ? [true, true, true, false, false, false]
    : [true, true, true, true, true, true];
}

function n2dId(storyIdx: number, bayNodeIdx: number): string {
  return `N${storyIdx}_${bayNodeIdx}`;
}

function n3dId(storyIdx: number, xIdx: number, yIdx: number): string {
  return `N${storyIdx}_${xIdx}_${yIdx}`;
}

function buildStoryFloorLoadFields(deadLoad: number | undefined, liveLoad: number | undefined): Record<string, unknown> {
  const exactDeadLoad = deadLoad && Number.isFinite(deadLoad) ? deadLoad : undefined;
  const exactLiveLoad = liveLoad && Number.isFinite(liveLoad) ? liveLoad : undefined;
  const floorLoads = [
    ...(exactDeadLoad ? [{ type: 'dead', value: exactDeadLoad }] : []),
    ...(exactLiveLoad ? [{ type: 'live', value: exactLiveLoad }] : []),
  ];

  return {
    ...(floorLoads.length ? { floor_loads: floorLoads } : {}),
    ...(exactDeadLoad ? { dead_load: exactDeadLoad } : {}),
    ...(exactLiveLoad ? { live_load: exactLiveLoad } : {}),
  };
}

function hasFloorLoadValue(floorLoads: DraftFloorLoad[] | undefined, loadKey?: 'verticalKN' | 'liveLoadKN'): boolean {
  return Boolean(floorLoads?.some((load) => {
    if (loadKey) {
      const value = load[loadKey];
      return typeof value === 'number' && Number.isFinite(value) && value !== 0;
    }
    return (
      (typeof load.verticalKN === 'number' && Number.isFinite(load.verticalKN) && load.verticalKN !== 0)
      || (typeof load.liveLoadKN === 'number' && Number.isFinite(load.liveLoadKN) && load.liveLoadKN !== 0)
      || (typeof load.lateralXKN === 'number' && Number.isFinite(load.lateralXKN) && load.lateralXKN !== 0)
      || (typeof load.lateralYKN === 'number' && Number.isFinite(load.lateralYKN) && load.lateralYKN !== 0)
    );
  }));
}

function isLineEngineeringLoad(load: EngineeringDraftLoad): boolean {
  return load.kind === 'line' || load.kind === 'distributed' || load.unit === 'kN/m';
}

function isGravityLineLoad(load: EngineeringDraftLoad): boolean {
  return isLineEngineeringLoad(load)
    && Number.isFinite(load.magnitude)
    && (load.direction === undefined || load.direction === 'gravity' || load.direction === 'globalZ');
}

function isExplicit2dNodalLoad(load: EngineeringDraftLoad): boolean {
  return (load.kind === 'nodal' || load.kind === 'point')
    && Number.isFinite(load.magnitude)
    && Number.isFinite(load.magnitude)
    && isLocalizedFramePointLoad(load)
    && (load.direction === undefined || load.direction === 'globalX' || load.direction === 'gravity' || load.direction === 'globalZ');
}

export function hasFrameAnalysisLoadInput(state: Pick<DraftState, 'floorLoads' | 'engineeringDraft' | 'wind' | 'frameDimension'>): boolean {
  if (hasFloorLoadValue(state.floorLoads)) return true;
  if (typeof state.wind?.basicPressureKNM2 === 'number' && Number.isFinite(state.wind.basicPressureKNM2) && state.wind.basicPressureKNM2 > 0) {
    return true;
  }
  return Boolean(state.engineeringDraft?.loads?.some((load) => (
    Number.isFinite(load.magnitude)
    && Number.isFinite(load.magnitude)
    && (isGravityLineLoad(load) || (state.frameDimension !== '3d' && isExplicit2dNodalLoad(load)))
  )));
}

function isTopStoryLineLoadTarget(target: string): boolean {
  const trimmed = target.trim();
  const text = trimmed.toLowerCase();
  return text.includes('roof')
    || /屋面|屋顶|楼顶|顶层|顶楼/u.test(trimmed)
    || trimmed === '顶';
}

function parseLineLoadStory(target: string | undefined, storyCount: number): number | undefined {
  if (!target) return undefined;
  const text = target.toLowerCase();
  if (isTopStoryLineLoadTarget(target)) return storyCount;
  const numericMatch = text.match(/(?:floor|story|level)\s*([0-9]+)/i)
    ?? target.match(/第?\s*([0-9]+)\s*层/u);
  if (numericMatch?.[1]) {
    const parsed = Number.parseInt(numericMatch[1], 10);
    return parsed >= 1 && parsed <= storyCount ? parsed : undefined;
  }
  const chineseMatch = target.match(/第?\s*([一二两三四五六七八九十廿]+)\s*层/u);
  if (!chineseMatch?.[1]) return undefined;
  const table: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
    廿: 20,
  };
  const raw = chineseMatch[1];
  let parsed: number | undefined;
  if (raw === '十' || raw === '廿') {
    parsed = table[raw];
  } else if (raw.startsWith('十')) {
    parsed = 10 + (table[raw[1]] ?? 0);
  } else if (raw.startsWith('廿')) {
    parsed = 20 + (table[raw[1]] ?? 0);
  } else if (raw.endsWith('十')) {
    parsed = (table[raw[0]] ?? 1) * 10;
  } else if (raw.includes('十')) {
    const [tens, ones] = raw.split('十');
    parsed = (table[tens] ?? 1) * 10 + (table[ones] ?? 0);
  } else {
    parsed = table[raw];
  }
  return parsed !== undefined && parsed >= 1 && parsed <= storyCount ? parsed : undefined;
}

function normalizeFloorLoadsByStory(floorLoads: DraftFloorLoad[]): DraftFloorLoad[] {
  const merged = new Map<number, DraftFloorLoad>();
  for (const load of floorLoads) {
    if (typeof load.story !== 'number' || !Number.isFinite(load.story)) continue;
    const current = merged.get(load.story);
    merged.set(load.story, {
      story: load.story,
      verticalKN: load.verticalKN ?? current?.verticalKN,
      liveLoadKN: load.liveLoadKN ?? current?.liveLoadKN,
      lateralXKN: load.lateralXKN ?? current?.lateralXKN,
      lateralYKN: load.lateralYKN ?? current?.lateralYKN,
    });
  }
  return Array.from(merged.values()).sort((left, right) => left.story - right.story);
}

type FrameNamedLoad = {
  record: Record<string, unknown>;
  caseId?: string;
  caseType?: EngineeringDraftLoadCaseType;
};

type FrameLoadCase = {
  id: string;
  type: EngineeringDraftLoadCaseType;
  loads: Array<Record<string, unknown>>;
  description?: string;
};

function buildFrameLoadCaseBundle(
  state: DraftState,
  hasDeadFloorLoads: boolean,
  hasLiveFloorLoads: boolean,
  lineLoads: FrameNamedLoad[],
  nodalLoads: FrameNamedLoad[],
): { load_cases: FrameLoadCase[]; load_combinations: EngineeringDraftLoadCombination[] } {
  const loadCases = new Map<string, FrameLoadCase>();
  const addLoadCase = (
    id: string,
    type: EngineeringDraftLoadCaseType,
    loads: Array<Record<string, unknown>>,
    description?: string,
  ): void => {
    const existing = loadCases.get(id);
    if (existing) {
      existing.loads.push(...loads);
      if (existing.type === 'other' && type !== 'other') existing.type = type;
      return;
    }
    loadCases.set(id, { id, type, loads: [...loads], ...(description ? { description } : {}) });
  };

  if (hasDeadFloorLoads) {
    addLoadCase('D', 'dead', [], 'Dead floor loads from stories.floor_loads');
  }
  if (hasLiveFloorLoads) {
    addLoadCase('L', 'live', [], 'Live floor loads from stories.floor_loads');
  }
  for (const lineLoad of lineLoads) {
    addLoadCase(
      lineLoad.caseId ?? 'LINE',
      lineLoad.caseType ?? 'other',
      [lineLoad.record],
      'Frame beam line loads',
    );
  }
  for (const nodalLoad of nodalLoads) {
    addLoadCase(
      nodalLoad.caseId ?? 'LAT',
      nodalLoad.caseType ?? 'other',
      [nodalLoad.record],
      'Frame nodal loads',
    );
  }
  if (!loadCases.size) {
    addLoadCase('LC1', 'other', []);
  }

  const explicitCombinations = state.engineeringDraft?.analysis?.loadCombinations;
  const loadCombinations = (explicitCombinations ?? []).map((combination) => ({
        id: combination.id,
        factors: { ...combination.factors },
      }));
  return {
    load_cases: Array.from(loadCases.values()),
    load_combinations: loadCombinations,
  };
}

type ResolvedFrameLineLoad = {
  load: EngineeringDraftLoad;
  story: number;
  elementId?: string;
};

function resolveFrameLineLoadsByStory(
  state: DraftState,
  storyCount: number,
  elements: Array<Record<string, unknown>>,
): ResolvedFrameLineLoad[] {
  const lineLoads = state.engineeringDraft?.loads?.filter(isGravityLineLoad) ?? [];
  if (!lineLoads.length || storyCount <= 0) return [];

  const resolved: ResolvedFrameLineLoad[] = [];
  for (const load of lineLoads) {
    const normalizedTarget = load.target?.trim().toLowerCase();
    const targetElement = normalizedTarget
      ? elements.find((element) => (
          element.type === 'beam'
          && String(element.id ?? '').trim().toLowerCase() === normalizedTarget
        ))
      : undefined;
    const targetStoryMatch = String(targetElement?.story ?? '').match(/^F(\d+)$/iu);
    const targetStory = targetStoryMatch ? Number.parseInt(targetStoryMatch[1]!, 10) : undefined;
    if (targetElement && targetStory !== undefined && targetStory >= 1 && targetStory <= storyCount) {
      resolved.push({ load, story: targetStory, elementId: String(targetElement.id) });
      continue;
    }

    const locationStory = load.location?.story;
    const explicitStory = typeof locationStory === 'number'
      && Number.isInteger(locationStory)
      && locationStory >= 1
      && locationStory <= storyCount
      ? locationStory
      : parseLineLoadStory(load.target, storyCount);
    if (explicitStory !== undefined) {
      resolved.push({ load, story: explicitStory });
      continue;
    }
    for (let story = 1; story <= storyCount; story += 1) {
      resolved.push({ load, story });
    }
  }
  return resolved;
}

function build2dBeamLineLoads(
  state: DraftState,
  storyCount: number,
  elements: Array<Record<string, unknown>>,
): FrameNamedLoad[] {
  const resolved = resolveFrameLineLoadsByStory(state, storyCount, elements);
  if (!resolved.length) return [];

  const loads: FrameNamedLoad[] = [];
  for (const item of resolved) {
    const storyId = `F${item.story}`;
    const storyBeams = elements.filter(
      (element) => element.type === 'beam' && element.story === storyId,
    );
    const spanIndex = item.load.location?.spanIndex;
    const targetBeams = item.elementId
      ? storyBeams.filter((element) => String(element.id) === item.elementId)
      : spanIndex === undefined
      ? storyBeams
      : Number.isInteger(spanIndex) && spanIndex >= 1 && spanIndex <= storyBeams.length
        ? [storyBeams[spanIndex - 1]]
        : [];
    for (const element of targetBeams) {
      loads.push({
        record: {
          type: 'distributed',
          element: element.id,
          wz: (item.load.direction === 'globalZ' ? item.load.magnitude : -item.load.magnitude),
          story: storyId,
          source: 'engineering_draft_line_loads',
        },
        caseId: item.load.caseId,
        caseType: item.load.caseType,
      });
    }
  }
  return loads;
}

function lineLoadTargetAxis(target: string | undefined): 'x' | 'y' | undefined {
  if (!target) return undefined;
  const text = target.toLowerCase();
  if (/(?:x\s*(?:direction|axis)|x[-\s]?[向轴]|沿\s*x)/iu.test(text)) return 'x';
  if (/(?:y\s*(?:direction|axis)|y[-\s]?[向轴]|沿\s*y)/iu.test(text)) return 'y';
  return undefined;
}

function build3dBeamLineLoads(
  state: DraftState,
  storyCount: number,
  elements: Array<Record<string, unknown>>,
): FrameNamedLoad[] {
  const resolved = resolveFrameLineLoadsByStory(state, storyCount, elements);
  if (!resolved.length) return [];

  const loads: FrameNamedLoad[] = [];
  for (const item of resolved) {
    const storyId = `F${item.story}`;
    const axis = lineLoadTargetAxis(item.load.target);
    for (const element of elements) {
      if (element.type !== 'beam' || element.story !== storyId) continue;
      if (item.elementId && String(element.id) !== item.elementId) continue;
      const id = String(element.id ?? '');
      if (axis === 'x' && !id.startsWith('BX')) continue;
      if (axis === 'y' && !id.startsWith('BY')) continue;
      loads.push({
        record: {
          type: 'distributed',
          element: element.id,
          wz: (item.load.direction === 'globalZ' ? item.load.magnitude : -item.load.magnitude),
          story: storyId,
          source: 'engineering_draft_line_loads',
        },
        caseId: item.load.caseId,
        caseType: item.load.caseType,
      });
    }
  }
  return loads;
}

function frame2dNodeIndex(nodeRole: string, nodeCount: number): number | undefined {
  const role = nodeRole.trim().toLowerCase();
  if (role.includes('right') || role.includes('end') || /右侧|右端/u.test(role)) return nodeCount - 1;
  if (role.includes('left') || role.includes('start') || /左侧|左端/u.test(role)) return 0;
  if (role.includes('middle') || role.includes('center') || role.includes('centre') || /中间|中央/u.test(role)) {
    return Math.floor((nodeCount - 1) / 2);
  }
  return undefined;
}

function build2dEngineeringNodalLoads(
  state: DraftState,
  storyCount: number,
  levelNodeCount: number,
): FrameNamedLoad[] {
  const loads: FrameNamedLoad[] = [];
  for (const load of state.engineeringDraft?.loads ?? []) {
    if (!isExplicit2dNodalLoad(load)) continue;
    const story = load.location!.story!;
    if (story > storyCount) continue;
    const nodeIndex = frame2dNodeIndex(load.location!.nodeRole!, levelNodeCount);
    if (nodeIndex === undefined) continue;

    const nodeLoad: Record<string, unknown> = {
      type: 'nodal',
      node: n2dId(story, nodeIndex),
      story: `F${story}`,
      source: 'engineering_draft_nodal_loads',
    };
    if (load.direction === 'globalX') {
      nodeLoad.fx = load.magnitude;
    } else {
      nodeLoad.fz = (load.direction === 'globalZ' ? load.magnitude : -load.magnitude);
    }
    loads.push({
      record: nodeLoad,
      caseId: load.caseId,
      caseType: load.caseType,
    });
  }
  return loads;
}

function uniqueSortedCoordinates(values: number[]): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.filter((value, index) => index === 0 || Math.abs(value - sorted[index - 1]!) > 1e-9);
}

function coordinateIntervals(values: number[]): number[] {
  return values.slice(1).map((value, index) => value - values[index]!);
}

function explicitFrameRestraints(
  restraints: boolean[] | undefined,
  dimension: '2d' | '3d',
): boolean[] | undefined {
  if (!restraints) return undefined;
  if (dimension === '3d' || !restraints.some(Boolean)) return [...restraints];
  const [ux, , uz, , ry] = restraints;
  if (ux && uz && ry) return [true, true, true, true, true, true];
  return [Boolean(ux), true, Boolean(uz), false, Boolean(ry), false];
}

function buildExplicitFrameTopologyModel(
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
  const areaLoads = (state.engineeringDraft?.loads ?? []).filter((load) => (
    load.kind === 'area'
    && load.unit === 'kN/m2'
    && Number.isFinite(load.magnitude)
    && Number.isFinite(load.magnitude)
  ));
  const floorAreaM2 = state.frameDimension === '3d'
    ? Math.max((xCoords.at(-1)! - xCoords[0]!) * (yCoords.at(-1)! - yCoords[0]!), 1)
    : Math.max(xCoords.at(-1)! - xCoords[0]!, 1);
  const stories = coordinateIntervals(zCoords).map((height, index) => {
    const story = index + 1;
    const floorLoad = floorLoads.find((load) => load.story === story);
    const explicitAreaLoads = areaLoads.filter((load) => (
      load.location?.story === story
      || (load.location?.story === undefined && areaLoads.length === 1)
    ));
    const deadAreaLoad = explicitAreaLoads.find((load) => load.caseType !== 'live' && load.caseId !== 'L');
    const liveAreaLoad = explicitAreaLoads.find((load) => load.caseType === 'live' || load.caseId === 'L');
    const deadLoad = deadAreaLoad?.magnitude
      ?? (floorLoad?.verticalKN ? floorLoad.verticalKN / floorAreaM2 : undefined);
    const liveLoad = liveAreaLoad?.magnitude
      ?? (floorLoad?.liveLoadKN ? floorLoad.liveLoadKN / floorAreaM2 : undefined);
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
  const nodes: Array<Record<string, unknown>> = [];
  const elements: Array<Record<string, unknown>> = [];
  const lateralLoads: FrameNamedLoad[] = [];
  let elementId = 1;

  for (let storyIdx = 0; storyIdx < zCoords.length; storyIdx++) {
    for (let bayIdx = 0; bayIdx < xCoords.length; bayIdx++) {
      const node: Record<string, unknown> = {
        id: n2dId(storyIdx, bayIdx),
        x: xCoords[bayIdx],
        y: 0,
        z: zCoords[storyIdx],
        ...(storyIdx > 0 ? { story: `F${storyIdx}` } : {}),
      };
      if (storyIdx === 0) node.restraints = buildBaseRestraint(baseSupport);
      nodes.push(node);
    }
  }

  for (let storyIdx = 1; storyIdx < zCoords.length; storyIdx++) {
    for (let bayIdx = 0; bayIdx < xCoords.length; bayIdx++) {
      elements.push({ id: `C${elementId}`, type: 'column', nodes: [n2dId(storyIdx - 1, bayIdx), n2dId(storyIdx, bayIdx)], material: '1', section: '1', story: `F${storyIdx}` });
      elementId += 1;
    }
  }

  for (let storyIdx = 1; storyIdx < zCoords.length; storyIdx++) {
    for (let bayIdx = 0; bayIdx < bayWidths.length; bayIdx++) {
      elements.push({ id: `B${elementId}`, type: 'beam', nodes: [n2dId(storyIdx, bayIdx), n2dId(storyIdx, bayIdx + 1)], material: '1', section: '2', story: `F${storyIdx}` });
      elementId += 1;
    }
  }

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
  lateralLoads.push(...build2dEngineeringNodalLoads(state, storyHeights.length, levelNodeCount));

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
  const lineLoads = build2dBeamLineLoads(state, storyHeights.length, elements);
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
  const nodes: Array<Record<string, unknown>> = [];
  const elements: Array<Record<string, unknown>> = [];
  const lateralLoads: FrameNamedLoad[] = [];
  let elementId = 1;

  for (let storyIdx = 0; storyIdx < zCoords.length; storyIdx++) {
    for (let xIdx = 0; xIdx < xCoords.length; xIdx++) {
      for (let yIdx = 0; yIdx < yCoords.length; yIdx++) {
        const node: Record<string, unknown> = {
          id: n3dId(storyIdx, xIdx, yIdx),
          x: xCoords[xIdx],
          y: yCoords[yIdx],
          z: zCoords[storyIdx],
          ...(storyIdx > 0 ? { story: `F${storyIdx}` } : {}),
        };
        if (storyIdx === 0) node.restraints = buildBaseRestraint(baseSupport);
        nodes.push(node);
      }
    }
  }

  for (let storyIdx = 1; storyIdx < zCoords.length; storyIdx++) {
    for (let xIdx = 0; xIdx < xCoords.length; xIdx++) {
      for (let yIdx = 0; yIdx < yCoords.length; yIdx++) {
        elements.push({ id: `C${elementId}`, type: 'column', nodes: [n3dId(storyIdx - 1, xIdx, yIdx), n3dId(storyIdx, xIdx, yIdx)], material: '1', section: '1', story: `F${storyIdx}` });
        elementId += 1;
      }
    }
  }

  for (let storyIdx = 1; storyIdx < zCoords.length; storyIdx++) {
    for (let xIdx = 0; xIdx < bayWidthsX.length; xIdx++) {
      for (let yIdx = 0; yIdx < yCoords.length; yIdx++) {
        elements.push({ id: `BX${elementId}`, type: 'beam', nodes: [n3dId(storyIdx, xIdx, yIdx), n3dId(storyIdx, xIdx + 1, yIdx)], material: '1', section: '2', story: `F${storyIdx}` });
        elementId += 1;
      }
    }
  }

  for (let storyIdx = 1; storyIdx < zCoords.length; storyIdx++) {
    for (let xIdx = 0; xIdx < xCoords.length; xIdx++) {
      for (let yIdx = 0; yIdx < bayWidthsY.length; yIdx++) {
        elements.push({ id: `BY${elementId}`, type: 'beam', nodes: [n3dId(storyIdx, xIdx, yIdx), n3dId(storyIdx, xIdx, yIdx + 1)], material: '1', section: '2', story: `F${storyIdx}` });
        elementId += 1;
      }
    }
  }

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
  const lineLoads = build3dBeamLineLoads(state, storyHeights.length, elements);
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
