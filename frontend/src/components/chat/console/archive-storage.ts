import type { Message, AgentResult, PersistedConversation, ConsoleUiPreferences } from './types'
import { sanitizePersistedConversation } from './snapshot-utils'

export const STORAGE_KEY = 'structureclaw.console.conversations'

export const CONSOLE_UI_PREFERENCES_STORAGE_KEY = 'structureclaw.console.ui-preferences'

export const ARCHIVE_STORAGE_MAX_CONVERSATIONS = 20

export const ARCHIVE_STORAGE_MAX_MESSAGES = 40

export const ARCHIVE_STORAGE_TEXT_LIMIT = 12000

export const ARCHIVE_STORAGE_REPORT_LIMIT = 30000

export const DEFAULT_CONSOLE_UI_PREFERENCES: ConsoleUiPreferences = {
  historyCollapsed: false,
}

export function loadConsoleUiPreferences(): ConsoleUiPreferences {
  if (typeof window === 'undefined') {
    return DEFAULT_CONSOLE_UI_PREFERENCES
  }

  try {
    const raw = window.localStorage.getItem(CONSOLE_UI_PREFERENCES_STORAGE_KEY)
    if (!raw) {
      return DEFAULT_CONSOLE_UI_PREFERENCES
    }
    const parsed = JSON.parse(raw) as Partial<ConsoleUiPreferences> | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return DEFAULT_CONSOLE_UI_PREFERENCES
    }

    return {
      historyCollapsed: typeof parsed.historyCollapsed === 'boolean'
        ? parsed.historyCollapsed
        : DEFAULT_CONSOLE_UI_PREFERENCES.historyCollapsed,
    }
  } catch {
    return DEFAULT_CONSOLE_UI_PREFERENCES
  }
}

export function saveConsoleUiPreferences(preferences: ConsoleUiPreferences) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(CONSOLE_UI_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    return
  }
}

export function isStorageQuotaError(error: unknown) {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
  }
  return error instanceof Error && (
    error.name === 'QuotaExceededError'
    || error.message.includes('exceeded the quota')
  )
}

export function truncateArchiveText(value: string | undefined, maxLength = ARCHIVE_STORAGE_TEXT_LIMIT) {
  if (typeof value !== 'string' || value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength)}\n...`
}

export function compactArchiveMessage(message: Message): Message {
  return {
    ...message,
    content: truncateArchiveText(message.content) || '',
    debugDetails: undefined,
    presentation: undefined,
    toolStep: message.toolStep
      ? {
          ...message.toolStep,
          output: undefined,
          args: undefined,
        }
      : undefined,
  }
}

export function compactArchiveResult(result: AgentResult | null | undefined): AgentResult | null {
  if (!result) {
    return null
  }

  return {
    response: truncateArchiveText(result.response),
    traceId: result.traceId,
    success: result.success,
    needsModelInput: result.needsModelInput,
    plan: result.plan,
    interaction: result.interaction,
    clarification: result.clarification,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    requestedEngineId: result.requestedEngineId,
    routing: result.routing,
    report: result.report
      ? {
          summary: truncateArchiveText(result.report.summary),
          markdown: truncateArchiveText(result.report.markdown, ARCHIVE_STORAGE_REPORT_LIMIT),
        }
      : undefined,
  }
}

export function archiveSortTime(conversation: PersistedConversation) {
  return conversation.updatedAt || conversation.createdAt || ''
}

export function compactConversationArchiveForStorage(
  archive: Record<string, PersistedConversation>,
): Record<string, PersistedConversation> {
  const entries = Object.values(archive)
    .sort((a, b) => archiveSortTime(b).localeCompare(archiveSortTime(a)))
    .slice(0, ARCHIVE_STORAGE_MAX_CONVERSATIONS)

  return Object.fromEntries(entries.map((conversation) => {
    const compacted = sanitizePersistedConversation({
      ...conversation,
      messages: (conversation.messages || [])
        .slice(-ARCHIVE_STORAGE_MAX_MESSAGES)
        .map((message) => compactArchiveMessage(message)),
      modelText: truncateArchiveText(conversation.modelText),
      latestResult: compactArchiveResult(conversation.latestResult),
      modelVisualizationSnapshot: null,
      resultVisualizationSnapshot: null,
      visualizationSnapshot: null,
    })
    return [compacted.id, compacted]
  }))
}

export function saveConversationArchiveToStorage(
  archive: Record<string, PersistedConversation>,
): Record<string, PersistedConversation> {
  if (typeof window === 'undefined') {
    return archive
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(archive))
    return archive
  } catch (error) {
    if (!isStorageQuotaError(error)) {
      return archive
    }
  }

  const compacted = compactConversationArchiveForStorage(archive)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(compacted))
    return compacted
  } catch {
    return archive
  }
}

export function loadConversationArchive(): Record<string, PersistedConversation> {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const migrated: Record<string, PersistedConversation> = {}

    Object.entries(parsed as Record<string, PersistedConversation>).forEach(([conversationId, value]) => {
      migrated[conversationId] = sanitizePersistedConversation(value as PersistedConversation)
    })

    return migrated
  } catch {
    return {}
  }
}
