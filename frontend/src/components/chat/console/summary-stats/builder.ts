import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { formatNumber } from '@/lib/utils'
import { finiteNumber } from './context'

export type SummaryStat = { label: string; value: string }

/** Accumulates summary stats in insertion order; mirrors the original local helpers. */
export function createStatsBuilder(t: (key: MessageKey) => string, locale: AppLocale) {
  const stats: SummaryStat[] = []

  const addNumberStat = (label: string, value: unknown, suffix = '') => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    stats.push({ label, value: `${formatNumber(value, locale)}${suffix}` })
  }

  const addStringStat = (label: string, value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      stats.push({ label, value: value.trim() })
    }
  }
  const yieldDriftStatValue = (parameters: Record<string, unknown> | null) => {
    if (!parameters) return null
    const ratioText = typeof parameters.yieldDriftLimitRatioText === 'string' && parameters.yieldDriftLimitRatioText.trim()
      ? parameters.yieldDriftLimitRatioText.trim()
      : (() => {
          const ratio = finiteNumber(parameters.yieldDriftRatio)
          return ratio === null ? '' : formatNumber(ratio, locale)
        })()
    if (!ratioText) return null
    const family = typeof parameters.yieldDriftLimitFamily === 'string' && parameters.yieldDriftLimitFamily.trim()
      ? parameters.yieldDriftLimitFamily.trim()
      : ''
    const fallback = parameters.yieldDriftIsFallback === true ? ` / ${t('analysisOverviewFallback')}` : ''
    return `${ratioText}${family ? ` / ${family}` : ''}${fallback}`
  }

  return { stats, t, locale, addNumberStat, addStringStat, yieldDriftStatValue }
}

export type StatsBuilder = ReturnType<typeof createStatsBuilder>
