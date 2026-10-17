import { formatNumber } from '@/lib/utils'
import { finiteNumber, type SummaryStatsContext } from './context'
import type { StatsBuilder } from './builder'

/** Pushover capacity and nonlinear estimate stats. */
export function addPushoverStats(ctx: SummaryStatsContext, builder: StatsBuilder) {
  const { stats, t, locale, addNumberStat, addStringStat, yieldDriftStatValue } = builder
  const { summary, pushoverPerformancePoint, pushoverCapacityIteration, pushoverNonlinearEstimate, pushoverNonlinearParameters, pushoverNonlinearPerformancePoint, pushoverControllingStory, pushoverControllingHinge, pushoverFinalCompliance, pushoverPerformanceObjective } = ctx
  addNumberStat(t('analysisOverviewPushoverPerformanceDrift'), summary?.pushoverPerformanceDriftRatio ?? pushoverPerformancePoint?.driftRatio)
  addStringStat(t('analysisOverviewPushoverPerformancePointSource'), pushoverPerformancePoint?.source)
  if (pushoverCapacityIteration) {
    const status = typeof pushoverCapacityIteration.status === 'string' && pushoverCapacityIteration.status.trim()
      ? pushoverCapacityIteration.status.trim()
      : 'N/A'
    const iterationCount = finiteNumber(pushoverCapacityIteration.iterationCount)
    const period = finiteNumber(pushoverCapacityIteration.secantPeriodSec)
    stats.push({
      label: t('analysisOverviewPushoverCapacitySpectrumIteration'),
      value: `${status}: ${formatNumber(iterationCount ?? 0, locale)} / ${period === null ? 'N/A' : formatNumber(period, locale)} s`,
    })
  }
  addNumberStat(t('analysisOverviewPushoverNonlinearEstimateDrift'), summary?.pushoverNonlinearEstimateDriftRatio ?? pushoverNonlinearPerformancePoint?.driftRatio)
  addStringStat(t('analysisOverviewPushoverNonlinearModel'), pushoverNonlinearEstimate?.modelScope ?? pushoverNonlinearEstimate?.engineMode)
  addNumberStat(t('analysisOverviewPushoverNonlinearStoryCount'), pushoverNonlinearParameters?.storyCount)
  addStringStat(t('analysisOverviewPushoverYieldDrift'), yieldDriftStatValue(pushoverNonlinearParameters))
  if (pushoverControllingStory) {
    const drift = finiteNumber(pushoverControllingStory.driftRatio)
    const story = typeof pushoverControllingStory.story === 'string' && pushoverControllingStory.story.trim()
      ? pushoverControllingStory.story.trim()
      : 'N/A'
    stats.push({
      label: t('analysisOverviewPushoverNonlinearControlStory'),
      value: drift === null ? story : `${story}: ${formatNumber(drift, locale)}`,
    })
  }
  if (pushoverControllingHinge) {
    const ductility = finiteNumber(pushoverControllingHinge.ductility)
    const elementId = typeof pushoverControllingHinge.elementId === 'string' && pushoverControllingHinge.elementId.trim()
      ? pushoverControllingHinge.elementId.trim()
      : typeof pushoverControllingHinge.id === 'string' && pushoverControllingHinge.id.trim()
        ? pushoverControllingHinge.id.trim()
        : 'N/A'
    const end = typeof pushoverControllingHinge.end === 'string' && pushoverControllingHinge.end.trim()
      ? ` ${pushoverControllingHinge.end.trim()}`
      : ''
    stats.push({
      label: t('analysisOverviewPushoverNonlinearControlHinge'),
      value: ductility === null ? `${elementId}${end}` : `${elementId}${end}: ${formatNumber(ductility, locale)}`,
    })
  }
  addStringStat(t('analysisOverviewPushoverFinalCompliance'), summary?.pushoverFinalComplianceStatus ?? pushoverFinalCompliance?.status)
  addNumberStat(t('analysisOverviewPushoverFinalComplianceUtilization'), summary?.pushoverFinalComplianceUtilization ?? pushoverFinalCompliance?.utilization)
  if (pushoverPerformanceObjective) {
    const name = typeof pushoverPerformanceObjective.name === 'string' && pushoverPerformanceObjective.name.trim()
      ? pushoverPerformanceObjective.name.trim()
      : typeof pushoverPerformanceObjective.source === 'string' && pushoverPerformanceObjective.source.trim()
        ? pushoverPerformanceObjective.source.trim()
        : 'N/A'
    const limit = finiteNumber(pushoverPerformanceObjective.acceptanceDriftRatio)
    stats.push({
      label: t('analysisOverviewPushoverPerformanceObjective'),
      value: limit === null ? name : `${name}: ${formatNumber(limit, locale)}`,
    })
  }
}
