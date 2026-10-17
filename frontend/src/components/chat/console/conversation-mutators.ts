import type { VisualizationSnapshot } from '@/components/visualization/types'
import { API_BASE } from '@/lib/api-base'
import type { AgentResult, ConversationSummary, Message } from './types'
import { sanitizePersistedConversation } from './snapshot-utils'
import type { ConsoleState } from './use-console-state'

/**
 * Conversation creation plus message/archive updates. Updates may target a
 * background conversation (a stream that is no longer in the foreground).
 */
export function createConversationMutators(state: ConsoleState) {
  const {
    conversationId,
    locale,
    t,
    setServerConversations,
    setConversationId,
    setConversationActivityAt,
    conversationIdRef,
    setMessages,
    setConversationArchive,
    serverConversations,
    messages,
    modelText,
    selectedSkillIds,
    selectedToolIds,
    hasExplicitSkillSelection,
    hasExplicitToolSelection,
    modelSyncMessage,
    activePanel,
  } = state

  async function ensureConversation(seedMessage: string) {
    if (conversationId) {
      return conversationId
    }

    const response = await fetch(`${API_BASE}/api/v1/chat/conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: seedMessage.slice(0, 48),
        type: 'general',
        locale,
      }),
    })

    if (!response.ok) {
      throw new Error(`${t('createConversationFailed')}: HTTP ${response.status}`)
    }

    const payload = await response.json()
    if (!payload?.id) {
      throw new Error(t('missingConversationId'))
    }

    const nextConversation: ConversationSummary = {
      id: payload.id as string,
      title: (payload.title as string) || seedMessage.slice(0, 48),
      type: (payload.type as string) || 'general',
      createdAt: payload.createdAt as string | undefined,
      updatedAt: payload.updatedAt as string | undefined,
    }

    setServerConversations((current) => {
      const deduped = current.filter((conversation) => conversation.id !== nextConversation.id)
      return [nextConversation, ...deduped]
    })
    setConversationId(payload.id)
    return payload.id as string
  }

  function markConversationActivity(targetConversationId: string | undefined) {
    if (!targetConversationId) {
      return
    }

    setConversationActivityAt((current) => ({
      ...current,
      [targetConversationId]: new Date().toISOString(),
    }))
  }

  function appendMessageForConversation(targetConvId: string, message: Message) {
    if (targetConvId === conversationIdRef.current) {
      setMessages((current) => [...current, message])
    } else {
      setConversationArchive((current) => {
        const existing = current[targetConvId]
        if (!existing) return current
        return {
          ...current,
          [targetConvId]: {
            ...existing,
            messages: [...existing.messages, message],
          },
        }
      })
    }
  }

  function replaceMessageForConversation(
    targetConvId: string,
    messageId: string,
    updater: (message: Message) => Message,
  ) {
    if (targetConvId === conversationIdRef.current) {
      setMessages((current) =>
        current.map((message) => (message.id === messageId ? updater(message) : message))
      )
    } else {
      setConversationArchive((current) => {
        const existing = current[targetConvId]
        if (!existing) return current
        return {
          ...current,
          [targetConvId]: {
            ...existing,
            messages: existing.messages.map((message) =>
              (message.id === messageId ? updater(message) : message)
            ),
          },
        }
      })
    }
  }

  function persistConversationSnapshotsToArchive(
    targetConversationId: string,
    params: {
      latestResult?: AgentResult | null
      modelSnapshot?: VisualizationSnapshot | null
      resultSnapshot?: VisualizationSnapshot | null
    }
  ) {
    if (!targetConversationId) {
      return
    }

    setConversationArchive((current) => {
      const existing = current[targetConversationId]
      const serverConversation = serverConversations.find((conversation) => conversation.id === targetConversationId)
      const resultSnapshot =
        params.resultSnapshot
        ?? existing?.resultVisualizationSnapshot
        ?? existing?.visualizationSnapshot
        ?? null
      const modelSnapshot =
        params.modelSnapshot
        ?? existing?.modelVisualizationSnapshot
        ?? null
      const latestResultValue =
        params.latestResult
        ?? existing?.latestResult
        ?? null

      const nextEntry = sanitizePersistedConversation({
        id: targetConversationId,
        title: existing?.title || serverConversation?.title || t('untitledConversation'),
        type: existing?.type || serverConversation?.type || 'general',
        createdAt: existing?.createdAt || serverConversation?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: existing?.messages || messages,
        modelText: existing?.modelText ?? modelText,
        selectedSkillIds: existing?.selectedSkillIds || selectedSkillIds,
        selectedToolIds: existing?.selectedToolIds || selectedToolIds,
        hasExplicitSkillSelection: existing?.hasExplicitSkillSelection ?? hasExplicitSkillSelection,
        hasExplicitToolSelection: existing?.hasExplicitToolSelection ?? hasExplicitToolSelection,
        modelSyncMessage: existing?.modelSyncMessage || modelSyncMessage,
        activePanel: existing?.activePanel || activePanel,
        latestResult: latestResultValue,
        modelVisualizationSnapshot: modelSnapshot,
        resultVisualizationSnapshot: resultSnapshot,
        visualizationSnapshot: resultSnapshot,
        staleStructuralData: existing?.staleStructuralData ?? false,
      })

      return {
        ...current,
        [targetConversationId]: nextEntry,
      }
    })
  }

  return {
    ensureConversation,
    markConversationActivity,
    appendMessageForConversation,
    replaceMessageForConversation,
    persistConversationSnapshotsToArchive,
  }
}

export type ConversationMutators = ReturnType<typeof createConversationMutators>
