import { stringList, type SummaryStatsContext } from './context'
import type { StatsBuilder } from './builder'

/** Seismic method, design basis, code status and structured review stats. */
export function addDesignBasisStats(ctx: SummaryStatsContext, builder: StatsBuilder) {
  const { stats, t, locale, addNumberStat, addStringStat } = builder
  const { data, summary, envelope, methodDecision, structuredReviewEntries, designBasis, gb18306Basis, groundMotionZonation, fortificationCategoryLabel, responseSpectrum, missingInputs, missingCapabilities, workflowInputModeLabel } = ctx
  const selectedMethods = methodDecision?.selectedMethods
  if (Array.isArray(selectedMethods) && selectedMethods.length > 0) {
    addStringStat(
      t('analysisOverviewSeismicMethods'),
      selectedMethods.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join(', ')
    )
  } else {
    addStringStat(t('analysisOverviewSeismicMethods'), methodDecision?.primaryMethod)
  }
  addStringStat(t('analysisOverviewWorkflowInputMode'), workflowInputModeLabel)
  const methodDecisionReasons = stringList(methodDecision?.reasons)
  if (methodDecisionReasons.length > 0) {
    addStringStat(t('analysisOverviewSeismicDecisionReasons'), methodDecisionReasons.slice(0, 4).join('; '))
  }
  const directions = Array.isArray(summary?.directions)
    ? summary.directions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  if (directions.length > 0) {
    addStringStat(t('analysisOverviewSeismicDirections'), directions.join(', '))
  }
  addStringStat(t('analysisOverviewModalCombination'), responseSpectrum?.modalCombination ?? envelope?.modalCombination)
  addStringStat(t('analysisOverviewSeismicRegion'), designBasis?.region)
  if (groundMotionZonation) {
    const source = typeof groundMotionZonation.source === 'string' && groundMotionZonation.source.trim()
      ? groundMotionZonation.source.trim()
      : 'N/A'
    const regionCode = typeof groundMotionZonation.regionCode === 'string' && groundMotionZonation.regionCode.trim()
      ? groundMotionZonation.regionCode.trim()
      : 'N/A'
    addStringStat(t('analysisOverviewGroundMotionZonation'), `${source}: ${regionCode}`)
  }
  if (gb18306Basis) {
    const revisionPlan = typeof gb18306Basis.revisionPlan === 'object' && gb18306Basis.revisionPlan
      ? (gb18306Basis.revisionPlan as Record<string, unknown>)
      : null
    const amendments = Array.isArray(gb18306Basis.amendments)
      ? gb18306Basis.amendments.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      : []
    const effectiveAmendment = amendments.find((item) => item.status === 'effective')
    const status = gb18306Basis.standardStatus === 'current'
      ? t('analysisOverviewStandardCurrent')
      : typeof gb18306Basis.standardStatus === 'string'
        ? gb18306Basis.standardStatus
        : ''
    const reviewConclusion = gb18306Basis.lastReviewConclusion === 'continue_valid'
      ? t('analysisOverviewStandardContinueValid')
      : typeof gb18306Basis.lastReviewConclusion === 'string'
        ? gb18306Basis.lastReviewConclusion
        : ''
    const reviewDate = typeof gb18306Basis.lastReviewDate === 'string' && gb18306Basis.lastReviewDate.trim()
      ? gb18306Basis.lastReviewDate.trim()
      : ''
    const revisionPlanNo = typeof revisionPlan?.planNo === 'string' && revisionPlan.planNo.trim()
      ? revisionPlan.planNo.trim()
      : ''
    const revisionStatus = revisionPlan?.status === 'drafting'
      ? t('analysisOverviewRevisionPlanDrafting')
      : typeof revisionPlan?.status === 'string'
        ? revisionPlan.status
        : ''
    const amendmentNo = typeof effectiveAmendment?.no === 'string' && effectiveAmendment.no.trim()
      ? effectiveAmendment.no.trim()
      : ''
    const amendmentEffectiveDate = typeof effectiveAmendment?.effectiveDate === 'string' && effectiveAmendment.effectiveDate.trim()
      ? effectiveAmendment.effectiveDate.trim()
      : ''
    const statusParts = [
      status,
      reviewDate || reviewConclusion ? [reviewDate, reviewConclusion].filter(Boolean).join(' ') : '',
      amendmentNo ? `${amendmentNo} ${t('analysisOverviewAmendmentEffective')} ${amendmentEffectiveDate || 'N/A'}` : '',
      revisionPlanNo ? `${revisionPlanNo} ${revisionStatus} (${t('analysisOverviewRevisionPlanNotDesignBasis')})` : '',
    ].filter((item) => item.trim().length > 0)
    if (statusParts.length > 0) {
      addStringStat(t('analysisOverviewGb18306Status'), statusParts.join(' / '))
    }
  }
  addNumberStat(t('analysisOverviewSeismicIntensity'), designBasis?.intensity)
  addStringStat(t('analysisOverviewSeismicEarthquakeLevel'), summary?.earthquakeLevel ?? designBasis?.earthquakeLevel)
  const localizedFortificationCategory = fortificationCategoryLabel?.[locale]
  const fortificationCategoryLabelValue = typeof localizedFortificationCategory === 'string' && localizedFortificationCategory.trim()
    ? localizedFortificationCategory.trim()
    : typeof designBasis?.fortificationCategory === 'string'
      ? designBasis.fortificationCategory.trim()
      : ''
  const fortificationCategoryClass = typeof designBasis?.fortificationCategoryCodeClass === 'string' && designBasis.fortificationCategoryCodeClass.trim()
    ? designBasis.fortificationCategoryCodeClass.trim()
    : ''
  if (fortificationCategoryLabelValue) {
    addStringStat(
      t('analysisOverviewFortificationCategory'),
      [fortificationCategoryLabelValue, fortificationCategoryClass].filter(Boolean).join(' / ')
    )
  }
  addNumberStat(t('analysisOverviewSeismicMeasureIntensity'), designBasis?.seismicMeasureIntensity)
  addNumberStat(t('analysisOverviewSeismicGrade'), designBasis?.seismicGrade)
  addStringStat(t('analysisOverviewSeismicGradeSource'), designBasis?.seismicGradeSource)
  addStringStat(t('analysisOverviewSeismicSiteCategory'), designBasis?.siteCategory)
  if (data.isPreliminary === true || designBasis?.isPreliminary === true || missingInputs.length > 0) {
    stats.push({ label: t('analysisOverviewSeismicStatus'), value: t('analysisOverviewSeismicPreliminary') })
  }
  if (missingInputs.length > 0) {
    stats.push({ label: t('analysisOverviewSeismicMissingInputs'), value: missingInputs.join(', ') })
  }
  if (missingCapabilities.length > 0) {
    stats.push({ label: t('analysisOverviewSeismicMissingCapabilities'), value: missingCapabilities.join(', ') })
  }
  const specialSystemReasons = stringList(methodDecision?.specialSystemReasons)
  if (specialSystemReasons.length > 0) {
    addStringStat(t('analysisOverviewSpecialSystemReasons'), specialSystemReasons.slice(0, 4).join('; '))
  }
  const structuredReviewSummaries = structuredReviewEntries
    .map(({ key, value }) => {
      const required = value.reviewRequired === true || value.required === true
      const status = typeof value.status === 'string' && value.status.trim()
        ? value.status.trim()
        : typeof value.reviewStatus === 'string' && value.reviewStatus.trim()
          ? value.reviewStatus.trim()
          : typeof value.approvalStatus === 'string' && value.approvalStatus.trim()
            ? value.approvalStatus.trim()
            : ''
      const reviewType = typeof value.reviewType === 'string' && value.reviewType.trim()
        ? value.reviewType.trim()
        : typeof value.type === 'string' && value.type.trim()
          ? value.type.trim()
          : key
      const approvalId = typeof value.approvalId === 'string' && value.approvalId.trim()
        ? value.approvalId.trim()
        : typeof value.reviewId === 'string' && value.reviewId.trim()
          ? value.reviewId.trim()
          : typeof value.reportId === 'string' && value.reportId.trim()
            ? value.reportId.trim()
            : ''
      if (!required && !status && !approvalId) return ''
      return [reviewType, required ? t('analysisOverviewRequired') : '', status, approvalId].filter(Boolean).join(' / ')
    })
    .filter((item) => item.length > 0)
  if (structuredReviewSummaries.length > 0) {
    addStringStat(t('analysisOverviewOverLimitSpecialReview'), structuredReviewSummaries.join('; '))
  }
}
