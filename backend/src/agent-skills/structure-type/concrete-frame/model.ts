import { buildExplicitDraftModel } from '../../../agent-runtime/explicit-model.js';
import { applyDraftAnalysisControl } from '../../../agent-runtime/engineering-draft.js';
import { withCanonicalCoordinateContract } from '../../../engineering/coordinate-semantics.js';
import type { DraftSiteSeismicParams, DraftState, DraftWindParams } from '../../../shared/types/agent.js';
import type { ConcreteFrameOutput } from './types.js';
import { buildSiteSeismicRecord, buildWindRecord, buildAnalysisControlRecord, buildCodeCheckMetadata } from './model/records.js';
import type { ConcreteFrameModel } from './model/records.js';
import { isValidConcreteGrade, isValidRebarGrade, normalizeConcreteGrade, resolveConcreteMaterialProps, resolveRebarMaterialProps, resolveSectionProps } from './model/materials.js';
import { buildConcreteFrame3dLocalModel } from './model/frame-3d.js';
import { buildConcreteFrame2dLocalModel } from './model/frame-2d.js';

/**
 * Build a concrete frame model from draft state.
 * Returns a full mesh model (nodes + elements + materials + sections + load cases)
 * suitable for OpenSees analysis, plus GB 50010 code-check results.
 * @param state Draft state with concrete frame parameters
 * @param codeCheckResults Optional code-check results from generateMembers
 * @returns Record ready for analysis engine (schema 2.0), or undefined if critical geometry missing
 */
export function buildConcreteFrameModel(
  state: DraftState,
  codeCheckResults?: ConcreteFrameOutput,
): ConcreteFrameModel | undefined {
  const explicit = buildExplicitDraftModel(state);
  if (explicit) return explicit as ConcreteFrameModel;
  const storyCount = state.storyCount;
  const storyHeightsM = state.storyHeightsM;

  if (storyCount === undefined || !storyHeightsM?.length) {
    return undefined;
  }
  if (storyHeightsM.length !== storyCount) {
    return undefined;
  }

  const frameDimension = state.frameDimension || '2d';
  if (frameDimension === '3d') {
    if (!state.bayWidthsXM?.length || !state.bayWidthsYM?.length
      || state.bayWidthsXM.length !== state.bayCountX || state.bayWidthsYM.length !== state.bayCountY) return undefined;
  } else if (!state.bayWidthsM?.length || state.bayWidthsM.length !== state.bayCount) return undefined;
  const floorLoads = state.floorLoads ?? [];

  // M1: Separate concrete and rebar grade handling
  const rawFrameConcreteGrade = (state.frameConcreteGrade as string | undefined);
  const rawFrameRebarGrade = (state.frameRebarGrade as string | undefined);

  if (!rawFrameConcreteGrade || !isValidConcreteGrade(rawFrameConcreteGrade)
    || !state.frameColumnSection || !state.frameBeamSection) {
    throw new Error('TEMPLATE_PROPERTY_REQUIRED: concrete grade and beam/column sections / 请明确混凝土强度等级及梁柱截面');
  }
  const frameConcreteGrade = normalizeConcreteGrade(rawFrameConcreteGrade);
  // Elastic analysis does not need the rebar grade; a declared grade must still be valid (no substitution).
  if (rawFrameRebarGrade && !isValidRebarGrade(rawFrameRebarGrade)) {
    throw new Error('TEMPLATE_PROPERTY_REQUIRED: rebar grade / 钢筋牌号无效，请更正或省略');
  }
  const frameRebarGrade = rawFrameRebarGrade ? rawFrameRebarGrade.toUpperCase().replace(/\s+/g, '') : undefined;
  const frameColumnSection = state.frameColumnSection as string;
  const frameBeamSection = state.frameBeamSection as string;
  const frameBaseSupportType = (state.frameBaseSupportType as string | undefined) || 'fixed';

  const concreteProps = resolveConcreteMaterialProps(frameConcreteGrade);
  const rebarProps = frameRebarGrade ? resolveRebarMaterialProps(frameRebarGrade) : undefined;
  const columnProps = resolveSectionProps(frameColumnSection);
  const beamProps = resolveSectionProps(frameBeamSection);
  const siteSeismic = buildSiteSeismicRecord(state.siteSeismic as DraftSiteSeismicParams | undefined);
  const wind = buildWindRecord(state.wind as DraftWindParams | undefined);
  const analysisControl = siteSeismic || wind || state.analysisControl || state.engineeringDraft?.analysisControl
    ? { ...buildAnalysisControlRecord(state.analysisControl),
      ...applyDraftAnalysisControl({ analysis_control: buildAnalysisControlRecord(state.analysisControl, false) },
        state.engineeringDraft, true).analysis_control as Record<string, unknown> | undefined }
    : undefined;

  // Reinforcement must come from an explicit, confirmed design; geometry templates
  // do not invent bar areas, diameters, spacing, or cover for code checking.

  if (frameDimension === '3d') {
    const bayWidthsXM = state.bayWidthsXM?.length ? state.bayWidthsXM : state.bayWidthsM;
    const bayWidthsYM = state.bayWidthsYM?.length ? state.bayWidthsYM : state.bayWidthsM;
    const bayCountX = state.bayCountX ?? bayWidthsXM?.length;
    const bayCountY = state.bayCountY ?? bayWidthsYM?.length;

    if (bayCountX === undefined || bayCountY === undefined || !bayWidthsXM?.length || !bayWidthsYM?.length) {
      return undefined;
    }
    if (bayWidthsXM.length !== bayCountX || bayWidthsYM.length !== bayCountY) {
      return undefined;
    }

    const model3d = buildConcreteFrame3dLocalModel({
      storyCount,
      bayCountX,
      bayCountY,
      storyHeightsM,
      bayWidthsXM,
      bayWidthsYM,
      floorLoads,
      frameBaseSupportType,
      frameConcreteGrade,
      frameRebarGrade,
      frameColumnSection,
      frameBeamSection,
      concreteProps,
      rebarProps,
      columnProps,
      beamProps,
      siteSeismic,
      wind,
      analysisControl,
      engineeringDraft: state.engineeringDraft,
    });

    if (!state.frameBaseSupportType) model3d.metadata = { ...model3d.metadata, templateAssumptions: [{
      field: 'boundary.frameBaseSupportType', value: 'fixed', reason: 'Unstated frame bases default to fixed / 未说明柱脚时默认刚接',
    }] };

    if (!state.frameBaseSupportType) model2d.metadata = { ...model2d.metadata, templateAssumptions: [{
    field: 'boundary.frameBaseSupportType', value: 'fixed', reason: 'Unstated frame bases default to fixed / 未说明柱脚时默认刚接',
  }] };

  if (codeCheckResults) {
      model3d.metadata = {
        ...model3d.metadata,
        codeCheckResults: buildCodeCheckMetadata(codeCheckResults),
      };
    }

    return withCanonicalCoordinateContract(model3d, '3d') as ConcreteFrameModel;
  }

  const bayCount = state.bayCount;
  const bayWidthsM = state.bayWidthsM;

  if (bayCount === undefined || !bayWidthsM?.length) {
    return undefined;
  }
  if (bayWidthsM.length !== bayCount) {
    return undefined;
  }

  const model2d = buildConcreteFrame2dLocalModel({
    storyCount,
    bayCount,
    storyHeightsM,
    bayWidthsM,
    floorLoads,
    frameBaseSupportType,
    frameConcreteGrade,
    frameRebarGrade,
    frameColumnSection,
    frameBeamSection,
    concreteProps,
    rebarProps,
    columnProps,
    beamProps,
    siteSeismic,
    wind,
    analysisControl,
    engineeringDraft: state.engineeringDraft,
  });

  if (codeCheckResults) {
    model2d.metadata = {
      ...model2d.metadata,
      codeCheckResults: buildCodeCheckMetadata(codeCheckResults),
    };
  }

  return withCanonicalCoordinateContract(model2d, '2d') as ConcreteFrameModel;
}
