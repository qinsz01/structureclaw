import type { DraftState, EngineeringDraftLoad, EngineeringDraftLoadCaseType } from '../../shared/types/agent.js';
import type { ModelRecord } from '../../engineering/model-state.js';

const TOP_STORY_TARGETS = new Set(['roof', 'top-story', 'top-floor', '屋面', '屋顶', '楼顶', '顶层', '顶楼']);
const ALL_STORY_TARGETS = new Set(['all-stories', 'all-floors']);
const FLOOR_ROLES = new Set(['floor', 'story', 'level']);
const FLOOR_ID = /^(?:floor|story|level)[ -]([1-9]\d*)$/;
export function isFrameFloorTarget(load: EngineeringDraftLoad): boolean {
  const target = load.target?.trim().toLowerCase();
  return !!target && (FLOOR_ROLES.has(target) || TOP_STORY_TARGETS.has(target) || ALL_STORY_TARGETS.has(target) || FLOOR_ID.test(target));
}

export function resolveFrameLoadStory(load: EngineeringDraftLoad, storyCount: number): number | undefined {
  const locationStory = load.location?.story;
  if (locationStory !== undefined) {
    if (!Number.isInteger(locationStory) || locationStory < 1 || locationStory > storyCount) {
      throw new Error('MODEL_EDIT_FIELD_INVALID: loads.location.story: valid story index required / 荷载楼层序号超出范围。');
    }
    return locationStory;
  }
  const target = load.target?.trim().toLowerCase();
  if (!target) return undefined;
  if (TOP_STORY_TARGETS.has(target)) return storyCount;
  const match = FLOOR_ID.exec(target);
  const story = match ? Number(match[1]) : undefined;
  return story !== undefined && story <= storyCount ? story : undefined;
}

export const isAllFrameStoriesTarget = (target: string | undefined): boolean => ALL_STORY_TARGETS.has(target?.trim().toLowerCase() ?? '');

export const isGlobalFrameNodeRole = (value: unknown): boolean => value === 'all-non-base-nodes' || value === 'all-top-nodes';
const individual = (load: EngineeringDraftLoad) => ['nodal', 'point'].includes(load.kind) && load.unit === 'kN'
  && Number.isFinite(load.magnitude) && load.location?.xM === undefined;
export function hasFrameNodalLoadInput(state: Pick<DraftState, 'engineeringDraft'>): boolean {
  const nodeIds = new Set(state.engineeringDraft?.topology?.nodes?.map(node => node.id) ?? []);
  return !!state.engineeringDraft?.loads?.some(load => individual(load) && (load.location?.nodeRole
    || load.target && (nodeIds.has(load.target) || /^N\d+_\d+(?:_\d+)?$/.test(load.target))));
}

/** Structured node-role vocabulary, not inference from user prose. Unknown targets fail explicitly. */
export function frameNodalLoads(loads: EngineeringDraftLoad[] | undefined, nodes: ModelRecord[]) {
  const result: Array<{ record: ModelRecord; caseId?: string; caseType?: EngineeringDraftLoadCaseType }> = [];
  const levels = [...new Set(nodes.map(node => Number(node.z)))].sort((a, b) => a - b);
  for (const load of loads ?? []) {
    if (!individual(load)) continue;
    if (!load.location?.nodeRole && !nodes.some(node => node.id === load.target)
      && !/^N\d+_\d+(?:_\d+)?$/.test(load.target ?? '')) {
      if (!isFrameFloorTarget(load)
        || resolveFrameLoadStory(load, levels.length - 1) === undefined && !isAllFrameStoriesTarget(load.target)) {
        throw new Error(`FRAME_NODAL_TARGET_UNRESOLVED: ${JSON.stringify(load)} / Nodal target is unresolved; do not discard this load / 节点荷载目标未解析，不得丢弃后计算`);
      }
      continue;
    }
    let targets = nodes.filter(node => node.id === load.target);
    const role = load.location?.nodeRole?.trim().toLowerCase();
    if (!targets.length && role) {
      const story = load.location?.story;
      const level = story !== undefined ? levels[story] : undefined;
      const pool = role === 'all-non-base-nodes' ? nodes.filter(node => Number(node.z) > levels[0]!)
        : role === 'all-top-nodes' ? nodes.filter(node => Number(node.z) === levels[levels.length - 1])
          : level === undefined ? [] : nodes.filter(node => Number(node.z) === level);
      const xs = [...new Set(pool.map(node => Number(node.x)))].sort((a, b) => a - b);
      const ys = [...new Set(pool.map(node => Number(node.y)))].sort((a, b) => a - b);
      if (role === 'all' || isGlobalFrameNodeRole(role)) targets = pool;
      else {
        const grid = role.match(/^(?:corner-|node-)?x(\d+)y(\d+)$/);
        let xIndex: number | undefined, yIndex: number | undefined;
        if (grid) { xIndex = Number(grid[1]); yIndex = Number(grid[2]); }
        else if (ys.length === 1) {
          yIndex = 0;
          if (['right', 'right-side', 'right-end', 'end', '右侧', '右端'].includes(role)) xIndex = xs.length - 1;
          else if (['left', 'left-side', 'left-end', 'start', '左侧', '左端'].includes(role)) xIndex = 0;
          else if (['middle', 'center', 'centre', 'middle-node', 'center-node', '中间', '中央'].includes(role)) xIndex = Math.floor((xs.length - 1) / 2);
        }
        targets = pool.filter(node => Number(node.x) === xs[xIndex ?? -1] && Number(node.y) === ys[yIndex ?? -1]);
      }
    }
    // Floor-total records are handled by the existing floor-load path.
    if (!targets.length && !role && isFrameFloorTarget(load)) continue;
    if (!targets.length) throw new Error(`FRAME_NODAL_TARGET_UNRESOLVED: ${JSON.stringify(load)} / 请明确该节点荷载的目标，不得丢弃后计算`);
    const component = load.direction === 'globalX' ? 'fx' : load.direction === 'globalY' ? 'fy' : 'fz';
    const magnitude = load.direction === 'gravity' || !load.direction ? -load.magnitude : load.magnitude;
    for (const node of targets) result.push({ record: { type: 'nodal', node: node.id, ...(node.story ? { story: node.story } : {}),
      source: 'engineering_draft_nodal_loads', [component]: magnitude }, caseId: load.caseId, caseType: load.caseType });
  }
  return result;
}
