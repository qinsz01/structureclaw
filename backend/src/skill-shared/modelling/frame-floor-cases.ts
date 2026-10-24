import type { DraftExtraction, EngineeringDraftLoad, EngineeringDraftLoadCaseType } from '../../shared/types/agent.js';
import { isFrameFloorTarget } from './frame-loads.js';

export type FrameFloorChannel = 'dead' | 'live' | 'lateral';

/** A planar span does not define an out-of-plane loaded width. */
export function frameFloorAreaM2(state: Pick<DraftExtraction, 'frameDimension' | 'bayWidthsXM' | 'bayWidthsYM'>): number | undefined {
  if (state.frameDimension === '2d') return undefined;
  const { bayWidthsXM: x, bayWidthsYM: y } = state;
  if (!x?.length || !y?.length || [...x, ...y].some(value => !Number.isFinite(value) || value <= 0)) return undefined;
  const area = x.reduce((sum, value) => sum + value, 0) * y.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(area) && area > 0 ? area : undefined;
}

export function hasUnresolvedFrameFloorArea(state: Pick<DraftExtraction, 'frameDimension' | 'bayWidthsXM' | 'bayWidthsYM' | 'engineeringDraft'>): boolean {
  return frameFloorAreaM2(state) === undefined
    && Boolean(state.engineeringDraft?.loads?.some(load => load.unit === 'kN/m2' && isFrameFloorTotal(load)));
}

export function isFrameFloorTotal(load: EngineeringDraftLoad): boolean {
  return Number.isFinite(load.magnitude) && ['kN', 'kN/m2'].includes(load.unit)
    && load.kind !== 'line' && load.kind !== 'distributed' && !load.location?.nodeRole?.trim()
    && load.location?.xM === undefined
    && (isFrameFloorTarget(load) || !load.target && load.location?.story !== undefined);
}

/** Bind the existing aggregated floor channels to confirmed case identities.
 * Multiple cases in one channel cannot be represented by the legacy floor totals.
 * Reject that lossy projection instead of merging or guessing their identities.
 */
export function frameFloorCase(loads: EngineeringDraftLoad[] | undefined, channel: FrameFloorChannel): {
  id: string; type: EngineeringDraftLoadCaseType;
} {
  const defaultId = channel === 'dead' ? 'D' : channel === 'live' ? 'L' : 'LAT';
  const defaultType = channel === 'lateral' ? 'other' : channel;
  const candidates = (loads ?? []).filter(load => {
    if (!isFrameFloorTotal(load)) return false;
    if (load.location?.spanIndex !== undefined) {
      throw new Error('FRAME_FLOOR_CASE_UNSUPPORTED: floor totals cannot also select a member span / 楼层总荷载不能同时指定构件跨号，请明确受荷范围。');
    }
    const lateral = load.direction === 'globalX' || load.direction === 'globalY';
    if (lateral) return channel === 'lateral';
    if (load.direction !== undefined && load.direction !== 'gravity' && load.direction !== 'globalZ') return false;
    if (load.caseType !== undefined && load.caseType !== 'dead' && load.caseType !== 'live') {
      throw new Error('FRAME_FLOOR_CASE_UNSUPPORTED: gravity floor totals require dead/live case types / 重力楼层总荷载须声明恒载或活载工况，不能改写工况类别。');
    }
    return channel === (load.caseType === 'live' ? 'live' : 'dead');
  });
  const ids = new Set(candidates.map(load => load.caseId ?? defaultId));
  const types = new Set(candidates.map(load => load.caseType ?? defaultType));
  if (ids.size > 1 || types.size > 1) {
    throw new Error('FRAME_FLOOR_CASE_UNSUPPORTED: multiple cases share an aggregated floor channel; provide explicit member/node loads / 多个工况共用楼层汇总通道，无法无损编译；请提供逐工况构件或节点荷载。');
  }
  return { id: ids.values().next().value ?? defaultId, type: types.values().next().value ?? defaultType };
}
