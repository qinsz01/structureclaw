import { hasFrameNodalLoadInput } from '../../../../skill-shared/modelling/frame-loads.js';
/** Concrete-frame floor and line load projection into load cases. */
import type { DraftFloorLoad, EngineeringDraftLoad, DraftState, EngineeringDraft } from '../../../../shared/types/agent.js';

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

export function buildStoryGravityNodalLoads(
  storyId: string,
  nodeIds: string[],
  totalLoadKN: number | undefined,
  loadKind: 'dead' | 'live',
): Array<Record<string, unknown>> {
  if (typeof totalLoadKN !== 'number' || !Number.isFinite(totalLoadKN) || totalLoadKN === 0 || nodeIds.length === 0) {
    return [];
  }
  const fzPerNode = -totalLoadKN / nodeIds.length;
  return nodeIds.map((node) => ({
    type: 'nodal',
    node,
    fz: fzPerNode,
    story: storyId,
    source: 'story_floor_loads',
    load_kind: loadKind,
  }));
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

function hasFloorLoadValue(floorLoads: DraftFloorLoad[] | undefined): boolean {
  return Boolean(floorLoads?.some((load) => (
    (typeof load.verticalKN === 'number' && Number.isFinite(load.verticalKN) && load.verticalKN !== 0)
    || (typeof load.liveLoadKN === 'number' && Number.isFinite(load.liveLoadKN) && load.liveLoadKN !== 0)
    || (typeof load.lateralXKN === 'number' && Number.isFinite(load.lateralXKN) && load.lateralXKN !== 0)
    || (typeof load.lateralYKN === 'number' && Number.isFinite(load.lateralYKN) && load.lateralYKN !== 0)
  )));
}

function isLineEngineeringLoad(load: EngineeringDraftLoad): boolean {
  return load.kind === 'line' || load.kind === 'distributed' || load.unit === 'kN/m';
}

function isGravityLineLoad(load: EngineeringDraftLoad): boolean {
  return isLineEngineeringLoad(load)
    && Number.isFinite(load.magnitude)
    && (load.direction === undefined || load.direction === 'gravity' || load.direction === 'globalZ');
}

export function hasConcreteFrameAnalysisLoadInput(state: Pick<DraftState, 'floorLoads' | 'engineeringDraft' | 'wind'>): boolean {
  if (hasFloorLoadValue(state.floorLoads) || hasFrameNodalLoadInput(state)) return true;
  if (typeof state.wind?.basicPressureKNM2 === 'number' && Number.isFinite(state.wind.basicPressureKNM2) && state.wind.basicPressureKNM2 > 0) {
    return true;
  }
  return Boolean(state.engineeringDraft?.loads?.some((load) => (
    Number.isFinite(load.magnitude)
    && Number.isFinite(load.magnitude)
    && isGravityLineLoad(load)
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

type ResolvedConcreteFrameLineLoad = {
  load: EngineeringDraftLoad;
  story: number;
};

function resolveConcreteFrameLineLoadsByStory(
  engineeringDraft: DraftState['engineeringDraft'] | undefined,
  storyCount: number,
): ResolvedConcreteFrameLineLoad[] {
  const lineLoads = engineeringDraft?.loads?.filter(isGravityLineLoad) ?? [];
  if (!lineLoads.length || storyCount <= 0) return [];

  const resolved: ResolvedConcreteFrameLineLoad[] = [];
  for (const load of lineLoads) {
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

export function build2dConcreteBeamLineLoads(
  engineeringDraft: DraftState['engineeringDraft'] | undefined,
  storyCount: number,
  elements: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const resolved = resolveConcreteFrameLineLoadsByStory(engineeringDraft, storyCount);
  if (!resolved.length) return [];

  const loads: Array<Record<string, unknown>> = [];
  for (const item of resolved) {
    const storyId = `F${item.story}`;
    const storyBeams = elements.filter(
      (element) => element.type === 'beam' && element.story === storyId,
    );
    const spanIndex = item.load.location?.spanIndex;
    const targetBeams = spanIndex === undefined
      ? storyBeams
      : Number.isInteger(spanIndex) && spanIndex >= 1 && spanIndex <= storyBeams.length
        ? [storyBeams[spanIndex - 1]]
        : [];
    for (const element of targetBeams) {
      loads.push({
        type: 'distributed',
        element: element.id,
        wz: (item.load.direction === 'globalZ' ? item.load.magnitude : -item.load.magnitude),
        story: storyId,
        source: 'engineering_draft_line_loads',
      });
    }
  }
  return loads;
}

// Reads the LLM-extracted free-text load `target` label: the draft has no structured beam-axis
// field. An unmatched label loads every beam of the story.
function lineLoadTargetAxis(target: string | undefined): 'x' | 'y' | undefined {
  if (!target) return undefined;
  const text = target.toLowerCase();
  if (/(?:x\s*(?:direction|axis)|x[-\s]?[向轴]|沿\s*x)/iu.test(text)) return 'x';
  if (/(?:y\s*(?:direction|axis)|y[-\s]?[向轴]|沿\s*y)/iu.test(text)) return 'y';
  return undefined;
}

export function build3dConcreteBeamLineLoads(
  engineeringDraft: DraftState['engineeringDraft'] | undefined,
  storyCount: number,
  elements: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const resolved = resolveConcreteFrameLineLoadsByStory(engineeringDraft, storyCount);
  if (!resolved.length) return [];

  const loads: Array<Record<string, unknown>> = [];
  for (const item of resolved) {
    const storyId = `F${item.story}`;
    const axis = lineLoadTargetAxis(item.load.target);
    for (const element of elements) {
      if (element.type !== 'beam' || element.story !== storyId) continue;
      const id = String(element.id ?? '');
      if (axis === 'x' && !id.startsWith('BX')) continue;
      if (axis === 'y' && !id.startsWith('BY')) continue;
      loads.push({
        type: 'distributed',
        element: element.id,
        wz: (item.load.direction === 'globalZ' ? item.load.magnitude : -item.load.magnitude),
        story: storyId,
        source: 'engineering_draft_line_loads',
      });
    }
  }
  return loads;
}

export function buildConcreteLoadCaseBundle(
  deadLoads: Array<Record<string, unknown>>,
  liveLoads: Array<Record<string, unknown>>,
  lineLoads: Array<Record<string, unknown>>,
  lateralLoads: Array<Record<string, unknown>>,
  options: { includeWind?: boolean; includeSeismic?: boolean; frameDimension?: '2d' | '3d'; loadCombinations?: NonNullable<EngineeringDraft['analysis']>['loadCombinations']; nodalLoads?: Array<{ record: Record<string, unknown>; caseId?: string; caseType?: string }> } = {},
): { load_cases: Array<Record<string, unknown>>; load_combinations: Array<Record<string, unknown>> } {
  const loadCases: Array<Record<string, unknown>> = [];

  if (deadLoads.length) {
    loadCases.push({ id: 'D', type: 'dead', loads: deadLoads, description: 'Equivalent nodal dead loads from stories.floor_loads' });
  }
  if (liveLoads.length) {
    loadCases.push({ id: 'L', type: 'live', loads: liveLoads, description: 'Equivalent nodal live loads from stories.floor_loads' });
  }
  if (lineLoads.length) {
    loadCases.push({ id: 'LINE', type: 'other', loads: lineLoads, description: 'Concrete frame beam line loads' });
  }
  if (lateralLoads.length) {
    loadCases.push({ id: 'LAT', type: 'other', loads: lateralLoads, description: 'Lateral story loads' });
  }
  if (options.includeWind) {
    loadCases.push({ id: 'WX', type: 'wind', loads: [], description: 'X-direction wind load generated by commercial engine parameters' });
    if (options.frameDimension === '3d') {
      loadCases.push({ id: 'WY', type: 'wind', loads: [], description: 'Y-direction wind load generated by commercial engine parameters' });
    }
  }
  if (options.includeSeismic) {
    loadCases.push({ id: 'EX', type: 'seismic', loads: [], description: 'X-direction seismic action generated by commercial engine parameters' });
    if (options.frameDimension === '3d') {
      loadCases.push({ id: 'EY', type: 'seismic', loads: [], description: 'Y-direction seismic action generated by commercial engine parameters' });
    }
  }
  for (const load of options.nodalLoads ?? []) {
    const id = load.caseId ?? 'LAT';
    const existing = loadCases.find(item => item.id === id);
    if (existing) (existing.loads as Array<Record<string, unknown>>).push(load.record);
    else loadCases.push({ id, type: load.caseType ?? 'other', loads: [load.record], description: 'Frame nodal loads / 框架节点荷载' });
  }
  if (!loadCases.length) {
    loadCases.push({ id: 'LC1', type: 'other', loads: [] });
  }

  return {
    load_cases: loadCases,
    load_combinations: (options.loadCombinations ?? []).map(combination => ({ ...structuredClone(combination) })),
  };
}
