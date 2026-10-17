import type { VisualizationSnapshot } from '@/components/visualization/types'
import type { MessageKey } from '@/lib/i18n'
import type { AgentResult, ConversationSummary, Message, PanelTab, PersistedConversation } from './types'
import { sanitizePersistedConversation } from './snapshot-utils'

/** Builds the local archive entry for the active conversation from the live console state. */
export function buildActiveConversationArchiveEntry(
  current: Record<string, PersistedConversation>,
  params: {
    conversationId: string
    serverConversations: ConversationSummary[]
    messages: Message[]
    t: (key: MessageKey) => string
    conversationActivityAt: Record<string, string>
    modelText: string
    selectedSkillIds: string[]
    selectedToolIds: string[]
    hasExplicitSkillSelection: boolean
    hasExplicitToolSelection: boolean
    modelSyncMessage: string
    activePanel: PanelTab
    latestResult: AgentResult | null
    latestModelVisualizationSnapshot: VisualizationSnapshot | null
    latestResultVisualizationSnapshot: VisualizationSnapshot | null
  },
): PersistedConversation {
  const {
    conversationId,
    serverConversations,
    messages,
    t,
    conversationActivityAt,
    modelText,
    selectedSkillIds,
    selectedToolIds,
    hasExplicitSkillSelection,
    hasExplicitToolSelection,
    modelSyncMessage,
    activePanel,
    latestResult,
    latestModelVisualizationSnapshot,
    latestResultVisualizationSnapshot,
  } = params
  const nextEntry = sanitizePersistedConversation({
    id: conversationId,
    title:
      current[conversationId]?.title
      || serverConversations.find((conversation) => conversation.id === conversationId)?.title
      || messages.find((message) => message.role === 'user')?.content.slice(0, 48)
      || t('untitledConversation'),
    type: 'general',
    createdAt:
      current[conversationId]?.createdAt
      || serverConversations.find((conversation) => conversation.id === conversationId)?.createdAt
      || new Date().toISOString(),
    updatedAt:
      conversationActivityAt[conversationId]
      || current[conversationId]?.updatedAt
      || serverConversations.find((conversation) => conversation.id === conversationId)?.updatedAt
      || current[conversationId]?.createdAt
      || serverConversations.find((conversation) => conversation.id === conversationId)?.createdAt
      || new Date().toISOString(),
    messages,
    modelText,
    selectedSkillIds,
    selectedToolIds,
    hasExplicitSkillSelection,
    hasExplicitToolSelection,
    modelSyncMessage,
    activePanel,
    latestResult: latestResult ?? current[conversationId]?.latestResult ?? null,
    modelVisualizationSnapshot:
      latestModelVisualizationSnapshot
      ?? current[conversationId]?.modelVisualizationSnapshot
      ?? null,
    resultVisualizationSnapshot:
      latestResultVisualizationSnapshot
      ?? current[conversationId]?.resultVisualizationSnapshot
      ?? current[conversationId]?.visualizationSnapshot
      ?? null,
    visualizationSnapshot:
      latestResultVisualizationSnapshot
      ?? current[conversationId]?.resultVisualizationSnapshot
      ?? current[conversationId]?.visualizationSnapshot
      ?? null,
    staleStructuralData: current[conversationId]?.staleStructuralData ?? false,
  })

  return nextEntry
}
