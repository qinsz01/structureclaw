import type { MessageKey } from '@/lib/i18n'
import type { AgentResult, VisualizationHintsPayload } from './types'
import { toObjectRecord } from './persisted-messages'

export function parseModelJson(modelText: string, t: (key: MessageKey) => string): { model?: Record<string, unknown>; error?: string } {
  const trimmed = modelText.trim()
  if (!trimmed) {
    return {}
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: t('modelJsonMustBeObject') }
    }
    return { model: parsed as Record<string, unknown> }
  } catch (error) {
    return {
      error: error instanceof Error ? `${t('modelJsonParseFailed')}: ${error.message}` : `${t('modelJsonParseFailed')}.`,
    }
  }
}

export function normalizeAgentResultPayload(result: AgentResult | null | undefined): AgentResult | null {
  if (!result || typeof result !== 'object') {
    return null
  }

  const record = result as Record<string, unknown>
  const wrapped = record.result
  if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
    const wrappedRecord = wrapped as Record<string, unknown>
    const hasTopLevelResultData = Boolean(
      result.analysis
      || result.data
      || result.model
      || result.response
      || result.report
    )
    const hasWrappedResultData = Boolean(
      wrappedRecord.analysis
      || wrappedRecord.data
      || wrappedRecord.model
      || wrappedRecord.response
      || wrappedRecord.report
    )
    if (!hasTopLevelResultData && hasWrappedResultData) {
      return wrapped as AgentResult
    }
  }

  return result
}

export function extractAnalysis(result: AgentResult | null) {
  if (!result) return null
  const normalized = normalizeAgentResultPayload(result)
  if (!normalized) return null
  if (normalized.analysis && typeof normalized.analysis === 'object') {
    return normalized.analysis
  }
  if (normalized.data && typeof normalized.data === 'object') {
    return normalized.data
  }
  return null
}

export function extractVisualizationHints(result: AgentResult | null): VisualizationHintsPayload | null {
  if (!result) {
    return null
  }

  const normalized = normalizeAgentResultPayload(result)
  if (!normalized) {
    return null
  }

  const directHints = toObjectRecord(normalized.visualizationHints)
  if (directHints) {
    return directHints as VisualizationHintsPayload
  }

  const reportRecord = toObjectRecord(normalized.report)
  const reportJson = toObjectRecord(reportRecord?.json)
  const jsonHints = toObjectRecord(reportJson?.visualizationHints)
  if (jsonHints) {
    return jsonHints as VisualizationHintsPayload
  }

  return null
}

export function hasAnalysisPayload(result: AgentResult | null | undefined) {
  return Boolean(extractAnalysis(result ?? null))
}

export function pickPreferredLatestResult(
  primary: AgentResult | null | undefined,
  secondary: AgentResult | null | undefined
) {
  const normalizedPrimary = normalizeAgentResultPayload(primary ?? null)
  const normalizedSecondary = normalizeAgentResultPayload(secondary ?? null)

  const primaryHasAnalysis = hasAnalysisPayload(normalizedPrimary)
  const secondaryHasAnalysis = hasAnalysisPayload(normalizedSecondary)

  if (primaryHasAnalysis && secondaryHasAnalysis) {
    return normalizedPrimary
  }
  if (primaryHasAnalysis) {
    return normalizedPrimary
  }
  if (secondaryHasAnalysis) {
    return normalizedSecondary
  }

  return normalizedPrimary ?? normalizedSecondary ?? null
}

export function buildVisualizationTitle(result: AgentResult | null, conversationTitle: string) {
  const analysis = extractAnalysis(result)
  const meta = analysis && typeof analysis.meta === 'object' && analysis.meta ? (analysis.meta as Record<string, unknown>) : null
  const analysisType = typeof meta?.analysisType === 'string' ? meta.analysisType : typeof analysis?.analysis_type === 'string' ? analysis.analysis_type : ''
  return analysisType ? `${conversationTitle} · ${analysisType}` : conversationTitle
}

export function buildModelVisualizationTitle(baseTitle: string, t: (key: MessageKey) => string) {
  return `${baseTitle} · ${t('visualizationSourceModel')}`
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
