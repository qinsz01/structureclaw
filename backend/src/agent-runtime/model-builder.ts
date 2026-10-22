import { withCanonicalCoordinateContract } from '../engineering/coordinate-semantics.js';
import { buildExplicitDraftModel, validateExplicitModel } from './explicit-model.js';
import { applyTemplateProperties } from './template-properties.js';
import type { DraftState } from '../shared/types/agent.js';
import { buildFrame3dModel, buildFrame2dModel } from './model-builder/frame.js';
import { buildTrussModel } from './model-builder/truss.js';
import { buildColumnModel, buildSemanticBeamModel, buildBeamNodes, buildBeamLoads } from './model-builder/beam.js';
import { buildContinuousBeamModel, buildPortalFrameModel } from './model-builder/continuous.js';
import { readRecordArray, readPositiveNumber } from './model-builder/readers.js';
import { attachSeismicMemberEvidence } from './model-builder/seismic-evidence.js';

function buildBaseModel(state: DraftState): Record<string, unknown> {
  const metadata = {
    source: 'markdown-skill-draft',
    inferredType: state.inferredType,
    frameDimension: state.frameDimension === '3d' ? '3d' : '2d',
  };
  if (state.inferredType === 'frame') {
    if (state.frameDimension === '3d') {
      return buildFrame3dModel(state, metadata);
    }
    return buildFrame2dModel(state, metadata);
  }
  if (state.inferredType === 'truss') {
    return buildTrussModel(state, metadata);
  }
  if (state.inferredType === 'column') {
    return buildColumnModel(state, metadata);
  }
  if (state.inferredType === 'double-span-beam') {
    return buildContinuousBeamModel(state, metadata);
  }
  if (state.inferredType === 'portal-frame') {
    return buildPortalFrameModel(state, metadata);
  }
  if (state.inferredType !== 'beam') {
    throw new Error('MODEL_EDIT_FIELD_INVALID: A supported structural type is required; unknown types cannot use the beam template. / 必须明确支持的结构类型，未知类型不能套用梁模板。');
  }
  const length = state.lengthM!;
  const load = state.loadKN!;
  const supportType = state.supportType;
  if (!supportType) throw new Error('MODEL_EDIT_FIELD_INVALID: beam.supportType is required. / 梁模型必须明确支座类型。');
  const semanticBeamLoads = state.engineeringDraft?.loads?.length
    ? state.engineeringDraft.loads as unknown as Array<Record<string, unknown>>
    : readRecordArray(state.skillState?.beamLoads);
  if (semanticBeamLoads?.length) {
    return buildSemanticBeamModel(state, metadata, semanticBeamLoads);
  }
  const simpleSpan = readPositiveNumber(state.skillState?.simpleSpanM);
  const overhangLength = readPositiveNumber(state.skillState?.overhangLengthM);
  if (supportType === 'simply-supported' && simpleSpan !== undefined && overhangLength !== undefined) {
    // Validate the scalar contract, then preserve its explicit position in the actual beam mesh.
    buildBeamLoads(load, state.loadType, state.loadPosition, 'point', 'end', state.loadPositionM);
    const totalLength = simpleSpan + overhangLength;
    if (Math.abs(totalLength - length) > 1e-9) {
      throw new Error('MODEL_EDIT_FIELD_INVALID: beam length conflicts with the declared span and overhang. / 梁长与明确声明的主跨和悬挑长度冲突。');
    }
    const draft = { ...state, engineeringDraft: { ...state.engineeringDraft,
      geometry: { ...state.engineeringDraft?.geometry, spanLengthsM: [simpleSpan, overhangLength] },
      boundary: { ...state.engineeringDraft?.boundary, supportPositionsM: [0, simpleSpan] } } };
    const semanticLoad = state.loadType === 'distributed'
      ? { kind: 'line', magnitude: load, unit: 'kN/m', direction: 'gravity', target: 'full-span' }
      : { kind: 'point', magnitude: load, unit: 'kN', direction: 'gravity', location: state.loadPositionM !== undefined
        ? { xM: state.loadPositionM } : { nodeRole: state.loadPosition } };
    return buildSemanticBeamModel(draft, { ...metadata, simpleSpanM: simpleSpan, overhangLengthM: overhangLength }, [semanticLoad]);
  }
  const beamNodes = buildBeamNodes(length, supportType, state.loadPositionM);
  const beamLoads = buildBeamLoads(load, state.loadType, state.loadPosition, beamNodes.pointNodeId, beamNodes.endNodeId, state.loadPositionM);
  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    nodes: beamNodes.nodes,
    elements: beamNodes.elements,
    materials: [],
    sections: [],
    load_cases: [
      { id: 'LC1', type: 'other', loads: beamLoads },
    ],
    load_combinations: [],
    metadata: { ...metadata, supportType, loadPositionM: state.loadPositionM, simpleSpanM: simpleSpan, overhangLengthM: overhangLength },
  };
}

export function buildModel(state: DraftState): Record<string, unknown> {
  const explicit = buildExplicitDraftModel(state);
  if (explicit) return explicit;
  const dimension = state.inferredType === 'frame' && state.frameDimension === '3d' ? '3d' : '2d';
  return validateExplicitModel(withCanonicalCoordinateContract(
    attachSeismicMemberEvidence(applyTemplateProperties(buildBaseModel(state), state), state),
    dimension,
  ));
}
