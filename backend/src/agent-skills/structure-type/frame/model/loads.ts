/** Frame floor, line and nodal load projection into load cases. */
import type { DraftFloorLoad, EngineeringDraftLoad, DraftState, EngineeringDraftLoadCaseType, EngineeringDraftLoadCombination } from '../../../../shared/types/agent.js';
import { isLocalizedFramePointLoad } from '../../../../agent-runtime/draft/project-patch.js';
import { n2dId } from './geometry.js';

export function buildStoryFloorLoadFields(deadLoad: number | undefined, liveLoad: number | undefined): Record<string, unknown> {
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

export function hasFloorLoadValue(floorLoads: DraftFloorLoad[] | undefined, loadKey?: 'verticalKN' | 'liveLoadKN'): boolean {
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

export function normalizeFloorLoadsByStory(floorLoads: DraftFloorLoad[]): DraftFloorLoad[] {
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

export type FrameNamedLoad = {
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

export function buildFrameLoadCaseBundle(
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

export function build2dBeamLineLoads(
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

export function build3dBeamLineLoads(
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

export function build2dEngineeringNodalLoads(
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
