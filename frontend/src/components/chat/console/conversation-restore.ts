import type { MessageKey } from '@/lib/i18n'
import type { ConversationDetail, Message, PersistedConversation } from './types'
import {
  mapToolNameToPhase,
  parsePersistedAttachments,
  parsePersistedDebugDetails,
  parsePersistedMessageStatus,
  parsePersistedPresentation,
  stripLegacyAbortedSuffix,
} from './persisted-messages'
import { pickPreferredLatestResult } from './result-utils'
import {
  buildResultSnapshotFromResult,
  isStaleStructuralResult,
  isStaleVisualizationSnapshot,
  pickPreferredResultSnapshot,
  toModelText,
  toModelTextFromSnapshot,
} from './snapshot-utils'

type BackendConversationMessage = NonNullable<ConversationDetail['messages']>[number]

/** Maps persisted backend messages (user / assistant / tool) to console messages. */
export function mapBackendConversationMessages(payloadMessages: BackendConversationMessage[]): Message[] {
  // Build a toolCallId → args index from assistant messages so
  // tool-role messages can recover their input parameters.
  const argsByToolCallId = new Map<string, Record<string, unknown>>()
  for (const msg of payloadMessages) {
    if (msg.role === 'assistant') {
      const toolCalls = (msg as any).toolCalls as Array<{ id?: string; name: string; args?: Record<string, unknown> }> | undefined
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (tc.id && tc.args) argsByToolCallId.set(tc.id, tc.args)
        }
      }
    }
  }

  const mapped = payloadMessages.flatMap((message): Message[] => {
  // Handle tool messages — these come from persistConversationWithState
  if (message.role === 'tool') {
    let restoredSkillId: string | undefined
    try {
      const parsed = JSON.parse(message.content)
      if (typeof parsed?.skillId === 'string') restoredSkillId = parsed.skillId
    } catch {}
    const toolCallId = (message as any).toolCallId || message.id
    return [{
      id: message.id,
      role: 'tool' as const,
      content: message.content,
      status: 'done' as const,
      timestamp: message.createdAt,
      toolStep: {
        id: toolCallId,
        phase: mapToolNameToPhase((message as any).name || 'unknown'),
        status: 'done' as const,
        tool: (message as any).name || 'unknown',
        title: (message as any).name || 'unknown',
        skillId: restoredSkillId,
        args: argsByToolCallId.get(toolCallId),
        output: message.content,
        completedAt: message.createdAt,
      },
    }]
  }
  // Handle assistant messages
  if (message.role === 'assistant') {
    const toolCalls = (message as any).toolCalls as Array<{ id?: string; name: string; args?: Record<string, unknown> }> | undefined
    const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0
    const presentation = parsePersistedPresentation(message.metadata)
    const mapped: Message = {
      id: message.id,
      role: 'assistant' as const,
      content: stripLegacyAbortedSuffix(message.content),
      status: parsePersistedMessageStatus(message.metadata, message.content),
      timestamp: message.createdAt,
      debugDetails: parsePersistedDebugDetails(message.metadata),
      presentation,
      ...(hasToolCalls ? { toolCalls } : {}),
    }
    return [mapped]
  }
  // User messages
  return [{
    id: message.id,
    role: 'user' as const,
    content: message.content,
    status: parsePersistedMessageStatus(message.metadata, message.content),
    timestamp: message.createdAt,
    debugDetails: parsePersistedDebugDetails(message.metadata),
    presentation: parsePersistedPresentation(message.metadata),
    attachments: parsePersistedAttachments(message.metadata),
  }]
})

  // Backend persistConversationWithState writes all messages in a
  // single createMany with explicit createdAt offsets, so the DB
  // already returns them in correct conversational order.
  return mapped
}

/**
 * Reconciles the backend conversation payload with the local archive entry and
 * returns the state to restore (stale structural data is dropped).
 */
export function resolveRestoredConversationState({
  payload,
  archived,
  backendMessages,
  initialAssistantMessage,
  t,
}: {
  payload: ConversationDetail | null
  archived: PersistedConversation | undefined
  backendMessages: Message[]
  initialAssistantMessage: Message
  t: (key: MessageKey) => string
}) {
  const archivedMessages = archived?.messages || []
  const archiveHasOnlyWelcome =
    archivedMessages.length > 0
    && archivedMessages.every((message) => message.id === 'welcome')

  const nextMessages =
    backendMessages.length > 0
      ? backendMessages
      : archivedMessages.length > 0 && !archiveHasOnlyWelcome
        ? archivedMessages
        : [initialAssistantMessage]
  const session = payload?.session
  const backendSnapshots = payload?.snapshots
  const backendUpdatedAt = payload?.updatedAt || payload?.createdAt || ''
  const archivedUpdatedAt = archived?.updatedAt || archived?.createdAt || ''
  const preferArchiveState = Boolean(archived && archivedUpdatedAt > backendUpdatedAt)
  const nextLatestResult = preferArchiveState
    ? pickPreferredLatestResult(archived?.latestResult, backendSnapshots?.latestResult)
    : pickPreferredLatestResult(backendSnapshots?.latestResult, archived?.latestResult)
  const nextActivePanel = archived?.activePanel || (nextLatestResult?.report?.markdown ? 'report' : 'analysis')
  const nextModelSyncMessage = session?.model ? t('modelSyncFromChat') : (archived?.modelSyncMessage || '')
  const nextModelSnapshot = preferArchiveState
    ? (archived?.modelVisualizationSnapshot ?? backendSnapshots?.modelSnapshot ?? null)
    : (backendSnapshots?.modelSnapshot ?? archived?.modelVisualizationSnapshot ?? null)
  const nextResultSnapshot = preferArchiveState
    ? (archived?.resultVisualizationSnapshot ?? archived?.visualizationSnapshot ?? backendSnapshots?.resultSnapshot ?? null)
    : (backendSnapshots?.resultSnapshot ?? archived?.resultVisualizationSnapshot ?? archived?.visualizationSnapshot ?? null)
  const backendResultSnapshot = backendSnapshots?.resultSnapshot ?? null
  const archivedResultSnapshot = archived?.resultVisualizationSnapshot ?? archived?.visualizationSnapshot ?? null
  const nextResolvedResultSnapshot = pickPreferredResultSnapshot(nextResultSnapshot, pickPreferredResultSnapshot(backendResultSnapshot, archivedResultSnapshot))
  const synthesizedResultSnapshot = buildResultSnapshotFromResult(
    nextLatestResult,
    payload?.title || archived?.title || t('untitledConversation'),
    session?.model || null
  )
  const nextFinalResultSnapshot = pickPreferredResultSnapshot(nextResolvedResultSnapshot, synthesizedResultSnapshot)
  const restoredModelText =
    toModelText(session?.model)
    || archived?.modelText
    || toModelText(nextLatestResult?.model)
    || toModelTextFromSnapshot(nextModelSnapshot)
    || toModelTextFromSnapshot(nextFinalResultSnapshot)
    || ''
  const hasStaleStructuralData =
    isStaleVisualizationSnapshot(nextModelSnapshot)
    || isStaleVisualizationSnapshot(nextFinalResultSnapshot)
    || isStaleStructuralResult(nextLatestResult)
  const authoritativeRuntime = session?.runtime
  const currentAnalysis = authoritativeRuntime ? authoritativeRuntime.analysis.current : true
  const currentReport = authoritativeRuntime ? authoritativeRuntime.report.current : true
  const safeLatestResult = hasStaleStructuralData ? null : nextLatestResult && {
    ...nextLatestResult, ...(!currentAnalysis ? { analysis: undefined, codeCheck: undefined, report: undefined } : {}),
    ...(!currentReport ? { report: undefined } : {}),
  }
  const safeModelSnapshot = hasStaleStructuralData ? null : nextModelSnapshot
  const safeResultSnapshot = hasStaleStructuralData || !currentAnalysis ? null : nextFinalResultSnapshot
  const safeModelText = hasStaleStructuralData ? '' : restoredModelText
  const safeModelSyncMessage = hasStaleStructuralData ? '' : nextModelSyncMessage
  const safeActivePanel = hasStaleStructuralData ? 'analysis' : nextActivePanel

  return {
    nextMessages,
    authoritativeRuntime,
    hasStaleStructuralData,
    safeLatestResult,
    safeModelSnapshot,
    safeResultSnapshot,
    safeModelText,
    safeModelSyncMessage,
    safeActivePanel,
  }
}
