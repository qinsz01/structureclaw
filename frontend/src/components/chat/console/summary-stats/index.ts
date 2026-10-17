import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { formatNumber } from '@/lib/utils'
import { buildSummaryStatsContext } from './context'
import { createStatsBuilder } from './builder'
import { addDesignBasisStats } from './design-basis'
import { addSpecialSystemStats } from './special-system'
import { addResponseStats } from './response'
import { addPushoverStats } from './pushover'
import { addGroundMotionStats } from './ground-motion'

export function extractSummaryStats(
  analysis: Record<string, unknown> | null,
  t: (key: MessageKey) => string,
  locale: AppLocale
) {
  if (!analysis) return []
  const ctx = buildSummaryStatsContext(analysis, t)
  const { summary, modelSummary, meta, designBasis } = ctx
  const builder = createStatsBuilder(t, locale)
  const { stats } = builder

  const candidatePairs: Array<[string, unknown]> = [
    [t('analysisOverviewCountsNodes'), summary?.nodeCount ?? modelSummary?.nodeCount ?? meta?.nodeCount],
    [t('analysisOverviewCountsElements'), summary?.elementCount ?? modelSummary?.elementCount ?? meta?.elementCount],
    [t('analysisOverviewCountsStories'), summary?.storyCount ?? modelSummary?.storyCount ?? designBasis?.storyCount],
    [t('analysisOverviewCountsLoadCases'), summary?.loadCaseCount ?? meta?.loadCaseCount],
    [t('analysisOverviewCountsCombinations'), summary?.combinationCount ?? meta?.combinationCount],
  ]

  candidatePairs.forEach(([label, value]) => {
    if (typeof value === 'number') {
      stats.push({ label, value: formatNumber(value, locale) })
    }
  })

  addDesignBasisStats(ctx, builder)
  addSpecialSystemStats(ctx, builder)
  addResponseStats(ctx, builder)
  addPushoverStats(ctx, builder)
  addGroundMotionStats(ctx, builder)

  return stats
}
