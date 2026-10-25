import type { MessageKey } from '@/lib/i18n'
import { analysisData } from '@/lib/analysis-data'

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : []
}

export function finiteNumber(value: unknown): number | null {
  return (typeof value === 'number' && Number.isFinite(value) ? value : null)
}

/** Extracts the typed sub-records of an analysis payload used by the summary stats. */
export function buildSummaryStatsContext(analysis: Record<string, unknown>, t: (key: MessageKey) => string) {
  const data = analysisData(analysis) ?? {}
  const meta = typeof analysis.meta === 'object' && analysis.meta ? (analysis.meta as Record<string, unknown>) : null
  const summary = typeof data.summary === 'object' && data.summary ? (data.summary as Record<string, unknown>) : null
  const modelSummary = typeof data.modelSummary === 'object' && data.modelSummary ? (data.modelSummary as Record<string, unknown>) : null
  const envelope = typeof data.envelope === 'object' && data.envelope ? (data.envelope as Record<string, unknown>) : null
  const methodDecision = typeof data.methodDecision === 'object' && data.methodDecision ? (data.methodDecision as Record<string, unknown>) : null
  const specialSystemReview = typeof data.specialSystemReview === 'object' && data.specialSystemReview ? (data.specialSystemReview as Record<string, unknown>) : null
  const structuredReviewEntries = ([
    ['overLimitReview', data.overLimitReview],
    ['specialReview', data.specialReview],
    ['specialSeismicReview', data.specialSeismicReview],
    ['overLimitSpecialReview', data.overLimitSpecialReview],
  ] as const).reduce<Array<{ key: string; value: Record<string, unknown> }>>((items, [key, value]) => {
    if (typeof value === 'object' && value && !Array.isArray(value)) {
      items.push({ key, value: value as Record<string, unknown> })
    }
    return items
  }, [])
  const designBasis = typeof data.designBasis === 'object' && data.designBasis ? (data.designBasis as Record<string, unknown>) : null
  const codeBasis = Array.isArray(designBasis?.codeBasis)
    ? designBasis.codeBasis.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    : []
  const gb18306Basis = codeBasis.find((item) => item.code === 'GB 18306-2015') ?? null
  const groundMotionZonation = typeof designBasis?.groundMotionZonation === 'object' && designBasis.groundMotionZonation ? (designBasis.groundMotionZonation as Record<string, unknown>) : null
  const fortificationCategoryLabel = typeof designBasis?.fortificationCategoryLabel === 'object' && designBasis.fortificationCategoryLabel ? (designBasis.fortificationCategoryLabel as Record<string, unknown>) : null
  const responseSpectrum = typeof data.responseSpectrum === 'object' && data.responseSpectrum ? (data.responseSpectrum as Record<string, unknown>) : null
  const minimumStoryShearAdjustment = typeof responseSpectrum?.minimumStoryShearAdjustment === 'object' && responseSpectrum.minimumStoryShearAdjustment
    ? (responseSpectrum.minimumStoryShearAdjustment as Record<string, unknown>)
    : null
  const longPeriodSpecialStudyAdvisory = typeof responseSpectrum?.longPeriodSpecialStudyAdvisory === 'object' && responseSpectrum.longPeriodSpecialStudyAdvisory
    ? (responseSpectrum.longPeriodSpecialStudyAdvisory as Record<string, unknown>)
    : null
  const longPeriodGoverningMode = typeof longPeriodSpecialStudyAdvisory?.governingMode === 'object' && longPeriodSpecialStudyAdvisory.governingMode
    ? (longPeriodSpecialStudyAdvisory.governingMode as Record<string, unknown>)
    : null
  const responseSpectrumFinalCompliance = typeof data.responseSpectrumFinalCompliance === 'object' && data.responseSpectrumFinalCompliance
    ? (data.responseSpectrumFinalCompliance as Record<string, unknown>)
    : typeof responseSpectrum?.finalCompliance === 'object' && responseSpectrum.finalCompliance
      ? (responseSpectrum.finalCompliance as Record<string, unknown>)
      : null
  const elasticStoryDriftFinalCompliance = typeof data.elasticStoryDriftFinalCompliance === 'object' && data.elasticStoryDriftFinalCompliance
    ? (data.elasticStoryDriftFinalCompliance as Record<string, unknown>)
    : null
  const periodRangeAssessment = typeof data.periodRangeAssessment === 'object' && data.periodRangeAssessment
    ? (data.periodRangeAssessment as Record<string, unknown>)
    : typeof responseSpectrum?.periodRangeAssessment === 'object' && responseSpectrum.periodRangeAssessment
      ? (responseSpectrum.periodRangeAssessment as Record<string, unknown>)
      : null
  const regularityAssessment = typeof data.regularityAssessment === 'object' && data.regularityAssessment ? (data.regularityAssessment as Record<string, unknown>) : null
  const timeHistory = typeof data.timeHistory === 'object' && data.timeHistory ? (data.timeHistory as Record<string, unknown>) : null
  const directionResults = Array.isArray(data.directionResults)
    ? data.directionResults.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    : []
  const timeHistoryCombinationSummary = typeof timeHistory?.combinationSummary === 'object' && timeHistory.combinationSummary
    ? (timeHistory.combinationSummary as Record<string, unknown>)
    : null
  const timeHistoryControllingStory = typeof timeHistory?.controllingStory === 'object' && timeHistory.controllingStory ? (timeHistory.controllingStory as Record<string, unknown>) : null
  const elasticPlasticTimeHistory = typeof data.elasticPlasticTimeHistory === 'object' && data.elasticPlasticTimeHistory ? (data.elasticPlasticTimeHistory as Record<string, unknown>) : null
  const elasticPlasticTimeHistoryFinalCompliance = typeof elasticPlasticTimeHistory?.finalCompliance === 'object' && elasticPlasticTimeHistory.finalCompliance ? (elasticPlasticTimeHistory.finalCompliance as Record<string, unknown>) : null
  const elasticPlasticPerformanceObjective = typeof elasticPlasticTimeHistoryFinalCompliance?.performanceObjective === 'object' && elasticPlasticTimeHistoryFinalCompliance.performanceObjective ? (elasticPlasticTimeHistoryFinalCompliance.performanceObjective as Record<string, unknown>) : null
  const elasticPlasticTimeHistoryParameters = typeof elasticPlasticTimeHistory?.parameters === 'object' && elasticPlasticTimeHistory.parameters ? (elasticPlasticTimeHistory.parameters as Record<string, unknown>) : null
  const nonlinearModelAudit = typeof elasticPlasticTimeHistory?.nonlinearModelAudit === 'object' && elasticPlasticTimeHistory.nonlinearModelAudit ? (elasticPlasticTimeHistory.nonlinearModelAudit as Record<string, unknown>) : null
  const elasticPlasticControllingHinge = typeof elasticPlasticTimeHistory?.controllingHinge === 'object' && elasticPlasticTimeHistory.controllingHinge ? (elasticPlasticTimeHistory.controllingHinge as Record<string, unknown>) : null
  const seismicDesignActions = typeof data.seismicDesignActions === 'object' && data.seismicDesignActions ? (data.seismicDesignActions as Record<string, unknown>) : null
  const memberDesignActionCombinations = typeof data.memberDesignActionCombinations === 'object' && data.memberDesignActionCombinations ? (data.memberDesignActionCombinations as Record<string, unknown>) : null
  const verticalSeismic = typeof data.verticalSeismic === 'object' && data.verticalSeismic ? (data.verticalSeismic as Record<string, unknown>) : null
  const verticalOpenSeesStatic = typeof verticalSeismic?.openSeesStatic === 'object' && verticalSeismic.openSeesStatic ? (verticalSeismic.openSeesStatic as Record<string, unknown>) : null
  const pushover = typeof data.pushover === 'object' && data.pushover ? (data.pushover as Record<string, unknown>) : null
  const pushoverCapacity = typeof pushover?.capacityAssessment === 'object' && pushover.capacityAssessment ? (pushover.capacityAssessment as Record<string, unknown>) : null
  const pushoverPerformancePoint = typeof pushoverCapacity?.performancePoint === 'object' && pushoverCapacity.performancePoint ? (pushoverCapacity.performancePoint as Record<string, unknown>) : null
  const pushoverCapacityIteration = typeof pushoverCapacity?.capacitySpectrumIteration === 'object' && pushoverCapacity.capacitySpectrumIteration ? (pushoverCapacity.capacitySpectrumIteration as Record<string, unknown>) : null
  const pushoverNonlinearEstimate = typeof pushover?.nonlinearEstimate === 'object' && pushover.nonlinearEstimate ? (pushover.nonlinearEstimate as Record<string, unknown>) : null
  const pushoverNonlinearParameters = typeof pushoverNonlinearEstimate?.parameters === 'object' && pushoverNonlinearEstimate.parameters ? (pushoverNonlinearEstimate.parameters as Record<string, unknown>) : null
  const pushoverNonlinearPerformancePoint = typeof pushoverNonlinearEstimate?.performancePoint === 'object' && pushoverNonlinearEstimate.performancePoint ? (pushoverNonlinearEstimate.performancePoint as Record<string, unknown>) : null
  const pushoverControllingStory = typeof pushoverNonlinearEstimate?.controllingStory === 'object' && pushoverNonlinearEstimate.controllingStory ? (pushoverNonlinearEstimate.controllingStory as Record<string, unknown>) : null
  const pushoverControllingHinge = typeof pushoverNonlinearEstimate?.controllingHinge === 'object' && pushoverNonlinearEstimate.controllingHinge ? (pushoverNonlinearEstimate.controllingHinge as Record<string, unknown>) : null
  const pushoverFinalCompliance = typeof pushover?.finalCompliance === 'object' && pushover.finalCompliance ? (pushover.finalCompliance as Record<string, unknown>) : null
  const pushoverPerformanceObjective = typeof pushoverFinalCompliance?.performanceObjective === 'object' && pushoverFinalCompliance.performanceObjective ? (pushoverFinalCompliance.performanceObjective as Record<string, unknown>) : null
  const groundMotionRequirement = typeof data.groundMotionRequirement === 'object' && data.groundMotionRequirement ? (data.groundMotionRequirement as Record<string, unknown>) : null
  const spectrumMatch = typeof timeHistory?.spectrumMatch === 'object' && timeHistory.spectrumMatch ? (timeHistory.spectrumMatch as Record<string, unknown>) : null
  const missingInputs = Array.isArray(data.missingInputs)
    ? data.missingInputs.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : Array.isArray(designBasis?.missingInputs)
      ? designBasis.missingInputs.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []
  const missingCapabilities = Array.isArray(data.missingCapabilities)
    ? data.missingCapabilities.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const workflowInputMode = typeof data.workflowInputMode === 'string'
    ? data.workflowInputMode.trim()
    : ''
  let workflowInputModeLabel = workflowInputMode
  if (workflowInputMode === 'structured_seismic_workflow') {
    workflowInputModeLabel = t('analysisOverviewWorkflowInputModeStructured')
  } else if (workflowInputMode === 'legacy_compatibility_parameters') {
    workflowInputModeLabel = t('analysisOverviewWorkflowInputModeLegacy')
  }
  const directionalTimeHistorySummaries = directionResults
    .map((result, index) => {
      const direction = typeof result.direction === 'string' && result.direction.trim() ? result.direction.trim() : `D${index + 1}`
      const directionalTimeHistory = typeof result.timeHistory === 'object' && result.timeHistory && !Array.isArray(result.timeHistory)
        ? (result.timeHistory as Record<string, unknown>)
        : null
      if (!directionalTimeHistory) return null
      const records = Array.isArray(directionalTimeHistory.records)
        ? directionalTimeHistory.records.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
        : []
      const ratios = records
        .map((record) => finiteNumber(record.baseShearRatioToResponseSpectrum))
        .filter((value): value is number => value !== null)
      const combinationSummary = typeof directionalTimeHistory.combinationSummary === 'object' && directionalTimeHistory.combinationSummary && !Array.isArray(directionalTimeHistory.combinationSummary)
        ? (directionalTimeHistory.combinationSummary as Record<string, unknown>)
        : null
      const combinedBaseShear = finiteNumber(combinationSummary?.combinedBaseShear) ?? finiteNumber(directionalTimeHistory.combinedBaseShear)
      const minRatio = ratios.length > 0 ? Math.min(...ratios) : null
      return {
        direction,
        recordCount: records.length,
        minRatio,
        combinedBaseShear,
      }
    })
    .filter((item): item is { direction: string; recordCount: number; minRatio: number | null; combinedBaseShear: number | null } => item !== null)
  const elasticPlasticRecords = Array.isArray(elasticPlasticTimeHistory?.records)
    ? elasticPlasticTimeHistory.records.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    : []
  const elasticPlasticStoryResponses = elasticPlasticRecords.flatMap((record) => (
    Array.isArray(record.storyResponses)
      ? record.storyResponses.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      : []
  ))
  const controllingElasticPlasticStory = elasticPlasticStoryResponses.reduce<Record<string, unknown> | null>((acc, item) => {
    const current = finiteNumber(item.maxDriftRatio) ?? -1
    const previous = acc ? finiteNumber(acc.maxDriftRatio) ?? -1 : -1
    return current > previous ? item : acc
  }, null)

  return {
    data,
    meta,
    summary,
    modelSummary,
    envelope,
    methodDecision,
    specialSystemReview,
    structuredReviewEntries,
    designBasis,
    codeBasis,
    gb18306Basis,
    groundMotionZonation,
    fortificationCategoryLabel,
    responseSpectrum,
    minimumStoryShearAdjustment,
    longPeriodSpecialStudyAdvisory,
    longPeriodGoverningMode,
    responseSpectrumFinalCompliance,
    elasticStoryDriftFinalCompliance,
    periodRangeAssessment,
    regularityAssessment,
    timeHistory,
    directionResults,
    timeHistoryCombinationSummary,
    timeHistoryControllingStory,
    elasticPlasticTimeHistory,
    elasticPlasticTimeHistoryFinalCompliance,
    elasticPlasticPerformanceObjective,
    elasticPlasticTimeHistoryParameters,
    nonlinearModelAudit,
    elasticPlasticControllingHinge,
    seismicDesignActions,
    memberDesignActionCombinations,
    verticalSeismic,
    verticalOpenSeesStatic,
    pushover,
    pushoverCapacity,
    pushoverPerformancePoint,
    pushoverCapacityIteration,
    pushoverNonlinearEstimate,
    pushoverNonlinearParameters,
    pushoverNonlinearPerformancePoint,
    pushoverControllingStory,
    pushoverControllingHinge,
    pushoverFinalCompliance,
    pushoverPerformanceObjective,
    groundMotionRequirement,
    spectrumMatch,
    missingInputs,
    missingCapabilities,
    workflowInputMode,
    workflowInputModeLabel,
    directionalTimeHistorySummaries,
    elasticPlasticRecords,
    elasticPlasticStoryResponses,
    controllingElasticPlasticStory,
  }
}

export type SummaryStatsContext = ReturnType<typeof buildSummaryStatsContext>
