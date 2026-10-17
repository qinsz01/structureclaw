import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { formatNumber } from '@/lib/utils'
import type { AgentResult, SeismicContextRow, SeismicContextSummary } from './types'
import { extractAnalysis, asRecord } from './result-utils'

export function formatSeismicContextValue(value: unknown, locale: AppLocale): string {
  if (value === undefined || value === null) return 'N/A'
  if (typeof value === 'number' && Number.isFinite(value)) return formatNumber(value, locale)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return value.trim() || 'N/A'
  if (Array.isArray(value)) return value.map((item) => formatSeismicContextValue(item, locale)).join(', ')
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return 'N/A'
    }
  }
  return String(value)
}

export function formatWorkflowInputMode(value: unknown, t: (key: MessageKey) => string): string {
  const workflowInputMode = typeof value === 'string' ? value.trim() : ''
  if (workflowInputMode === 'structured_seismic_workflow') return t('analysisOverviewWorkflowInputModeStructured')
  if (workflowInputMode === 'legacy_compatibility_parameters') return t('analysisOverviewWorkflowInputModeLegacy')
  return workflowInputMode || 'N/A'
}

export function extractSeismicContext(
  result: AgentResult | null,
  t: (key: MessageKey) => string,
  locale: AppLocale
): SeismicContextSummary | null {
  const analysis = extractAnalysis(result)
  if (!analysis) return null
  const data = asRecord(analysis.data) ?? analysis
  const designBasis = asRecord(data.designBasis)
  const methodDecision = asRecord(data.methodDecision)
  const groundMotionRequirement = asRecord(data.groundMotionRequirement)
  const regularityAssessment = asRecord(data.regularityAssessment)
  if (!designBasis && !methodDecision && !groundMotionRequirement) return null

  const missingInputs = Array.isArray(data.missingInputs)
    ? data.missingInputs.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : Array.isArray(designBasis?.missingInputs)
      ? designBasis.missingInputs.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []
  const selectedMethods = Array.isArray(methodDecision?.selectedMethods)
    ? methodDecision.selectedMethods.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join(', ')
    : formatSeismicContextValue(methodDecision?.primaryMethod, locale)
  const directions = Array.isArray(asRecord(data.summary)?.directions)
    ? (asRecord(data.summary)?.directions as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join(', ')
    : ''
  const sourceTrace = Array.isArray(data.sourceTrace)
    ? data.sourceTrace
    : Array.isArray(designBasis?.sourceTrace)
      ? designBasis.sourceTrace
      : []
  const traceRows = sourceTrace
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    .map((item) => ({
      label: formatSeismicContextValue(item.field, locale),
      value: formatSeismicContextValue(item.value, locale),
      source: [
        formatSeismicContextValue(item.sourceType, locale),
        formatSeismicContextValue(item.source, locale),
      ].filter((part) => part && part !== 'N/A').join(' / '),
      note: typeof item.note === 'string' && item.note.trim() ? item.note.trim() : undefined,
      assumed: item.assumed === true,
    }))
    .slice(0, 24)

  const fallbackRows: SeismicContextRow[] = [
    { label: t('analysisOverviewSeismicIntensity'), value: formatSeismicContextValue(designBasis?.intensity, locale) },
    { label: t('analysisOverviewSeismicEarthquakeLevel'), value: formatSeismicContextValue(designBasis?.earthquakeLevel, locale) },
    { label: t('analysisOverviewSeismicSiteCategory'), value: formatSeismicContextValue(designBasis?.siteCategory, locale) },
    { label: t('analysisOverviewSeismicGrade'), value: formatSeismicContextValue(designBasis?.seismicGrade, locale), source: formatSeismicContextValue(designBasis?.seismicGradeSource, locale) },
    { label: t('analysisOverviewSeismicRegularity'), value: formatSeismicContextValue(regularityAssessment?.classification, locale), source: formatSeismicContextValue(regularityAssessment?.source, locale) },
    { label: t('analysisOverviewGroundMotionRequirement'), value: groundMotionRequirement ? formatSeismicContextValue(groundMotionRequirement, locale) : 'N/A' },
  ].filter((row) => row.value !== 'N/A')

  return {
    status: (data.isPreliminary === true || designBasis?.isPreliminary === true || missingInputs.length > 0)
      ? t('analysisOverviewSeismicPreliminary')
      : '',
    summaryRows: [
      { label: t('analysisOverviewWorkflowInputMode'), value: formatWorkflowInputMode(data.workflowInputMode, t) },
      { label: t('analysisOverviewSeismicMethods'), value: selectedMethods },
      ...(directions ? [{ label: t('analysisOverviewSeismicDirections'), value: directions }] : []),
      ...(missingInputs.length > 0 ? [{ label: t('analysisOverviewSeismicMissingInputs'), value: missingInputs.join(', ') }] : []),
    ].filter((row) => row.value && row.value !== 'N/A'),
    parameterRows: traceRows.length > 0 ? traceRows : fallbackRows,
  }
}
