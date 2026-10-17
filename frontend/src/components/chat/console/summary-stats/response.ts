import { formatNumber } from '@/lib/utils'
import { finiteNumber, stringList, type SummaryStatsContext } from './context'
import type { StatsBuilder } from './builder'

/** Response spectrum, drift, vertical seismic and elastic-plastic stats. */
export function addResponseStats(ctx: SummaryStatsContext, builder: StatsBuilder) {
  const { stats, t, locale, addNumberStat, addStringStat, yieldDriftStatValue } = builder
  const { summary, envelope, methodDecision, responseSpectrum, minimumStoryShearAdjustment, responseSpectrumFinalCompliance, elasticStoryDriftFinalCompliance, regularityAssessment, timeHistoryControllingStory, elasticPlasticTimeHistory, elasticPlasticTimeHistoryFinalCompliance, elasticPlasticPerformanceObjective, elasticPlasticTimeHistoryParameters, nonlinearModelAudit, elasticPlasticControllingHinge, seismicDesignActions, memberDesignActionCombinations, verticalSeismic, verticalOpenSeesStatic, controllingElasticPlasticStory } = ctx
  addStringStat(t('analysisOverviewSeismicRegularity'), summary?.regularityClassification ?? regularityAssessment?.classification)
  addStringStat(t('analysisOverviewResponseSpectrumFinalCompliance'), summary?.responseSpectrumFinalComplianceStatus ?? responseSpectrumFinalCompliance?.status)
  addNumberStat(t('analysisOverviewResponseSpectrumFinalComplianceUtilization'), summary?.responseSpectrumFinalComplianceUtilization ?? responseSpectrumFinalCompliance?.utilization)
  addStringStat(t('analysisOverviewElasticStoryDriftFinalCompliance'), summary?.elasticStoryDriftFinalComplianceStatus ?? elasticStoryDriftFinalCompliance?.status)
  addNumberStat(t('analysisOverviewElasticStoryDriftFinalComplianceUtilization'), summary?.elasticStoryDriftFinalComplianceUtilization ?? elasticStoryDriftFinalCompliance?.utilization)
  addNumberStat(t('analysisOverviewMaxBaseShear'), summary?.maxBaseShear ?? envelope?.maxBaseShear, ' N')
  addNumberStat(t('analysisOverviewMaxStoryDriftRatio'), summary?.maxStoryDriftRatio ?? envelope?.maxStoryDriftRatio)
  if (timeHistoryControllingStory) {
    const drift = finiteNumber(timeHistoryControllingStory.driftRatio)
    const story = typeof timeHistoryControllingStory.story === 'string' && timeHistoryControllingStory.story.trim()
      ? timeHistoryControllingStory.story.trim()
      : 'N/A'
    const record = typeof timeHistoryControllingStory.record === 'string' && timeHistoryControllingStory.record.trim()
      ? ` / ${timeHistoryControllingStory.record.trim()}`
      : ''
    stats.push({
      label: t('analysisOverviewTimeHistoryControlStory'),
      value: drift === null ? `${story}${record}` : `${story}: ${formatNumber(drift, locale)}${record}`,
    })
  }
  addNumberStat(t('analysisOverviewModalMassParticipation'), summary?.modalMassParticipationRatio ?? envelope?.modalMassParticipationRatio)
  addNumberStat(t('analysisOverviewMinStoryShearWeightRatio'), summary?.minStoryShearWeightRatio ?? envelope?.minStoryShearWeightRatio ?? responseSpectrum?.minStoryShearWeightRatio)
  if (minimumStoryShearAdjustment) {
    const status = typeof minimumStoryShearAdjustment.status === 'string' && minimumStoryShearAdjustment.status.trim()
      ? minimumStoryShearAdjustment.status.trim()
      : null
    const factor = finiteNumber(minimumStoryShearAdjustment.maxAdjustmentFactor)
    if (status || factor !== null) {
      stats.push({
        label: t('analysisOverviewMinimumShearAdjustment'),
        value: [
          status,
          factor === null ? null : formatNumber(factor, locale),
        ].filter(Boolean).join(' / '),
      })
    }
  }
  addNumberStat(t('analysisOverviewHorizontalSeismicMemberForces'), summary?.horizontalSeismicMemberForceCount ?? seismicDesignActions?.memberForceCount)
  addNumberStat(t('analysisOverviewSeismicCombinationCases'), summary?.memberDesignCombinationCaseCount ?? memberDesignActionCombinations?.caseCount)
  addNumberStat(t('analysisOverviewVerticalSeismicAction'), summary?.totalVerticalActionKN ?? verticalSeismic?.totalVerticalActionKN, ' kN')
  addNumberStat(t('analysisOverviewVerticalSeismicCoefficient'), verticalSeismic?.coefficient)
  addNumberStat(t('analysisOverviewVerticalSeismicMemberForces'), summary?.verticalSeismicMemberForceCount ?? verticalOpenSeesStatic?.memberForceCount)
  const verticalSeismicReasons = stringList(methodDecision?.verticalSeismicReasons)
  if (verticalSeismicReasons.length > 0) {
    addStringStat(t('analysisOverviewVerticalSeismicReasons'), verticalSeismicReasons.slice(0, 4).join('; '))
  }
  addStringStat(t('analysisOverviewElasticPlasticTimeHistory'), elasticPlasticTimeHistory?.status)
  addStringStat(t('analysisOverviewElasticPlasticModel'), elasticPlasticTimeHistory?.modelScope ?? elasticPlasticTimeHistory?.engineMode)
  addNumberStat(t('analysisOverviewElasticPlasticStoryCount'), elasticPlasticTimeHistoryParameters?.storyCount)
  addStringStat(t('analysisOverviewElasticPlasticYieldDrift'), yieldDriftStatValue(elasticPlasticTimeHistoryParameters))
  if (nonlinearModelAudit) {
    const auditStatus = typeof nonlinearModelAudit.status === 'string' && nonlinearModelAudit.status.trim()
      ? nonlinearModelAudit.status.trim()
      : 'N/A'
    const materialCount = finiteNumber(nonlinearModelAudit.materialModelCount)
    const hingeCount = finiteNumber(nonlinearModelAudit.memberPlasticHingeCount)
    stats.push({
      label: t('analysisOverviewNonlinearModelAudit'),
      value: `${auditStatus}: ${formatNumber(materialCount ?? 0, locale)}/${formatNumber(hingeCount ?? 0, locale)}`,
    })
  }
  if (controllingElasticPlasticStory) {
    const drift = finiteNumber(controllingElasticPlasticStory.maxDriftRatio)
    const story = typeof controllingElasticPlasticStory.story === 'string' && controllingElasticPlasticStory.story.trim()
      ? controllingElasticPlasticStory.story.trim()
      : 'N/A'
    stats.push({
      label: t('analysisOverviewElasticPlasticControlStory'),
      value: drift === null ? story : `${story}: ${formatNumber(drift, locale)}`,
    })
  }
  if (elasticPlasticControllingHinge) {
    const ductility = finiteNumber(elasticPlasticControllingHinge.ductility)
    const elementId = typeof elasticPlasticControllingHinge.elementId === 'string' && elasticPlasticControllingHinge.elementId.trim()
      ? elasticPlasticControllingHinge.elementId.trim()
      : typeof elasticPlasticControllingHinge.id === 'string' && elasticPlasticControllingHinge.id.trim()
        ? elasticPlasticControllingHinge.id.trim()
        : 'N/A'
    const end = typeof elasticPlasticControllingHinge.end === 'string' && elasticPlasticControllingHinge.end.trim()
      ? ` ${elasticPlasticControllingHinge.end.trim()}`
      : ''
    stats.push({
      label: t('analysisOverviewElasticPlasticControlHinge'),
      value: ductility === null ? `${elementId}${end}` : `${elementId}${end}: ${formatNumber(ductility, locale)}`,
    })
  }
  addNumberStat(t('analysisOverviewElasticPlasticMaxDrift'), elasticPlasticTimeHistory?.maxDriftRatio)
  addStringStat(t('analysisOverviewElasticPlasticFinalCompliance'), summary?.elasticPlasticTimeHistoryFinalComplianceStatus ?? elasticPlasticTimeHistoryFinalCompliance?.status)
  addNumberStat(t('analysisOverviewElasticPlasticFinalComplianceUtilization'), summary?.elasticPlasticTimeHistoryFinalComplianceUtilization ?? elasticPlasticTimeHistoryFinalCompliance?.utilization)
  if (elasticPlasticPerformanceObjective) {
    const name = typeof elasticPlasticPerformanceObjective.name === 'string' && elasticPlasticPerformanceObjective.name.trim()
      ? elasticPlasticPerformanceObjective.name.trim()
      : typeof elasticPlasticPerformanceObjective.source === 'string' && elasticPlasticPerformanceObjective.source.trim()
        ? elasticPlasticPerformanceObjective.source.trim()
        : 'N/A'
    const limit = finiteNumber(elasticPlasticPerformanceObjective.acceptanceDriftRatio)
    stats.push({
      label: t('analysisOverviewElasticPlasticPerformanceObjective'),
      value: limit === null ? name : `${name}: ${formatNumber(limit, locale)}`,
    })
  }
}
