import { formatNumber } from '@/lib/utils'
import { finiteNumber, type SummaryStatsContext } from './context'
import type { StatsBuilder } from './builder'

/** Ground motion requirement, spectrum match and time-history stats. */
export function addGroundMotionStats(ctx: SummaryStatsContext, builder: StatsBuilder) {
  const { stats, t, locale, addNumberStat, addStringStat } = builder
  const { summary, timeHistory, timeHistoryCombinationSummary, groundMotionRequirement, spectrumMatch, directionalTimeHistorySummaries } = ctx
  addNumberStat(t('analysisOverviewGroundMotionRecords'), summary?.groundMotionRecordCount)
  if (groundMotionRequirement?.required === true) {
    const requiredCount = finiteNumber(groundMotionRequirement.requiredCount)
    const totalRequiredCount = finiteNumber(groundMotionRequirement.totalRequiredCount)
    const providedCount = finiteNumber(groundMotionRequirement.providedCount)
    const missingCount = finiteNumber(groundMotionRequirement.missingCount)
    const requiredText = requiredCount === null ? 'N/A' : formatNumber(requiredCount, locale)
    const totalRequiredText = totalRequiredCount === null ? null : formatNumber(totalRequiredCount, locale)
    const providedText = providedCount === null ? 'N/A' : formatNumber(providedCount, locale)
    const missingText = missingCount === null ? 'N/A' : formatNumber(missingCount, locale)
    const directional = totalRequiredCount !== null && requiredCount !== null && totalRequiredCount !== requiredCount
    stats.push({
      label: t('analysisOverviewGroundMotionRequirement'),
      value: locale === 'zh'
        ? directional
          ? `每方向需 ${requiredText}，总需 ${totalRequiredText}，已提供 ${providedText}，缺少 ${missingText}`
          : `需 ${requiredText}，已提供 ${providedText}，缺少 ${missingText}`
        : directional
          ? `${requiredText} per direction, ${totalRequiredText} total, ${providedText} provided, ${missingText} missing`
          : `${requiredText} required, ${providedText} provided, ${missingText} missing`,
    })
  }
  const missingGroundMotionCount = groundMotionRequirement?.missingCount ?? summary?.missingGroundMotionCount
  if (typeof missingGroundMotionCount === 'number' && missingGroundMotionCount > 0) {
    addNumberStat(t('analysisOverviewMissingGroundMotionRecords'), missingGroundMotionCount)
  }
  const directionRequirements = Array.isArray(groundMotionRequirement?.directionRequirements)
    ? groundMotionRequirement.directionRequirements.filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
    )
    : []
  const missingDirectionRequirements = directionRequirements
    .map((item) => {
      const direction = typeof item.direction === 'string' && item.direction.trim() ? item.direction.trim().toUpperCase() : 'N/A'
      const missing = finiteNumber(item.missingCount)
      const required = finiteNumber(item.requiredCount)
      if (missing === null || missing <= 0) return null
      const missingText = formatNumber(missing, locale)
      const requiredText = required === null ? 'N/A' : formatNumber(required, locale)
      return locale === 'zh'
        ? `${direction}: 缺 ${missingText} / 需 ${requiredText}`
        : `${direction}: ${missingText} missing / ${requiredText} required`
    })
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
  if (missingDirectionRequirements.length > 0) {
    addStringStat(t('analysisOverviewMissingGroundMotionDirections'), missingDirectionRequirements.join('; '))
  }
  addNumberStat(t('analysisOverviewGroundMotionScaleFactor'), spectrumMatch?.maxScaleFactor)
  if (spectrumMatch) {
    const minAverageRatio = finiteNumber(spectrumMatch.averageModalSpectrumMinRatioToTarget)
    const limit = finiteNumber(spectrumMatch.modalSpectrumAverageMinRatio)
    const ok = typeof spectrumMatch.modalSpectrumAverageOk === 'boolean'
      ? spectrumMatch.modalSpectrumAverageOk
      : null
    if (minAverageRatio !== null || limit !== null || ok !== null) {
      const status = ok === null ? 'N/A' : ok ? 'pass' : 'fail'
      stats.push({
        label: t('analysisOverviewGroundMotionSpectrumCompatibility'),
        value: `${minAverageRatio === null ? 'N/A' : formatNumber(minAverageRatio, locale)} / ${limit === null ? 'N/A' : formatNumber(limit, locale)} / ${status}`,
      })
    }
  }
  addNumberStat(t('analysisOverviewCombinedBaseShear'), timeHistory?.combinedBaseShear, ' N')
  if (timeHistoryCombinationSummary) {
    const statistic = typeof timeHistoryCombinationSummary.timeHistoryStatistic === 'string' && timeHistoryCombinationSummary.timeHistoryStatistic.trim()
      ? timeHistoryCombinationSummary.timeHistoryStatistic.trim()
      : null
    const source = typeof timeHistoryCombinationSummary.governingSource === 'string' && timeHistoryCombinationSummary.governingSource.trim()
      ? timeHistoryCombinationSummary.governingSource.trim()
      : null
    const baseShear = finiteNumber(timeHistoryCombinationSummary.combinedBaseShear)
    if (statistic || source || baseShear !== null) {
      stats.push({
        label: t('analysisOverviewTimeHistoryCombination'),
        value: [
          statistic,
          source,
          baseShear === null ? null : formatNumber(baseShear, locale),
        ].filter(Boolean).join(' / '),
      })
    }
  }
  if (directionalTimeHistorySummaries.length > 0) {
    stats.push({
      label: t('analysisOverviewDirectionalTimeHistory'),
      value: directionalTimeHistorySummaries.slice(0, 4).map((item) => {
        const minRatio = item.minRatio === null ? 'N/A' : formatNumber(item.minRatio, locale)
        const baseShear = item.combinedBaseShear === null ? 'N/A' : `${formatNumber(item.combinedBaseShear, locale)} N`
        return locale === 'zh'
          ? `${item.direction}: ${formatNumber(item.recordCount, locale)}条 / 最小 ${minRatio} / ${baseShear}`
          : `${item.direction}: ${formatNumber(item.recordCount, locale)} records / min ${minRatio} / ${baseShear}`
      }).join('; '),
    })
  }
}
