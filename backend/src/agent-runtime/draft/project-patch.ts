import { normalizeFrameBoundary } from './legacy-fields.js';
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

function legacyLoadPosition(load: EngineeringDraftLoad): DraftLoadPosition {
  if (isLineLoad(load)) return 'full-span';
  const role = load.location?.nodeRole?.toLowerCase();
  if (role?.includes('top')) return 'top-nodes';
  if (load.location?.xM !== undefined) return 'free-joint';
  return 'midspan';
}

function targetIncludes(load: EngineeringDraftLoad, text: string): boolean {
  const targetText = [load.target, load.location?.nodeRole]
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .join(' ')
    .toLowerCase();
  return targetText.includes(text.toLowerCase());
}

function targetMatches(load: EngineeringDraftLoad, terms: readonly string[]): boolean {
  return terms.some((term) => targetIncludes(load, term));
}

function isClearPortalTarget(load: EngineeringDraftLoad, includeTerms: readonly string[], excludeTerms: readonly string[]): boolean {
  return targetMatches(load, includeTerms) && !targetMatches(load, excludeTerms);
}

const PORTAL_ROOF_TARGETS = ['roof', 'rafter', 'eave', '屋面', '屋顶', '檐梁'];
const PORTAL_MEZZANINE_TARGETS = ['mezzanine', 'platform', 'intermediate floor', '夹层', '平台'];
const PORTAL_CRANE_TARGETS = ['crane', '吊车'];

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

function isTopStoryTarget(target: string): boolean {
  const trimmed = target.trim();
  const text = trimmed.toLowerCase();
  return text.includes('roof')
    || /屋面|屋顶|楼顶|顶层|顶楼/u.test(trimmed)
    || trimmed === '顶';
}

export function isLocalizedFramePointLoad(load: EngineeringDraftLoad): boolean {
  if (!isPointLikeLoad(load)) return false;
  return load.location?.story !== undefined && Boolean(load.location.nodeRole?.trim());
}

/** Member positions are distinct from joint locations; never spread them over a floor. */
export function isFrameMemberPointLoad(load: EngineeringDraftLoad): boolean {
  return load.kind === 'point' && load.location?.xM !== undefined;
}

export function hasIncompleteFramePointLoadLocation(load: EngineeringDraftLoad): boolean {
  if (!isPointLikeLoad(load)) return false;
  if (isFrameMemberPointLoad(load)) {
    return !load.target?.trim()
      && !(load.location?.story !== undefined && load.location.spanIndex !== undefined);
  }
  const hasStory = load.location?.story !== undefined;
  const hasNodeRole = Boolean(load.location?.nodeRole?.trim());
  return hasStory !== hasNodeRole;
}

function parseStoryOrdinal(target: string | undefined, storyCount: number): number | undefined {
  if (!target) return undefined;
  const text = target.toLowerCase();
  if (isTopStoryTarget(target)) return storyCount;
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

function resolveFrameLoadStory(load: EngineeringDraftLoad, storyCount: number): number | undefined {
  const locationStory = load.location?.story;
  if (
    typeof locationStory === 'number'
    && Number.isInteger(locationStory)
    && locationStory >= 1
    && locationStory <= storyCount
  ) {
    return locationStory;
  }
  return parseStoryOrdinal(load.target, storyCount);
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
  index: number;
  totalKN: number;
};

function projectFrameFloorLoads(loads: EngineeringDraftLoad[], patch: DraftExtraction): DraftFloorLoad[] | undefined {
  const storyCount = patch.storyCount ?? patch.storyHeightsM?.length;
  if (!storyCount) return undefined;

  const floorLoadsByStory = new Map<number, DraftFloorLoad>();
  const convertibleLoads: ConvertibleFrameLoad[] = loads
    .map((load, index) => ({ load, index, totalKN: frameLoadTotalKN(load, patch) }))
    .filter((item): item is ConvertibleFrameLoad => (
      item.totalKN !== undefined
      && Number.isFinite(item.totalKN)
      && !isLocalizedFramePointLoad(item.load)
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

  for (const { load, index, totalKN } of comparableLoads) {
    const field = frameFloorLoadField(load);
    let stories: number[];
    const explicitStory = resolveFrameLoadStory(load, storyCount);
    if (explicitStory !== undefined) {
      stories = [explicitStory];
    } else {
      const sameFieldUntargetedLoads: ConvertibleFrameLoad[] = comparableLoads.filter((item) => (
        frameFloorLoadField(item.load) === field
        && resolveFrameLoadStory(item.load, storyCount) === undefined
      ));
      const untargetedIndex = sameFieldUntargetedLoads.findIndex((item) => item.index === index);
      if (sameFieldUntargetedLoads.length > 1) {
        stories = untargetedIndex >= 0 && untargetedIndex < storyCount ? [untargetedIndex + 1] : [];
      } else {
        stories = Array.from({ length: storyCount }, (_, storyIndex) => storyIndex + 1);
      }
    }

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
  const match = section.match(/([0-9]+(?:\.[0-9]+)?)\s*[xX×*]\s*([0-9]+(?:\.[0-9]+)?)/u);
  if (!match?.[1] || !match[2]) return {};
  const width = Number(match[1]);
  const depth = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(depth) || width <= 0 || depth <= 0) return {};
  const scale = width > 20 || depth > 20 ? 1000 : 1;
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
      .map((load) => signedNodalComponent(load));
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
    const mezzanineLoad = loads.find((load) => (
      isLineLoad(load)
      && isClearPortalTarget(load, PORTAL_MEZZANINE_TARGETS, PORTAL_ROOF_TARGETS)
    ));
    if (mezzanineLoad) {
      skillState.mezzanineLoadKN = (mezzanineLoad.direction === 'globalZ' ? -mezzanineLoad.magnitude : mezzanineLoad.magnitude);
    }
    const roofLoad = loads.find((load) => (
      isLineLoad(load)
      && isClearPortalTarget(load, PORTAL_ROOF_TARGETS, PORTAL_MEZZANINE_TARGETS)
    ))
      ?? loads.find((load) => (
        isLineLoad(load)
        && !targetMatches(load, PORTAL_MEZZANINE_TARGETS)
        && !targetMatches(load, PORTAL_CRANE_TARGETS)
      ));
    if (roofLoad) {
      skillState.roofLoadKNM = (roofLoad.direction === 'globalZ' ? -roofLoad.magnitude : roofLoad.magnitude);
      next.loadKN = (roofLoad.direction === 'globalZ' ? -roofLoad.magnitude : roofLoad.magnitude);
      next.loadType = 'distributed';
      next.loadPosition = 'full-span';
    } else {
      const defaultPortalLoad = loads.find((load) => (
        !targetMatches(load, PORTAL_MEZZANINE_TARGETS)
        && !targetMatches(load, PORTAL_CRANE_TARGETS)
      ));
      if (defaultPortalLoad) {
        next.loadKN = next.loadKN ?? defaultPortalLoad.magnitude;
        next.loadType = next.loadType ?? legacyLoadType(defaultPortalLoad);
        next.loadPosition = next.loadPosition ?? legacyLoadPosition(defaultPortalLoad);
      }
    }
    const craneLoad = loads.find((load) => targetMatches(load, PORTAL_CRANE_TARGETS));
    if (craneLoad) {
      skillState.craneLoadKN = (craneLoad.direction === 'globalZ' ? -craneLoad.magnitude : craneLoad.magnitude);
    }
  }

  return next;
}
