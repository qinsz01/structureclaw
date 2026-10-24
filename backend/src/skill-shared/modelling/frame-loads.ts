import type { DraftState, EngineeringDraftLoad, EngineeringDraftLoadCaseType } from '../../shared/types/agent.js';
import type { ModelRecord } from '../../engineering/model-state.js';
import { modelSelectorSchema, selectRecords, selectNodeRole } from '../../engineering/model-selection.js';
export { isGlobalFrameNodeRole } from '../../engineering/model-selection.js';

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

const individual = (load: EngineeringDraftLoad) => ['nodal', 'point'].includes(load.kind) && load.unit === 'kN'
  && Number.isFinite(load.magnitude) && load.location?.xM === undefined;
export function hasFrameNodalLoadInput(state: Pick<DraftState, 'engineeringDraft'>): boolean {
  const nodeIds = new Set(state.engineeringDraft?.topology?.nodes?.map(node => node.id) ?? []);
  return !!state.engineeringDraft?.loads?.some(load => individual(load) && (load.selector || load.location?.nodeRole
    || load.target && (nodeIds.has(load.target) || /^N\d+_\d+(?:_\d+)?$/.test(load.target))));
}

/** Structured node-role vocabulary, not inference from user prose. Unknown targets fail explicitly. */
export function frameNodalLoads(loads: EngineeringDraftLoad[] | undefined, nodes: ModelRecord[]) {
  const result: Array<{ record: ModelRecord; caseId?: string; caseType?: EngineeringDraftLoadCaseType }> = [];
  const levels = [...new Set(nodes.map(node => Number(node.z)))].sort((a, b) => a - b);
  for (const load of loads ?? []) {
    if (!individual(load)) continue;
    if (!load.selector && !load.location?.nodeRole && !nodes.some(node => node.id === load.target)
      && !/^N\d+_\d+(?:_\d+)?$/.test(load.target ?? '')) {
      if (!isFrameFloorTarget(load)
        || resolveFrameLoadStory(load, levels.length - 1) === undefined && !isAllFrameStoriesTarget(load.target)) {
        throw new Error(`FRAME_NODAL_TARGET_UNRESOLVED: ${JSON.stringify(load)} / Nodal target is unresolved; do not discard this load / 节点荷载目标未解析，不得丢弃后计算`);
      }
      continue;
    }
    let targets = load.selector ? selectRecords(nodes, modelSelectorSchema.parse(load.selector)) : nodes.filter(node => node.id === load.target);
    if (load.selector && load.location?.story !== undefined) targets = targets.filter(node => Number(node.z) === levels[load.location!.story!]);
    const role = load.location?.nodeRole?.trim().toLowerCase();
    if (!targets.length && role) {
      targets = selectNodeRole(nodes, role, load.location?.story);
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
