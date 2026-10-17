import type { MessageKey } from '@/lib/i18n'
import type { AgentResult } from './types'

export function extractEngineLabel(
  analysis: Record<string, unknown> | null,
  result: AgentResult | null,
  t: (key: MessageKey) => string
) {
  if (!analysis) return null
  const meta = typeof analysis.meta === 'object' && analysis.meta ? (analysis.meta as Record<string, unknown>) : null
  if (!meta) return null

  const requestedEngineId = typeof result?.requestedEngineId === 'string' ? result.requestedEngineId.trim() : ''
  const engineName = typeof meta.engineName === 'string' ? meta.engineName.trim() : ''
  const engineVersion = typeof meta.engineVersion === 'string' ? meta.engineVersion.trim() : ''
  const engineId = typeof meta.engineId === 'string' ? meta.engineId.trim() : ''
  const selectionMode = typeof meta.selectionMode === 'string' ? meta.selectionMode.trim() : ''
  const fallbackFrom = typeof meta.fallbackFrom === 'string' ? meta.fallbackFrom.trim() : ''
  const unavailableReason = typeof meta.unavailableReason === 'string' ? meta.unavailableReason.trim() : ''

  if (!engineName && !engineVersion) {
    return null
  }

  const value = engineName && engineVersion ? `${engineName} v${engineVersion}` : engineName || engineVersion
  const modeLabel =
    selectionMode === 'manual'
      ? t('analysisEngineModeManual')
      : selectionMode === 'fallback'
        ? t('analysisEngineModeFallback')
        : t('analysisEngineModeAuto')
  return {
    label: t('analysisEngineLabel'),
    value,
    engineId,
    requestedEngineId,
    modeLabel,
    fallbackFrom,
    unavailableReason,
  }
}
