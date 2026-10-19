import { compactText, compactFinalCompliance, compactCapabilityAssessment, compactSpecialSystemReview, compactFloorLoadTransferSummary, compactAnalysisModelContext } from './context.js';
import { optionalRecord, countRecordEntries, firstDefined, pickNumberLike, pickStringLike, omitEmptyRecord } from '../shared.js';
import { withGlobalResultLocations } from '../../../engineering/result-locations.js';

export function pickAnalysisDiagnostics(
  result: Record<string, unknown>,
  meta: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const diagnostics: Record<string, unknown> = {};
  const copy = (targetKey: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    const isTail = targetKey.endsWith('Tail');
    diagnostics[targetKey] = typeof value === 'string'
      ? compactText(value, 2000, isTail ? 'tail' : 'middle') ?? value
      : value;
  };

  copy('engineId', meta.engineId);
  copy('engineName', meta.engineName);
  copy('failureKind', meta.failureKind);
  copy('capability', meta.capability);
  copy('exceptionType', meta.exceptionType);
  copy('analysisSkillId', meta.analysisSkillId);
  copy('analysisAdapterKey', meta.analysisAdapterKey);
  copy('workDir', meta.workDir);
  copy('runMetaPath', meta.runMetaPath);
  copy('driverResultPath', meta.driverResultPath);
  copy('driverOutputPath', meta.driverOutputPath);
  copy('stdoutPath', meta.stdoutPath);
  copy('stderrPath', meta.stderrPath);
  copy('stdoutTail', meta.stdoutTail);
  copy('stderrTail', meta.stderrTail);
  copy('stepsTail', meta.stepsTail);
  copy('message', result.message);

  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

export function buildSuccessfulAnalysisDetails(
  data: Record<string, unknown>,
  result: Record<string, unknown>,
  model?: Record<string, unknown>,
) {
  data = withGlobalResultLocations(model, data);
  const summary = optionalRecord(data.summary);
  const envelope = optionalRecord(data.envelope);
  const responseSpectrumFinalCompliance = optionalRecord(data.responseSpectrumFinalCompliance);
  const elasticStoryDriftFinalCompliance = optionalRecord(data.elasticStoryDriftFinalCompliance);
  const elasticPlasticTimeHistory = optionalRecord(data.elasticPlasticTimeHistory);
  const pushover = optionalRecord(data.pushover);
  const caseResults = optionalRecord(data.caseResults);
  const loadCases = optionalRecord(data.loadCases);
  const combinations = optionalRecord(data.combinations);

  const counts = omitEmptyRecord({
    nodeCount: firstDefined(
      summary ? pickNumberLike(summary, 'nodeCount') : undefined,
      countRecordEntries(data.displacements),
    ),
    elementCount: firstDefined(
      summary ? pickNumberLike(summary, 'elementCount') : undefined,
      countRecordEntries(data.forces),
    ),
    reactionNodeCount: firstDefined(
      summary ? pickNumberLike(summary, 'reactionNodeCount') : undefined,
      countRecordEntries(data.reactions),
    ),
    loadCaseCount: firstDefined(
      summary ? pickNumberLike(summary, 'loadCaseCount') : undefined,
      countRecordEntries(caseResults),
      countRecordEntries(loadCases),
    ),
    combinationCount: firstDefined(
      summary ? pickNumberLike(summary, 'combinationCount') : undefined,
      countRecordEntries(combinations),
    ),
  });

  const keyMetrics = envelope ? omitEmptyRecord({
    maxAbsDisplacement: pickNumberLike(envelope, 'maxAbsDisplacement'),
    maxAbsAxialForce: pickNumberLike(envelope, 'maxAbsAxialForce'),
    maxAbsShearForce: pickNumberLike(envelope, 'maxAbsShearForce'),
    maxAbsMoment: pickNumberLike(envelope, 'maxAbsMoment'),
    maxAbsReaction: pickNumberLike(envelope, 'maxAbsReaction'),
    maxAbsReactionMoment: pickNumberLike(envelope, 'maxAbsReactionMoment'),
    maxBaseShear: pickNumberLike(envelope, 'maxBaseShear'),
    maxStoryDriftRatio: pickNumberLike(envelope, 'maxStoryDriftRatio'),
    modalMassParticipationRatio: pickNumberLike(envelope, 'modalMassParticipationRatio'),
  }) : undefined;

  const controlling = envelope ? omitEmptyRecord({
    controlNodeDisplacement: pickStringLike(envelope, 'controlNodeDisplacement'),
    controlElementDisplacement: pickStringLike(envelope, 'controlElementDisplacement'),
    locations: optionalRecord(envelope.controlLocations),
    controlElementAxialForce: pickStringLike(envelope, 'controlElementAxialForce'),
    controlElementShearForce: pickStringLike(envelope, 'controlElementShearForce'),
    controlElementMoment: pickStringLike(envelope, 'controlElementMoment'),
    controlNodeReaction: pickStringLike(envelope, 'controlNodeReaction'),
    controlNodeReactionMoment: pickStringLike(envelope, 'controlNodeReactionMoment'),
  }) : undefined;
  const responseEntityLimit = 60;
  const compactResponseEntities = (
    value: unknown,
    preferredIds: Array<string | undefined>,
  ): Record<string, unknown> | undefined => {
    const source = optionalRecord(value);
    if (!source) return undefined;
    const sourceIds = Object.keys(source);
    if (sourceIds.length === 0) return undefined;
    const orderedIds = [
      ...preferredIds.filter((id): id is string => typeof id === 'string' && id in source),
      ...sourceIds,
    ].filter((id, index, allIds) => allIds.indexOf(id) === index);
    const selectedIds = orderedIds.slice(0, responseEntityLimit);
    return {
      totalCount: sourceIds.length,
      truncated: sourceIds.length > selectedIds.length,
      values: Object.fromEntries(selectedIds.map((id) => [id, source[id]])),
    };
  };
  const analysisMeta = optionalRecord(data.meta);
  const responseEnvelopeId = (key: string): string | undefined => (
    envelope ? pickStringLike(envelope, key) ?? undefined : undefined
  );
  const responseMetaValue = (key: string): string | undefined => (
    analysisMeta ? pickStringLike(analysisMeta, key) ?? undefined : undefined
  );
  const preferredModelNodeIds = [
    responseEnvelopeId('controlNodeDisplacement'),
    responseEnvelopeId('controlNodeReaction'),
    ...Object.keys(optionalRecord(data.displacements ?? data.nodeDisplacements) ?? {}),
    ...Object.keys(optionalRecord(data.reactions ?? data.nodeReactions) ?? {}),
  ].filter((id): id is string => typeof id === 'string');
  const preferredModelElementIds = [
    responseEnvelopeId('controlElementAxialForce'),
    responseEnvelopeId('controlElementShearForce'),
    responseEnvelopeId('controlElementMoment'),
  ].filter((id): id is string => typeof id === 'string');
  const responses = omitEmptyRecord({
    coordinateSemantics: responseMetaValue('coordinateSemantics'),
    dimension: responseMetaValue('dimension'),
    plane: responseMetaValue('plane'),
    activeDofs: Array.isArray(analysisMeta?.activeDofs)
      ? analysisMeta.activeDofs.filter((value): value is string => typeof value === 'string')
      : undefined,
    units: optionalRecord(analysisMeta?.units),
    nodalResultFrame: responseMetaValue('nodalResultFrame'),
    elementForceFrame: responseMetaValue('elementForceFrame'),
    displacements: compactResponseEntities(
      data.displacements ?? data.nodeDisplacements,
      [responseEnvelopeId('controlNodeDisplacement')],
    ),
    reactions: compactResponseEntities(
      data.reactions ?? data.nodeReactions,
      [responseEnvelopeId('controlNodeReaction')],
    ),
    memberForces: compactResponseEntities(
      data.forces ?? data.memberForces,
      [
        responseEnvelopeId('controlElementAxialForce'),
        responseEnvelopeId('controlElementShearForce'),
        responseEnvelopeId('controlElementMoment'),
      ],
    ),
  });
  const compliance = omitEmptyRecord({
    responseSpectrumDrift: compactFinalCompliance(responseSpectrumFinalCompliance),
    elasticStoryDrift: compactFinalCompliance(elasticStoryDriftFinalCompliance),
    elasticPlasticTimeHistory: compactFinalCompliance(optionalRecord(elasticPlasticTimeHistory?.finalCompliance)),
    pushover: compactFinalCompliance(optionalRecord(pushover?.finalCompliance)),
  });

  const rawWarnings = Array.isArray(data.warnings)
    ? data.warnings
    : Array.isArray(result.warnings)
      ? result.warnings
      : [];
  const warnings = rawWarnings
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .slice(0, 5)
    .map((value) => compactText(value, 500) ?? value);

  return omitEmptyRecord({
    workflowInputMode: pickStringLike(data, 'workflowInputMode') ?? pickStringLike(result, 'workflowInputMode'),
    counts,
    keyMetrics,
    envelopeMethod: envelope ? pickStringLike(envelope, 'method') : undefined,
    controlling,
    modelContext: compactAnalysisModelContext(
      model,
      preferredModelNodeIds,
      preferredModelElementIds,
    ),
    responses,
    compliance,
    capabilityAssessment: compactCapabilityAssessment(data),
    specialSystemReview: compactSpecialSystemReview(data),
    floorLoadTransfer: compactFloorLoadTransferSummary(data, result),
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}
