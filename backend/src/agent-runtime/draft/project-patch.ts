import { normalizeFrameBoundary } from './legacy-fields.js';
import { isGlobalFrameNodeRole, isFrameFloorTarget, resolveFrameLoadStory, isAllFrameStoriesTarget } from '../../skill-shared/modelling/frame-loads.js';
/**
 * Draft -> flat projection (outbound half of the draft boundary, re-exported by `boundary.ts`).
 *
 * Projects a canonical `engineeringDraft` patch onto the historical flat `DraftState` fields and
 * per-skill `skillState` views that prompts, responses, checkpoints and skill builders consume.
 * Explicit flat values already present on the patch take precedence over projected ones.
 */
import type {
  DraftExtraction,
  DraftFloorLoad,
  DraftLoadPosition,
  DraftLoadType,
  DraftWindParams,
  EngineeringDraftLoad,
  FrameDimension,
  InferredModelType,
} from '../../shared/types/agent.js';
import { isLineLoad, isPointLikeLoad, mergeFloorLoadsByStory, positiveNumber } from './normalize.js';

function legacyLoadType(load: EngineeringDraftLoad): DraftLoadType {
  return isLineLoad(load) ? 'distributed' : 'point';
}

function legacyLoadPosition(load: EngineeringDraftLoad): DraftLoadPosition | undefined {
  if (isLineLoad(load)) return 'full-span';
  const role = (load.location?.nodeRole ?? load.target)?.trim().toLowerCase();
  if (role && ['top', 'top-node', 'top-nodes', 'all-top-nodes'].includes(role)) return 'top-nodes';
  if (load.location?.xM !== undefined) return 'free-joint';
  if (role === 'midspan') return 'midspan';
  if (role && ['end', 'free-end', 'right-end'].includes(role)) return 'end';
  if (role === 'start' || role === 'left-end') return 'free-joint';
  return undefined;
}

// Exact structured target names, never substrings of prose.
const PORTAL_TARGETS: Record<string, 'roof' | 'mezzanine' | 'crane'> = {
  roof: 'roof', 'all-roof-beams': 'roof', mezzanine: 'mezzanine', crane: 'crane',
};
function portalTarget(load: EngineeringDraftLoad, exactIds: Set<string>): 'roof' | 'mezzanine' | 'crane' | undefined {
  const target = load.target?.trim().toLowerCase();
  const role = load.location?.nodeRole?.trim().toLowerCase();
  // Explicit nodes and members stay in canonical loads for the model builder; a legacy
  // roof scalar cannot represent them without discarding their selected location.
  if (load.target && (exactIds.has(load.target) || /^(?:[BTR]\d+|C\d+[ab]?|M[01]|MEZ1)$/.test(load.target))) return undefined;
  if (isPointLikeLoad(load) && role && ['left-column-top', 'middle-column-top', 'right-column-top', 'column-top', 'top-nodes'].includes(role)) return undefined;
  if (isPointLikeLoad(load) && target === 'top-nodes') return undefined;
  if (isLineLoad(load) && !target && load.location?.spanIndex !== undefined) return undefined;
  const selected = target && Object.hasOwn(PORTAL_TARGETS, target) ? PORTAL_TARGETS[target]
    : !target && role && Object.hasOwn(PORTAL_TARGETS, role) ? PORTAL_TARGETS[role] : undefined;
  if (!selected) throw new Error('MODEL_EDIT_FIELD_INVALID: loads.target: specify roof, mezzanine or crane explicitly / 请明确门式刚架荷载的结构化目标，不得按文字或默认值推断。');
  return selected;
}

function modelLoadDirection(load: EngineeringDraftLoad): 'fx' | 'fy' | 'fz' {
  if (load.direction === 'globalX') return 'fx';
  if (load.direction === 'globalY') return 'fy';
  return 'fz';
}

function signedNodalComponent(load: EngineeringDraftLoad): Record<string, number> {
  const component = modelLoadDirection(load);
  const sign = component === 'fz' && load.direction !== 'globalZ' ? -1 : 1;
  return { [`${component}KN`]: sign * load.magnitude };
}

function firstLoad(loads: EngineeringDraftLoad[] | undefined): EngineeringDraftLoad | undefined {
  return loads?.find((load) => isLineLoad(load)) ?? loads?.find((load) => isPointLikeLoad(load));
}

function sumPositive(values: number[] | undefined): number | undefined {
  if (!values?.length) return undefined;
  const total = values.reduce((acc, value) => acc + value, 0);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

function framePlanAreaM2(patch: DraftExtraction): number | undefined {
  const totalSpanX = sumPositive(patch.bayWidthsXM);
  const totalSpanY = sumPositive(patch.bayWidthsYM);
  if (totalSpanX !== undefined && totalSpanY !== undefined) {
    return totalSpanX * totalSpanY;
  }
  const totalSpan2d = sumPositive(patch.bayWidthsM) ?? totalSpanX;
  return totalSpan2d !== undefined ? totalSpan2d * totalSpan2d : undefined;
}

function frameLoadTotalKN(load: EngineeringDraftLoad, patch: DraftExtraction): number | undefined {
  if (load.unit === 'kN') return load.magnitude;
  if (load.unit === 'kN/m') {
    return undefined;
  }
  if (load.unit === 'kN/m2') {
    const areaM2 = framePlanAreaM2(patch);
    return areaM2 !== undefined ? load.magnitude * areaM2 : undefined;
  }
  return undefined;
}

export function isLocalizedFramePointLoad(load: EngineeringDraftLoad): boolean {
  if (!isPointLikeLoad(load)) return false;
  return isGlobalFrameNodeRole(load.location?.nodeRole) || load.location?.story !== undefined && Boolean(load.location.nodeRole?.trim());
}

/** Member positions are distinct from joint locations; never spread them over a floor. */
export function isFrameMemberPointLoad(load: EngineeringDraftLoad): boolean {
  return load.kind === 'point' && load.location?.xM !== undefined;
}

export function hasIncompleteFramePointLoadLocation(load: EngineeringDraftLoad): boolean {
  if (!isPointLikeLoad(load)) return false;
  if (isGlobalFrameNodeRole(load.location?.nodeRole)) return false;
  if (isFrameMemberPointLoad(load)) {
    return !load.target?.trim()
      && !(load.location?.story !== undefined && load.location.spanIndex !== undefined);
  }
  const hasStory = load.location?.story !== undefined;
  const hasNodeRole = Boolean(load.location?.nodeRole?.trim());
  if (!hasNodeRole && isFrameFloorTarget(load)) return false;
  return hasStory !== hasNodeRole;
}

function hasFloorLoadValues(floorLoads: DraftFloorLoad[] | undefined): boolean {
  return Boolean(floorLoads?.some((load) => (
    load.verticalKN !== undefined
    || load.liveLoadKN !== undefined
    || load.lateralXKN !== undefined
    || load.lateralYKN !== undefined
  )));
}

export function mergeFrameFloorLoadValues(
  current: DraftFloorLoad[] | undefined,
  incoming: DraftFloorLoad[] | undefined,
): DraftFloorLoad[] | undefined {
  // One side empty: returned as-is (unsorted), unlike the state-merge variants.
  if (!current?.length) return incoming;
  if (!incoming?.length) return current;
  return mergeFloorLoadsByStory(current, incoming);
}

function storyHeightsForWind(patch: DraftExtraction): number[] | undefined {
  const explicit = patch.storyHeightsM?.filter((height) => Number.isFinite(height) && height > 0);
  if (explicit?.length) return explicit;
  const storyCount = patch.storyCount;
  if (!storyCount || !patch.heightM || patch.heightM <= 0) return undefined;
  return Array.from({ length: storyCount }, () => patch.heightM! / storyCount);
}

export function projectWindPressureToFloorLoads(
  wind: DraftWindParams | undefined,
  patch: DraftExtraction,
): DraftFloorLoad[] | undefined {
  const pressure = positiveNumber(wind?.basicPressureKNM2);
  if (pressure === undefined) return undefined;
  const storyHeights = storyHeightsForWind(patch);
  if (!storyHeights?.length) return undefined;
  const exposedWidthM = sumPositive(patch.bayWidthsYM)
    ?? sumPositive(patch.bayWidthsM)
    ?? sumPositive(patch.bayWidthsXM);
  if (exposedWidthM === undefined) return undefined;
  const factor = (wind?.shapeFactor ?? 1) * (wind?.heightVariationFactor ?? 1);
  return storyHeights.map((height, index) => ({
    story: index + 1,
    lateralXKN: Number((pressure * factor * exposedWidthM * height).toFixed(6)),
  }));
}

function assignFloorLoadValue(
  floorLoadsByStory: Map<number, DraftFloorLoad>,
  story: number,
  field: 'verticalKN' | 'lateralXKN' | 'lateralYKN',
  value: number,
): void {
  const current = floorLoadsByStory.get(story) ?? { story };
  const previous = current[field] ?? 0;
  floorLoadsByStory.set(story, {
    ...current,
    [field]: previous + value,
  });
}

function frameFloorLoadField(load: EngineeringDraftLoad): 'verticalKN' | 'lateralXKN' | 'lateralYKN' {
  if (load.direction === 'globalX') return 'lateralXKN';
  if (load.direction === 'globalY') return 'lateralYKN';
  return 'verticalKN';
}

type ConvertibleFrameLoad = {
  load: EngineeringDraftLoad;
  totalKN: number;
};

function projectFrameFloorLoads(loads: EngineeringDraftLoad[], patch: DraftExtraction): DraftFloorLoad[] | undefined {
  const storyCount = patch.storyCount ?? patch.storyHeightsM?.length;
  if (!storyCount) return undefined;

  const floorLoadsByStory = new Map<number, DraftFloorLoad>();
  const nodeIds = new Set(patch.engineeringDraft?.topology?.nodes?.map(node => node.id) ?? []);
  const convertibleLoads: ConvertibleFrameLoad[] = loads
    .map(load => ({ load, totalKN: frameLoadTotalKN(load, patch) }))
    .filter((item): item is ConvertibleFrameLoad => (
      item.totalKN !== undefined
      && Number.isFinite(item.totalKN)
      && !isLocalizedFramePointLoad(item.load)
      && !(item.load.target && (nodeIds.has(item.load.target) || /^N\d+_\d+(?:_\d+)?$/.test(item.load.target)))
        && !isFrameMemberPointLoad(item.load)
      && !hasIncompleteFramePointLoadLocation(item.load)
    ));

  const comparableLoads: ConvertibleFrameLoad[] = convertibleLoads.filter((item) => (
    item.load.direction === 'gravity'
    || item.load.direction === 'globalZ'
    || item.load.direction === 'globalX'
    || item.load.direction === 'globalY'
    || item.load.direction === undefined
  ));

  for (const { load, totalKN } of comparableLoads) {
    const field = frameFloorLoadField(load);
    let stories: number[];
    const explicitStory = resolveFrameLoadStory(load, storyCount);
    if (explicitStory !== undefined) {
      stories = [explicitStory];
    } else if (isAllFrameStoriesTarget(load.target)) {
      stories = Array.from({ length: storyCount }, (_, storyIndex) => storyIndex + 1);
    } else throw new Error('MODEL_EDIT_FIELD_INVALID: loads.location.story: specify a story or an explicit all-stories target / 缺少荷载楼层选择器；不得按文字、数组顺序或默认全楼分配。');

    for (const story of stories) {
      assignFloorLoadValue(floorLoadsByStory, story, field, Number((load.direction === 'globalZ' ? -totalKN : totalKN).toFixed(6)));
    }
  }

  return floorLoadsByStory.size
    ? Array.from(floorLoadsByStory.values()).sort((left, right) => left.story - right.story)
    : undefined;
}

function sectionDimensionsM(section: string | undefined): { sectionWidthM?: number; sectionDepthM?: number } {
  if (!section) return {};
  const match = section.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*[xX×*]\s*([0-9]+(?:\.[0-9]+)?)\s*(mm|m)?$/u);
  if (!match?.[1] || !match[2]) return {};
  const width = Number(match[1]);
  const depth = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(depth) || width <= 0 || depth <= 0) return {};
  const scale = match[3] === 'm' ? 1 : 1000;
  return {
    sectionWidthM: width / scale,
    sectionDepthM: depth / scale,
  };
}

/** Legacy `skillState.beamLoads` view of canonical loads. */
export function projectBeamLoads(loads: EngineeringDraftLoad[]): Array<Record<string, unknown>> {
  return loads.map((load) => ({
    kind: isLineLoad(load) ? 'distributed' : 'point',
    magnitude: load.magnitude,
    unit: load.unit,
    direction: load.direction,
    target: load.target,
    xM: load.location?.xM,
    spanIndex: load.location?.spanIndex,
  }));
}

/**
 * Project a patch's canonical draft onto flat fields and skill views. The patch-level
 * `skillState.engineeringDraft` written here is the origin of the persisted legacy mirror;
 * `projectDraftState` keeps it equal to the merged canonical draft afterwards.
 */
export function projectDraftPatch(
  patch: DraftExtraction,
  inferredType: InferredModelType,
): DraftExtraction {
  const engineeringDraft = normalizeFrameBoundary(patch.engineeringDraft, inferredType) as typeof patch.engineeringDraft;
  if (!engineeringDraft) return patch;

  const loads = engineeringDraft.loads ?? [];
  const primaryLoad = firstLoad(loads);
  const spanLengths = engineeringDraft.geometry?.spanLengthsM;
  const skillState: Record<string, unknown> = {
    ...(patch.skillState ?? {}),
    engineeringDraft,
    extractionSource: 'engineering-draft',
  };
  const next: DraftExtraction = {
    ...patch,
    inferredType,
    engineeringDraft,
    skillState,
  };

  const dimension = engineeringDraft.coordinateSystem?.dimension;
  if (dimension !== undefined) {
    if (!['2d', '3d'].includes(String(dimension)) || next.frameDimension && next.frameDimension !== dimension) {
      throw new Error('COORDINATE_DIMENSION_CONFLICT: coordinateSystem.dimension / 分析维度无效或与旧字段冲突');
    }
    next.frameDimension = dimension as FrameDimension;
  }

  if (engineeringDraft.geometry?.lengthM !== undefined) next.lengthM = next.lengthM ?? engineeringDraft.geometry.lengthM;
  if (engineeringDraft.geometry?.heightM !== undefined) next.heightM = next.heightM ?? engineeringDraft.geometry.heightM;
  if (engineeringDraft.boundary?.supportType !== undefined) next.supportType = next.supportType ?? engineeringDraft.boundary.supportType;
  if (engineeringDraft.boundary?.frameBaseSupportType !== undefined) {
    next.frameBaseSupportType = next.frameBaseSupportType ?? engineeringDraft.boundary.frameBaseSupportType;
  }
  if (primaryLoad && inferredType !== 'frame' && inferredType !== 'portal-frame') {
    next.loadKN = next.loadKN ?? primaryLoad.magnitude;
    next.loadType = next.loadType ?? legacyLoadType(primaryLoad);
    next.loadPosition = next.loadPosition ?? legacyLoadPosition(primaryLoad);
    if (primaryLoad.location?.xM !== undefined) {
      next.loadPositionM = next.loadPositionM ?? primaryLoad.location.xM;
    }
  }

  if (inferredType === 'beam') {
    if (next.lengthM === undefined && spanLengths?.length) {
      next.lengthM = spanLengths.reduce((total, span) => total + span, 0);
    }
    skillState.beamLoads = projectBeamLoads(loads);
    const missingLocations = loads.filter(load => isPointLikeLoad(load) && !isLineLoad(load)
      && load.location?.xM === undefined
      && !['start', 'left-end', 'end', 'free-end', 'right-end', 'midspan'].includes(load.location?.nodeRole ?? '')
      && ['', 'beam', 'member'].includes(load.target ?? ''));
    if (missingLocations.length) {
      next.draftIssues = [...(next.draftIssues ?? []), ...missingLocations.map(load => ({
        field: `loads[${load.id ? JSON.stringify(load.id) : loads.indexOf(load)}].location.xM`,
        kind: 'missing' as const, severity: 'ambiguous' as const,
        reason: 'The point load has no explicit location; do not use an earlier load position or assume midspan. / 点荷载缺少明确位置，不得沿用旧位置或默认跨中。',
        question: 'Where is this point load applied (xM or a canonical nodeRole)? / 该点荷载施加在何处（xM或明确节点位置）？',
      }))];
    }
  }

  if (inferredType === 'truss') {
    if (next.lengthM === undefined && spanLengths?.length) {
      next.lengthM = spanLengths.reduce((total, span) => total + span, 0);
    }
    if (engineeringDraft.geometry?.heightM !== undefined) {
      next.heightM = next.heightM ?? engineeringDraft.geometry.heightM;
    }
    if (next.bayCount === undefined && spanLengths?.length) {
      next.bayCount = spanLengths.length;
    }
  }

  if (inferredType === 'frame') {
    const geometry = engineeringDraft.geometry;
    if (geometry?.storyHeightsM?.length) {
      next.storyHeightsM = next.storyHeightsM ?? geometry.storyHeightsM;
      next.storyCount = next.storyCount ?? geometry.storyHeightsM.length;
    }
    if (geometry?.bayWidthsM?.length) {
      next.bayWidthsM = next.bayWidthsM ?? geometry.bayWidthsM;
      next.bayCount = next.bayCount ?? geometry.bayWidthsM.length;
      next.frameDimension = next.frameDimension ?? '2d';
    }
    if (geometry?.bayWidthsXM?.length && geometry?.bayWidthsYM?.length) {
      next.bayWidthsXM = next.bayWidthsXM ?? geometry.bayWidthsXM;
      next.bayCountX = next.bayCountX ?? geometry.bayWidthsXM.length;
      next.frameDimension = next.frameDimension ?? '3d';
    } else if (geometry?.bayWidthsXM?.length && !next.bayWidthsM?.length) {
      next.bayWidthsM = geometry.bayWidthsXM;
      next.bayCount = next.bayCount ?? geometry.bayWidthsXM.length;
      next.frameDimension = next.frameDimension ?? '2d';
    }
    if (geometry?.bayWidthsYM?.length) {
      next.bayWidthsYM = next.bayWidthsYM ?? geometry.bayWidthsYM;
      next.bayCountY = next.bayCountY ?? geometry.bayWidthsYM.length;
      next.frameDimension = next.frameDimension ?? '3d';
    }
    if (!next.bayWidthsM?.length && spanLengths?.length) {
      next.bayWidthsM = spanLengths;
      next.bayCount = spanLengths.length;
      next.frameDimension = next.frameDimension ?? '2d';
    }
    if (engineeringDraft.material?.family === 'concrete' && engineeringDraft.material.grade) {
      next.frameConcreteGrade = engineeringDraft.material.grade;
    } else if (engineeringDraft.material?.grade) {
      next.frameMaterial = engineeringDraft.material.grade;
    }
    if (engineeringDraft.material?.rebarGrade) {
      next.frameRebarGrade = engineeringDraft.material.rebarGrade;
    }
    if (engineeringDraft.sections?.column) {
      next.frameColumnSection = engineeringDraft.sections.column;
    }
    if (engineeringDraft.sections?.beam) {
      next.frameBeamSection = engineeringDraft.sections.beam;
    }
    next.wind = next.wind ?? engineeringDraft.wind;
    const projectedFloorLoads = mergeFrameFloorLoadValues(
      projectFrameFloorLoads(loads, next),
      projectWindPressureToFloorLoads(next.wind, next),
    );
    if (projectedFloorLoads?.length) {
      next.floorLoads = hasFloorLoadValues(next.floorLoads)
        ? mergeFrameFloorLoadValues(next.floorLoads, projectedFloorLoads)
        : projectedFloorLoads;
    }
  }

  if (inferredType === 'column') {
    const section = engineeringDraft.sections?.column ?? engineeringDraft.sections?.member;
    Object.assign(skillState, sectionDimensionsM(section));
    if (engineeringDraft.material?.family === 'steel' || engineeringDraft.material?.family === 'concrete') {
      skillState.materialFamily = engineeringDraft.material.family;
    }
    const columnLoads = loads
      .filter((load) => isPointLikeLoad(load))
      .flatMap(load => {
        const target = load.location?.nodeRole ?? load.target;
        if (!target) {
          next.draftIssues = [...(next.draftIssues ?? []), {
            field: `loads[${load.id ? JSON.stringify(load.id) : loads.indexOf(load)}].target`,
            kind: 'missing', severity: 'ambiguous',
            reason: 'The column load has no explicit target; its location cannot be assumed. / 柱荷载缺少明确目标，不能默认施加于柱顶。',
          }];
          return [];
        }
        if (!['column-top', 'top-node', 'top-nodes', 'top', '2', 'end'].includes(target)) {
          throw new Error('MODEL_EDIT_FIELD_INVALID: loads.target: the column template requires an explicit column-top target / 单柱模板要求明确column-top荷载目标，不能从文字猜测或丢弃定位信息。');
        }
        return [signedNodalComponent(load)];
      });
    if (columnLoads.length) {
      skillState.columnLoads = columnLoads;
    }
    if (next.lengthM === undefined && next.heightM !== undefined) next.lengthM = next.heightM;
    if (next.heightM === undefined && next.lengthM !== undefined) next.heightM = next.lengthM;
    const axial = columnLoads.find((load) => typeof load.fzKN === 'number') as { fzKN?: number } | undefined;
    if (axial?.fzKN !== undefined) {
      next.loadKN = Math.abs(axial.fzKN);
      next.loadType = 'point';
      next.loadPosition = 'top-nodes';
    }
  }

  if (inferredType === 'double-span-beam') {
    if (spanLengths?.length) {
      next.spanLengthM = next.spanLengthM ?? spanLengths[0];
      skillState.spanLengthsM = spanLengths;
      skillState.spanCount = spanLengths.length;
    }
    const lineLoad = loads.find(isLineLoad);
    if (lineLoad) {
      skillState.distributedLoadKNM = (lineLoad.direction === 'globalZ' ? -lineLoad.magnitude : lineLoad.magnitude);
      next.loadKN = next.loadKN ?? lineLoad.magnitude;
      next.loadType = next.loadType ?? 'distributed';
      next.loadPosition = next.loadPosition ?? 'full-span';
    }
    const pointLoad = loads.find((load) => isPointLikeLoad(load) && !isLineLoad(load));
    if (pointLoad) {
      skillState.pointLoadKN = (pointLoad.direction === 'globalZ' ? -pointLoad.magnitude : pointLoad.magnitude);
      if (pointLoad.location?.spanIndex !== undefined) skillState.pointLoadSpanIndex = pointLoad.location.spanIndex;
      if (pointLoad.location?.xM !== undefined) skillState.pointLoadXM = pointLoad.location.xM;
    }
  }

  if (inferredType === 'portal-frame') {
    if (spanLengths?.length) {
      next.spanLengthM = next.spanLengthM ?? spanLengths[0];
      skillState.portalBaySpansM = spanLengths;
      skillState.portalBayCount = spanLengths.length;
    }
    if (engineeringDraft.geometry?.mezzanineHeightM !== undefined) {
      skillState.mezzanineHeightM = engineeringDraft.geometry.mezzanineHeightM;
    }
    if (engineeringDraft.geometry?.mezzanineLengthM !== undefined) {
      skillState.mezzanineLengthM = engineeringDraft.geometry.mezzanineLengthM;
    }
    const exactIds = new Set([
      ...(engineeringDraft.topology?.nodes?.map(node => node.id) ?? []),
      ...(engineeringDraft.topology?.members?.map(member => member.id) ?? []),
    ].filter((id): id is string => typeof id === 'string'));
    const targetedLoads = loads.map(load => ({ load, target: portalTarget(load, exactIds) }));
    const mezzanineLoad = targetedLoads.find(({ load, target }) => isLineLoad(load) && target === 'mezzanine')?.load;
    if (mezzanineLoad) {
      skillState.mezzanineLoadKN = (mezzanineLoad.direction === 'globalZ' ? -mezzanineLoad.magnitude : mezzanineLoad.magnitude);
    }
    const roofLoad = targetedLoads.find(({ load, target }) => isLineLoad(load) && target === 'roof')?.load;
    if (roofLoad) {
      skillState.roofLoadKNM = (roofLoad.direction === 'globalZ' ? -roofLoad.magnitude : roofLoad.magnitude);
      next.loadKN = (roofLoad.direction === 'globalZ' ? -roofLoad.magnitude : roofLoad.magnitude);
      next.loadType = 'distributed';
      next.loadPosition = 'full-span';
    } else {
      const explicitRoofLoad = targetedLoads.find(({ target }) => target === 'roof')?.load;
      if (explicitRoofLoad) {
        next.loadKN = next.loadKN ?? explicitRoofLoad.magnitude;
        next.loadType = next.loadType ?? legacyLoadType(explicitRoofLoad);
        next.loadPosition = next.loadPosition ?? legacyLoadPosition(explicitRoofLoad);
      }
    }
    const craneLoad = targetedLoads.find(({ target }) => target === 'crane')?.load;
    if (craneLoad) {
      skillState.craneLoadKN = (craneLoad.direction === 'globalZ' ? -craneLoad.magnitude : craneLoad.magnitude);
    }
  }

  return next;
}
