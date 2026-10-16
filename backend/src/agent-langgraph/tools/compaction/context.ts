import { isRecord, optionalRecord, pickNumberLike, pickStringLike, omitEmptyRecord } from '../shared.js';

const ANALYSIS_MESSAGE_LIMIT = 6000;

type TextCompaction = 'middle' | 'tail';

export function compactText(
  value: unknown,
  limit = ANALYSIS_MESSAGE_LIMIT,
  mode: TextCompaction = 'middle',
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  if (mode === 'tail') {
    const marker = `...[truncated ${omitted} chars]\n`;
    const tailLength = Math.max(0, limit - marker.length);
    return `${marker}${text.slice(-tailLength)}`;
  }
  const marker = `\n...[truncated ${omitted} chars]...\n`;
  const bodyLength = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(bodyLength * 0.35);
  const tailLength = bodyLength - headLength;
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

export function compactFinalCompliance(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!record) return undefined;
  return omitEmptyRecord({
    status: pickStringLike(record, 'status'),
    utilization: pickNumberLike(record, 'utilization'),
    driftRatio: pickNumberLike(record, 'driftRatio'),
    limitDriftRatio: pickNumberLike(record, 'limitDriftRatio'),
    source: pickStringLike(record, 'source'),
    scope: pickStringLike(record, 'scope'),
  });
}

export function compactCapabilityAssessment(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = optionalRecord(data.capabilityAssessment) ?? data;
  const implementedCapabilities = (
    Array.isArray(source.implementedCapabilities)
      ? source.implementedCapabilities
      : []
  ).filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const missingCapabilities = (
    Array.isArray(source.missingCapabilities)
      ? source.missingCapabilities
      : Array.isArray(data.missingCapabilities)
        ? data.missingCapabilities
        : []
  ).filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const finalComplianceSupported = typeof source.finalComplianceSupported === 'boolean'
    ? source.finalComplianceSupported
    : undefined;

  return omitEmptyRecord({
    finalComplianceSupported,
    implementedCapabilityCount: implementedCapabilities.length > 0 ? implementedCapabilities.length : undefined,
    implementedCapabilities: implementedCapabilities.length > 0 ? implementedCapabilities.slice(0, 8) : undefined,
    missingCapabilityCount: missingCapabilities.length > 0 ? missingCapabilities.length : undefined,
    missingCapabilities: missingCapabilities.length > 0 ? missingCapabilities.slice(0, 8) : undefined,
  });
}

export function compactSpecialSystemReview(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const review = optionalRecord(data.specialSystemReview);
  if (!review) return undefined;
  const systems = Array.isArray(review.systems)
    ? review.systems.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const missingInputs = Array.isArray(review.missingInputs)
    ? review.missingInputs.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const capabilityBoundaries = Array.isArray(review.capabilityBoundaries)
    ? review.capabilityBoundaries.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const checks = Array.isArray(review.checks)
    ? review.checks.filter(isRecord)
    : [];
  const isolationEstimate = optionalRecord(review.isolationEquivalentLinearEstimate);
  const isolationFinalCompliance = optionalRecord(isolationEstimate?.finalCompliance);
  const isolationTimeHistoryEstimate = optionalRecord(review.isolationLayerTimeHistoryEstimate);
  const isolationTimeHistoryFinalCompliance = optionalRecord(isolationTimeHistoryEstimate?.finalCompliance);
  const energyEstimate = optionalRecord(review.energyDissipationEquivalentEstimate);
  const energyFinalCompliance = optionalRecord(energyEstimate?.finalCompliance);
  const energyTimeHistoryEstimate = optionalRecord(review.energyDissipationTimeHistoryEstimate);
  const energyTimeHistoryFinalCompliance = optionalRecord(energyTimeHistoryEstimate?.finalCompliance);
  const failedChecks = checks
    .filter((check) => pickStringLike(check, 'status') === 'fail')
    .map((check) => pickStringLike(check, 'item'))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  return omitEmptyRecord({
    reviewRequired: typeof review.reviewRequired === 'boolean' ? review.reviewRequired : undefined,
    status: pickStringLike(review, 'status'),
    systems: systems.length > 0 ? systems : undefined,
    missingInputs: missingInputs.length > 0 ? missingInputs.slice(0, 8) : undefined,
    capabilityBoundaries: capabilityBoundaries.length > 0 ? capabilityBoundaries.slice(0, 8) : undefined,
    deviceCounts: optionalRecord(review.deviceCounts),
    checkCount: checks.length > 0 ? checks.length : undefined,
    failedCheckCount: pickNumberLike(review, 'failedCheckCount') ?? (failedChecks.length > 0 ? failedChecks.length : undefined),
    failedChecks: failedChecks.length > 0 ? failedChecks.slice(0, 5) : undefined,
    isolationEquivalentLinearEstimate: isolationEstimate ? omitEmptyRecord({
      status: pickStringLike(isolationEstimate, 'status'),
      periodSec: pickNumberLike(isolationEstimate, 'periodSec'),
      alpha: pickNumberLike(isolationEstimate, 'alpha'),
      baseShearKN: pickNumberLike(isolationEstimate, 'baseShearKN'),
      displacementDemandM: pickNumberLike(isolationEstimate, 'displacementDemandM'),
      displacementCapacityM: pickNumberLike(isolationEstimate, 'displacementCapacityM'),
      displacementUtilization: pickNumberLike(isolationEstimate, 'displacementUtilization'),
      finalCompliance: compactFinalCompliance(isolationFinalCompliance),
    }) : undefined,
    isolationLayerTimeHistoryEstimate: isolationTimeHistoryEstimate ? omitEmptyRecord({
      status: pickStringLike(isolationTimeHistoryEstimate, 'status'),
      periodSec: pickNumberLike(isolationTimeHistoryEstimate, 'periodSec'),
      recordCount: pickNumberLike(isolationTimeHistoryEstimate, 'recordCount'),
      controllingRecord: pickStringLike(isolationTimeHistoryEstimate, 'controllingRecord'),
      maxDisplacementM: pickNumberLike(isolationTimeHistoryEstimate, 'maxDisplacementM'),
      maxBaseShearKN: pickNumberLike(isolationTimeHistoryEstimate, 'maxBaseShearKN'),
      displacementCapacityM: pickNumberLike(isolationTimeHistoryEstimate, 'displacementCapacityM'),
      displacementUtilization: pickNumberLike(isolationTimeHistoryEstimate, 'displacementUtilization'),
      finalCompliance: compactFinalCompliance(isolationTimeHistoryFinalCompliance),
    }) : undefined,
    energyDissipationEquivalentEstimate: energyEstimate ? omitEmptyRecord({
      status: pickStringLike(energyEstimate, 'status'),
      periodSec: pickNumberLike(energyEstimate, 'periodSec'),
      baseDampingRatio: pickNumberLike(energyEstimate, 'baseDampingRatio'),
      additionalDampingRatio: pickNumberLike(energyEstimate, 'additionalDampingRatio'),
      equivalentDampingRatio: pickNumberLike(energyEstimate, 'equivalentDampingRatio'),
      demandReductionRatio: pickNumberLike(energyEstimate, 'demandReductionRatio'),
      adjustedDisplacementDemandM: pickNumberLike(energyEstimate, 'adjustedDisplacementDemandM'),
      deformationCapacityM: pickNumberLike(energyEstimate, 'deformationCapacityM'),
      deformationUtilization: pickNumberLike(energyEstimate, 'deformationUtilization'),
      finalCompliance: compactFinalCompliance(energyFinalCompliance),
    }) : undefined,
    energyDissipationTimeHistoryEstimate: energyTimeHistoryEstimate ? omitEmptyRecord({
      status: pickStringLike(energyTimeHistoryEstimate, 'status'),
      periodSec: pickNumberLike(energyTimeHistoryEstimate, 'periodSec'),
      recordCount: pickNumberLike(energyTimeHistoryEstimate, 'recordCount'),
      controllingRecord: pickStringLike(energyTimeHistoryEstimate, 'controllingRecord'),
      maxDeviceDeformationM: pickNumberLike(energyTimeHistoryEstimate, 'maxDeviceDeformationM'),
      maxDeviceForceKN: pickNumberLike(energyTimeHistoryEstimate, 'maxDeviceForceKN'),
      deformationCapacityM: pickNumberLike(energyTimeHistoryEstimate, 'deformationCapacityM'),
      deformationUtilization: pickNumberLike(energyTimeHistoryEstimate, 'deformationUtilization'),
      forceCapacityKN: pickNumberLike(energyTimeHistoryEstimate, 'forceCapacityKN'),
      forceUtilization: pickNumberLike(energyTimeHistoryEstimate, 'forceUtilization'),
      finalCompliance: compactFinalCompliance(energyTimeHistoryFinalCompliance),
    }) : undefined,
  });
}

export function compactFloorLoadTransferSummary(
  data: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const source = optionalRecord(data.floorLoadTransfer) ?? optionalRecord(result.floorLoadTransfer);
  if (!source) return undefined;

  const rawWarnings = Array.isArray(source.warnings) ? source.warnings : [];
  const warnings = rawWarnings
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .slice(0, 5)
    .map((value) => compactText(value, 500) ?? value);

  const rawItems = Array.isArray(source.items) ? source.items : [];
  const items = rawItems
    .filter(isRecord)
    .slice(0, 8)
    .map((item) => omitEmptyRecord({
      story: pickStringLike(item, 'story'),
      panelId: pickStringLike(item, 'panelId'),
      requestedMode: pickStringLike(item, 'requestedMode'),
      effectiveMode: pickStringLike(item, 'effectiveMode'),
      method: pickStringLike(item, 'method'),
      methodEn: pickStringLike(item, 'methodEn'),
      methodZh: pickStringLike(item, 'methodZh'),
      designCodeRule: pickStringLike(item, 'designCodeRule'),
      designCodeRuleEn: pickStringLike(item, 'designCodeRuleEn'),
      designCodeRuleZh: pickStringLike(item, 'designCodeRuleZh'),
      generatedLoadType: pickStringLike(item, 'generatedLoadType'),
      generatedLoadCount: pickNumberLike(item, 'generatedLoadCount'),
      loadIntensityKNPerM2: pickNumberLike(item, 'loadIntensityKNPerM2'),
      totalLoadKN: pickNumberLike(item, 'totalLoadKN'),
      spanX: pickNumberLike(item, 'spanX'),
      spanY: pickNumberLike(item, 'spanY'),
      longShortRatio: pickNumberLike(item, 'longShortRatio'),
      note: pickStringLike(item, 'note'),
      noteEn: pickStringLike(item, 'noteEn'),
      noteZh: pickStringLike(item, 'noteZh'),
    }))
    .filter((item): item is Record<string, unknown> => !!item);

  return omitEmptyRecord({
    requestedMode: pickStringLike(source, 'requestedMode'),
    effectiveMode: pickStringLike(source, 'effectiveMode'),
    method: pickStringLike(source, 'method'),
    methodEn: pickStringLike(source, 'methodEn'),
    methodZh: pickStringLike(source, 'methodZh'),
    designCode: pickStringLike(source, 'designCode'),
    loadSource: pickStringLike(source, 'loadSource'),
    itemCount: rawItems.length > 0 ? rawItems.length : undefined,
    items: items.length > 0 ? items : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}

export function compactAnalysisModelContext(
  model: Record<string, unknown> | undefined,
  preferredNodeIds: string[] = [],
  preferredElementIds: string[] = [],
): Record<string, unknown> | undefined {
  if (!model) return undefined;

  const entityLimit = 60;
  const rawNodes = Array.isArray(model.nodes) ? model.nodes : [];
  const rawElements = Array.isArray(model.elements) ? model.elements : [];
  const nodeEntries = rawNodes
    .filter(isRecord)
    .map((node) => {
      const id = pickStringLike(node, 'id');
      if (!id) return null;
      return [id, omitEmptyRecord({
        x: pickNumberLike(node, 'x'),
        y: pickNumberLike(node, 'y'),
        z: pickNumberLike(node, 'z'),
        restraints: Array.isArray(node.restraints)
          ? node.restraints.filter((value): value is boolean => typeof value === 'boolean')
          : undefined,
      }) ?? {}] as const;
    })
    .filter((entry): entry is readonly [string, Record<string, unknown>] => entry !== null);
  const elementEntries = rawElements
    .filter(isRecord)
    .map((element) => {
      const id = pickStringLike(element, 'id');
      if (!id) return null;
      return [id, omitEmptyRecord({
        type: pickStringLike(element, 'type'),
        nodes: Array.isArray(element.nodes)
          ? element.nodes
              .map((value) => (
                typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
                  ? String(value)
                  : null
              ))
              .filter((value): value is string => value !== null)
          : undefined,
        material: pickStringLike(element, 'material'),
        section: pickStringLike(element, 'section'),
      }) ?? {}] as const;
    })
    .filter((entry): entry is readonly [string, Record<string, unknown>] => entry !== null);

  const prioritizeEntries = (
    entries: Array<readonly [string, Record<string, unknown>]>,
    preferredIds: string[],
  ): Array<readonly [string, Record<string, unknown>]> => {
    const entriesById = new Map(entries);
    const seenIds = new Set<string>();
    const prioritized: Array<readonly [string, Record<string, unknown>]> = [];
    for (const id of [...preferredIds, ...entriesById.keys()]) {
      if (seenIds.has(id)) continue;
      const value = entriesById.get(id);
      if (!value) continue;
      seenIds.add(id);
      prioritized.push([id, value]);
    }
    return prioritized;
  };
  const elementsById = new Map(elementEntries);
  const preferredElementNodeIds = preferredElementIds.flatMap((elementId) => {
    const nodes = elementsById.get(elementId)?.nodes;
    return Array.isArray(nodes)
      ? nodes.filter((nodeId): nodeId is string => typeof nodeId === 'string')
      : [];
  });
  const prioritizedNodeEntries = prioritizeEntries(
    nodeEntries,
    [...preferredElementNodeIds, ...preferredNodeIds],
  );
  const prioritizedElementEntries = prioritizeEntries(elementEntries, preferredElementIds);

  return omitEmptyRecord({
    coordinateSystem: optionalRecord(model.coordinate_system),
    nodes: nodeEntries.length > 0
      ? {
          totalCount: nodeEntries.length,
          truncated: nodeEntries.length > entityLimit,
          values: Object.fromEntries(prioritizedNodeEntries.slice(0, entityLimit)),
        }
      : undefined,
    elements: elementEntries.length > 0
      ? {
          totalCount: elementEntries.length,
          truncated: elementEntries.length > entityLimit,
          values: Object.fromEntries(prioritizedElementEntries.slice(0, entityLimit)),
        }
      : undefined,
  });
}
