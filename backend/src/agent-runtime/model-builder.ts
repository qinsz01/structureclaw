import { withCanonicalCoordinateContract } from '../engineering/coordinate-semantics.js';
import { buildExplicitDraftModel, validateExplicitModel } from './explicit-model.js';
import { applyTemplateProperties } from './template-properties.js';
import type { DraftState } from '../shared/types/agent.js';
import { buildFrame3dModel, buildFrame2dModel } from './model-builder/frame.js';
import { buildTrussModel } from './model-builder/truss.js';
import { buildColumnModel, buildSemanticBeamModel, buildOverhangingBeamNodes, buildBeamNodes, buildBeamLoads } from './model-builder/beam.js';
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
  const length = state.lengthM!;
  const load = state.loadKN!;
  const supportType = state.supportType || 'cantilever';
  const semanticBeamLoads = readRecordArray(state.skillState?.beamLoads);
  if (semanticBeamLoads?.length) {
    return buildSemanticBeamModel(state, metadata, semanticBeamLoads);
  }
  const simpleSpan = readPositiveNumber(state.skillState?.simpleSpanM);
  const overhangLength = readPositiveNumber(state.skillState?.overhangLengthM);
  const beamNodes = supportType === 'simply-supported' && simpleSpan !== undefined && overhangLength !== undefined
    ? buildOverhangingBeamNodes(simpleSpan, overhangLength)
    : buildBeamNodes(length, supportType, state.loadPositionM);
  const beamLoads = buildBeamLoads(load, state.loadType, state.loadPosition, beamNodes.pointNodeId, beamNodes.endNodeId);
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
