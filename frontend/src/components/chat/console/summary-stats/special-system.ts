import { formatNumber } from '@/lib/utils'
import { finiteNumber, stringList, type SummaryStatsContext } from './context'
import type { StatsBuilder } from './builder'

/** Special system audit and long-period special study stats. */
export function addSpecialSystemStats(ctx: SummaryStatsContext, builder: StatsBuilder) {
  const { stats, t, locale, addStringStat } = builder
  const { summary, specialSystemReview, longPeriodGoverningMode, periodRangeAssessment } = ctx
  if (specialSystemReview?.reviewRequired === true) {
    const systems = stringList(specialSystemReview.systems)
    const specialMissingInputs = stringList(specialSystemReview.missingInputs)
    const checkCount = finiteNumber(specialSystemReview.checkCount)
    const failedCheckCount = finiteNumber(specialSystemReview.failedCheckCount)
    if (systems.length > 0) {
      addStringStat(t('analysisOverviewSpecialSystemAuditSystems'), systems.join(', '))
    }
    if (specialMissingInputs.length > 0) {
      addStringStat(t('analysisOverviewSpecialSystemAuditMissingInputs'), specialMissingInputs.slice(0, 6).join(', '))
    }
    if (checkCount !== null || failedCheckCount !== null) {
      addStringStat(
        t('analysisOverviewSpecialSystemAuditChecks'),
        `${formatNumber(checkCount ?? 0, locale)} / ${formatNumber(failedCheckCount ?? 0, locale)} ${t('analysisOverviewFailed')}`
      )
    }
    const isolationEstimate = typeof specialSystemReview.isolationEquivalentLinearEstimate === 'object' && specialSystemReview.isolationEquivalentLinearEstimate
      ? (specialSystemReview.isolationEquivalentLinearEstimate as Record<string, unknown>)
      : null
    if (isolationEstimate?.status === 'estimated') {
      const finalCompliance = typeof isolationEstimate.finalCompliance === 'object' && isolationEstimate.finalCompliance
        ? (isolationEstimate.finalCompliance as Record<string, unknown>)
        : null
      const period = finiteNumber(isolationEstimate.periodSec)
      const displacement = finiteNumber(isolationEstimate.displacementDemandM)
      const status = typeof finalCompliance?.status === 'string' ? finalCompliance.status : ''
      addStringStat(
        t('analysisOverviewIsolationEquivalentEstimate'),
        `${period === null ? 'N/A' : `${formatNumber(period, locale)} s`} / ${displacement === null ? 'N/A' : `${formatNumber(displacement, locale)} m`}${status ? ` / ${status}` : ''}`
      )
    }
    const isolationTimeHistoryEstimate = typeof specialSystemReview.isolationLayerTimeHistoryEstimate === 'object' && specialSystemReview.isolationLayerTimeHistoryEstimate
      ? (specialSystemReview.isolationLayerTimeHistoryEstimate as Record<string, unknown>)
      : null
    if (isolationTimeHistoryEstimate?.status === 'estimated') {
      const finalCompliance = typeof isolationTimeHistoryEstimate.finalCompliance === 'object' && isolationTimeHistoryEstimate.finalCompliance
        ? (isolationTimeHistoryEstimate.finalCompliance as Record<string, unknown>)
        : null
      const displacement = finiteNumber(isolationTimeHistoryEstimate.maxDisplacementM)
      const baseShear = finiteNumber(isolationTimeHistoryEstimate.maxBaseShearKN)
      const status = typeof finalCompliance?.status === 'string' ? finalCompliance.status : ''
      addStringStat(
        t('analysisOverviewIsolationTimeHistoryEstimate'),
        `${displacement === null ? 'N/A' : `${formatNumber(displacement, locale)} m`} / ${baseShear === null ? 'N/A' : `${formatNumber(baseShear, locale)} kN`}${status ? ` / ${status}` : ''}`
      )
    }
    const energyDissipationEstimate = typeof specialSystemReview.energyDissipationEquivalentEstimate === 'object' && specialSystemReview.energyDissipationEquivalentEstimate
      ? (specialSystemReview.energyDissipationEquivalentEstimate as Record<string, unknown>)
      : null
    if (energyDissipationEstimate?.status === 'estimated') {
      const finalCompliance = typeof energyDissipationEstimate.finalCompliance === 'object' && energyDissipationEstimate.finalCompliance
        ? (energyDissipationEstimate.finalCompliance as Record<string, unknown>)
        : null
      const period = finiteNumber(energyDissipationEstimate.periodSec)
      const displacement = finiteNumber(energyDissipationEstimate.adjustedDisplacementDemandM)
      const status = typeof finalCompliance?.status === 'string' ? finalCompliance.status : ''
      addStringStat(
        t('analysisOverviewEnergyDissipationEquivalentEstimate'),
        `${period === null ? 'N/A' : `${formatNumber(period, locale)} s`} / ${displacement === null ? 'N/A' : `${formatNumber(displacement, locale)} m`}${status ? ` / ${status}` : ''}`
      )
    }
    const energyDissipationTimeHistoryEstimate = typeof specialSystemReview.energyDissipationTimeHistoryEstimate === 'object' && specialSystemReview.energyDissipationTimeHistoryEstimate
      ? (specialSystemReview.energyDissipationTimeHistoryEstimate as Record<string, unknown>)
      : null
    if (energyDissipationTimeHistoryEstimate?.status === 'estimated') {
      const finalCompliance = typeof energyDissipationTimeHistoryEstimate.finalCompliance === 'object' && energyDissipationTimeHistoryEstimate.finalCompliance
        ? (energyDissipationTimeHistoryEstimate.finalCompliance as Record<string, unknown>)
        : null
      const deformation = finiteNumber(energyDissipationTimeHistoryEstimate.maxDeviceDeformationM)
      const force = finiteNumber(energyDissipationTimeHistoryEstimate.maxDeviceForceKN)
      const status = typeof finalCompliance?.status === 'string' ? finalCompliance.status : ''
      addStringStat(
        t('analysisOverviewEnergyDissipationTimeHistoryEstimate'),
        `${deformation === null ? 'N/A' : `${formatNumber(deformation, locale)} m`} / ${force === null ? 'N/A' : `${formatNumber(force, locale)} kN`}${status ? ` / ${status}` : ''}`
      )
    }
  }
  if (summary?.periodSpecialStudyRequired === true || periodRangeAssessment?.requiresSpecialStudy === true) {
    const maxModePeriod = finiteNumber(periodRangeAssessment?.maxModePeriodSec)
    const maxCodePeriod = finiteNumber(periodRangeAssessment?.maxCodeSpectrumPeriodSec) ?? 6
    stats.push({
      label: t('analysisOverviewLongPeriodSpecialStudy'),
      value: maxModePeriod === null
        ? t('analysisOverviewRequired')
        : `${formatNumber(maxModePeriod, locale)} s / ${formatNumber(maxCodePeriod, locale)} s`,
    })
    if (longPeriodGoverningMode) {
      const mode = longPeriodGoverningMode.modeNumber ?? 'N/A'
      const period = finiteNumber(longPeriodGoverningMode.period)
      const alpha = finiteNumber(longPeriodGoverningMode.advisoryAlpha)
      stats.push({
        label: t('analysisOverviewLongPeriodAdvisory'),
        value: [
          `M${String(mode)}`,
          period === null ? null : `${formatNumber(period, locale)} s`,
          alpha === null ? null : formatNumber(alpha, locale),
        ].filter(Boolean).join(' / '),
      })
    }
  }
}
