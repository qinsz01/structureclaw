import type { AppLocale } from '@/lib/stores/slices/preferences'
import type { ToolCategory, CapabilityToolSummary } from './types'

export function normalizeToolCategory(value: unknown): ToolCategory {
  if (value === 'modeling' || value === 'analysis' || value === 'code-check' || value === 'report' || value === 'utility') {
    return value
  }
  return 'utility'
}

export function resolveToolLabel(tool: CapabilityToolSummary, locale: AppLocale) {
  const localized = locale === 'zh' ? (tool.displayName?.zh || tool.id) : (tool.displayName?.en || tool.id)
  if (localized && localized !== tool.id) {
    return localized
  }
  return tool.id
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
