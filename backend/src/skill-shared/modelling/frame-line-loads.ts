import type { EngineeringDraftLoad } from '../../shared/types/agent.js';
import { isAllFrameStoriesTarget, isFrameFloorTarget, resolveFrameLoadStory } from './frame-loads.js';

const BEAM_SELECTORS = new Set(['beam', 'beams', 'all-beams', 'x-beams', 'y-beams']);
const invalidTarget = (): never => {
  throw new Error('FRAME_LINE_TARGET_UNRESOLVED: specify an exact beam ID, a valid story/span, or an explicit canonical beam selector; no load was spread or discarded. / 请指定准确梁编号、有效楼层/跨号或明确的标准梁选择器；未扩散或丢弃荷载。');
};

/** Resolve typed template selectors only; arbitrary target descriptions never select members. */
export function frameLineLoadTargets(
  load: EngineeringDraftLoad,
  storyCount: number,
  elements: Array<Record<string, unknown>>,
  dimension: '2d' | '3d',
): Array<Record<string, unknown>> {
  if (!Number.isInteger(storyCount) || storyCount < 1 || load.location?.nodeRole !== undefined) return invalidTarget();
  const target = load.target?.trim();
  const selector = target?.toLowerCase();
  const exact = target ? elements.find(element => element.id === target) : undefined;
  const story = resolveFrameLoadStory(load, storyCount);
  const span = load.location?.spanIndex;
  if (span !== undefined && (!Number.isInteger(span) || span < 1 || dimension === '3d')) return invalidTarget();
  if (exact) {
    if (exact.type !== 'beam' || story !== undefined && exact.story !== `F${story}`) return invalidTarget();
    if (span !== undefined && elements.filter(element => element.type === 'beam' && element.story === exact.story)[span - 1] !== exact) return invalidTarget();
    return [exact];
  }
  if (selector && !BEAM_SELECTORS.has(selector) && !isFrameFloorTarget(load)) return invalidTarget();
  const allStories = selector === 'all-beams' || isAllFrameStoriesTarget(load.target);
  if (story === undefined && !allStories) return invalidTarget();
  if (dimension === '2d' && selector === 'y-beams') return invalidTarget();
  const stories = story === undefined ? Array.from({ length: storyCount }, (_, i) => i + 1) : [story];
  const targets = stories.flatMap(index => {
    const beams = elements.filter(element => element.type === 'beam' && element.story === `F${index}`);
    if (!beams.length) return invalidTarget();
    if (span !== undefined) return beams[span - 1] ? [beams[span - 1]!] : invalidTarget();
    if (dimension === '3d' && (selector === 'x-beams' || selector === 'y-beams')) {
      const selected = beams.filter(element => String(element.id).startsWith(selector === 'x-beams' ? 'BX' : 'BY'));
      return selected.length ? selected : invalidTarget();
    }
    return beams;
  });
  return targets.length ? targets : invalidTarget();
}
