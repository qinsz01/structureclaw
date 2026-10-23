import { hasFrameNodalLoadInput } from '../../../../skill-shared/modelling/frame-loads.js';
import { frameLineLoadTargets } from '../../../../skill-shared/modelling/frame-line-loads.js';
import { frameFloorCase } from '../../../../skill-shared/modelling/frame-floor-cases.js';
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

function buildConcreteBeamLineLoads(
  engineeringDraft: DraftState['engineeringDraft'] | undefined,
  storyCount: number,
  elements: Array<Record<string, unknown>>,
  dimension: '2d' | '3d',
): Array<Record<string, unknown>> {
  return (engineeringDraft?.loads ?? []).filter(isGravityLineLoad).flatMap(load =>
    frameLineLoadTargets(load, storyCount, elements, dimension).map(element => ({
      type: 'distributed', element: element.id,
      wz: load.direction === 'globalZ' ? load.magnitude : -load.magnitude,
      story: element.story, source: 'engineering_draft_line_loads',
      ...(load.caseId ? { caseId: load.caseId } : {}),
      ...(load.caseType ? { caseType: load.caseType } : {}),
    })));
}

export function build2dConcreteBeamLineLoads(engineeringDraft: DraftState['engineeringDraft'] | undefined,
  storyCount: number, elements: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return buildConcreteBeamLineLoads(engineeringDraft, storyCount, elements, '2d');
}

export function build3dConcreteBeamLineLoads(engineeringDraft: DraftState['engineeringDraft'] | undefined,
  storyCount: number, elements: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return buildConcreteBeamLineLoads(engineeringDraft, storyCount, elements, '3d');
}

export function buildConcreteLoadCaseBundle(
  deadLoads: Array<Record<string, unknown>>,
  liveLoads: Array<Record<string, unknown>>,
  lineLoads: Array<Record<string, unknown>>,
  lateralLoads: Array<Record<string, unknown>>,
  options: { includeWind?: boolean; includeSeismic?: boolean; frameDimension?: '2d' | '3d'; engineeringLoads?: EngineeringDraftLoad[]; loadCombinations?: NonNullable<EngineeringDraft['analysis']>['loadCombinations']; nodalLoads?: Array<{ record: Record<string, unknown>; caseId?: string; caseType?: string }> } = {},
): { load_cases: Array<Record<string, unknown>>; load_combinations: Array<Record<string, unknown>> } {
  const floorCases = {
    dead: frameFloorCase(options.engineeringLoads, 'dead'),
    live: frameFloorCase(options.engineeringLoads, 'live'),
    lateral: frameFloorCase(options.engineeringLoads, 'lateral'),
  };
  const loadCases: Array<Record<string, unknown>> = [];
  const addCase = (id: string, type: string, loads: Array<Record<string, unknown>>, description: string): void => {
    const existing = loadCases.find(item => item.id === id);
    if (existing) {
      if (existing.type !== type && existing.type !== 'other' && type !== 'other') {
        throw new Error('FRAME_CASE_TYPE_CONFLICT: one case ID has conflicting types / 同一工况 ID 的类别冲突。');
      }
      (existing.loads as Array<Record<string, unknown>>).push(...loads);
      if (existing.type === 'other') existing.type = type;
    } else loadCases.push({ id, type, loads: [...loads], description });
  };

  if (deadLoads.length) {
    const identity = floorCases.dead;
    addCase(identity.id, identity.type, deadLoads, 'Equivalent nodal dead loads from stories.floor_loads');
  }
  if (liveLoads.length) {
    const identity = floorCases.live;
    addCase(identity.id, identity.type, liveLoads, 'Equivalent nodal live loads from stories.floor_loads');
  }
  for (const { caseId, caseType, ...record } of lineLoads) {
    addCase(String(caseId ?? 'LINE'), String(caseType ?? 'other'), [record], 'Concrete frame beam line loads');
  }
  if (lateralLoads.length) {
    const identity = floorCases.lateral;
    addCase(identity.id, identity.type, lateralLoads, 'Lateral story loads');
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
    addCase(id, load.caseType ?? 'other', [load.record], 'Frame nodal loads / 框架节点荷载');
  }
  if (!loadCases.length) {
    loadCases.push({ id: 'LC1', type: 'other', loads: [] });
  }

  return {
    load_cases: loadCases,
    load_combinations: (options.loadCombinations ?? []).map(combination => ({ ...structuredClone(combination) })),
  };
}
