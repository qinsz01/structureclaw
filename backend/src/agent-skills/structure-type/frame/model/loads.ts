import { hasFrameNodalLoadInput } from '../../../../skill-shared/modelling/frame-loads.js';
import { frameLineLoadTargets } from '../../../../skill-shared/modelling/frame-line-loads.js';
/** Frame floor, line and nodal load projection into load cases. */
import type { DraftFloorLoad, EngineeringDraftLoad, DraftState, EngineeringDraftLoadCaseType, EngineeringDraftLoadCombination } from '../../../../shared/types/agent.js';
import { isFrameMemberPointLoad, hasIncompleteFramePointLoadLocation } from '../../../../agent-runtime/draft/project-patch.js';

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

export function hasFrameAnalysisLoadInput(state: Pick<DraftState, 'floorLoads' | 'engineeringDraft' | 'wind' | 'frameDimension'>): boolean {
  if (hasFloorLoadValue(state.floorLoads) || hasFrameNodalLoadInput(state)) return true;
  if (typeof state.wind?.basicPressureKNM2 === 'number' && Number.isFinite(state.wind.basicPressureKNM2) && state.wind.basicPressureKNM2 > 0) {
    return true;
  }
  return Boolean(state.engineeringDraft?.loads?.some((load) => (
    Number.isFinite(load.magnitude)
    && Number.isFinite(load.magnitude)
    && (isGravityLineLoad(load)
      || (isFrameMemberPointLoad(load) && !hasIncompleteFramePointLoadLocation(load)))
  )));
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

export function buildFrameMemberPointLoads(
  state: DraftState,
  elements: Array<Record<string, unknown>>,
  nodes: Array<Record<string, unknown>>,
): FrameNamedLoad[] {
  return (state.engineeringDraft?.loads ?? []).filter(isFrameMemberPointLoad).map((load) => {
    const target = load.target?.trim();
    let element = target ? elements.find((item) => item.id === target) : undefined;
    if (!element && !target && state.frameDimension !== '3d') {
      const beams = elements.filter((item) => item.type === 'beam' && item.story === `F${load.location?.story}`);
      const span = load.location?.spanIndex;
      if (span !== undefined && Number.isInteger(span) && span >= 1) element = beams[span - 1];
    }
    const endpoints = (element?.nodes as string[] | undefined)?.map((id) => nodes.find((node) => node.id === id));
    const length = endpoints?.length === 2 && endpoints.every(Boolean)
      ? Math.hypot(...['x', 'y', 'z'].map((axis) => Number(endpoints[1]![axis]) - Number(endpoints[0]![axis])))
      : NaN;
    const position = load.location!.xM!;
    if (!element || !Number.isFinite(length) || !Number.isFinite(position) || position < 0 || position > length) {
      throw new Error('INVALID_MEMBER_LOAD_LOCATION: identify a member and a position within its length / 请指定构件及其长度范围内的荷载位置');
    }
    const component = load.direction === 'globalX' ? 'fx' : load.direction === 'globalY' ? 'fy' : 'fz';
    return {
      record: { type: 'point', element: element.id, position, reference_frame: 'global',
        [component]: load.direction === 'gravity' || load.direction === undefined ? -load.magnitude : load.magnitude },
      caseId: load.caseId,
      caseType: load.caseType,
    };
  });
}

function buildBeamLineLoads(state: DraftState, storyCount: number,
  elements: Array<Record<string, unknown>>, dimension: '2d' | '3d'): FrameNamedLoad[] {
  return (state.engineeringDraft?.loads ?? []).filter(isGravityLineLoad).flatMap(load =>
    frameLineLoadTargets(load, storyCount, elements, dimension).map(element => ({
      record: { type: 'distributed', element: element.id,
        wz: load.direction === 'globalZ' ? load.magnitude : -load.magnitude,
        story: element.story, source: 'engineering_draft_line_loads' },
      caseId: load.caseId, caseType: load.caseType,
    })));
}

export function build2dBeamLineLoads(state: DraftState, storyCount: number,
  elements: Array<Record<string, unknown>>): FrameNamedLoad[] {
  return buildBeamLineLoads(state, storyCount, elements, '2d');
}

export function build3dBeamLineLoads(state: DraftState, storyCount: number,
  elements: Array<Record<string, unknown>>): FrameNamedLoad[] {
  return buildBeamLineLoads(state, storyCount, elements, '3d');
}
