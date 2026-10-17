import { useEffect, useMemo, useRef, useState } from 'react'
import { buildVisualizationSnapshot } from '@/components/visualization/adapter'
import type { VisualizationSnapshot } from '@/components/visualization/types'
import type { MessageKey } from '@/lib/i18n'
import type { ConversationRuntimeSnapshot } from '../use-conversation-runtime'
import type { ConversationSummary, Message } from './types'
import { saveConversationSnapshotToBackend } from './backend-sync'
import { buildModelVisualizationTitle, parseModelJson } from './result-utils'

/**
 * The editable model JSON (context tab) and its live visualization preview.
 */
export function useModelDraft({
  t,
  conversationId,
  messages,
  mergedConversations,
  sessionView,
}: {
  t: (key: MessageKey) => string
  conversationId: string
  messages: Message[]
  mergedConversations: ConversationSummary[]
  sessionView: ConversationRuntimeSnapshot | null
}) {
  const [modelText, setModelText] = useState('')
  const modelEditedRef = useRef(false)
  const modelEditSequenceRef = useRef(0)
  const displayedModelRevisionRef = useRef<number | null>(0)
  const [modelSyncMessage, setModelSyncMessage] = useState('')
  const [latestModelVisualizationSnapshot, setLatestModelVisualizationSnapshot] = useState<VisualizationSnapshot | null>(null)
  useEffect(() => {
    if (sessionView && !sessionView.busy && !modelEditedRef.current && displayedModelRevisionRef.current === null) {
      displayedModelRevisionRef.current = sessionView.modelRevision
    }
  }, [sessionView])

  const parsedComposerModelState = useMemo(() => parseModelJson(modelText, t), [modelText, t])
  const parsedComposerModel = parsedComposerModelState.model
  const parsedComposerModelError = parsedComposerModelState.error || ''
  const modelPreviewBaseTitle = useMemo(
    () =>
      messages.find((message) => message.role === 'user')?.content.slice(0, 48)
      || mergedConversations.find((conversation) => conversation.id === conversationId)?.title
      || t('untitledConversation'),
    [conversationId, mergedConversations, messages, t]
  )

  useEffect(() => {
    if (!parsedComposerModel) {
      return
    }

    const snapshot = buildVisualizationSnapshot({
      title: buildModelVisualizationTitle(modelPreviewBaseTitle, t),
      model: parsedComposerModel,
      mode: 'model-only',
    })
    setLatestModelVisualizationSnapshot(snapshot)
    // 保存模型快照到后端
    if (snapshot && conversationId) {
      saveConversationSnapshotToBackend(conversationId, {
        modelSnapshot: snapshot,
      })
    }
  }, [conversationId, modelPreviewBaseTitle, parsedComposerModel, t])

  return {
    modelText,
    setModelText,
    modelEditedRef,
    modelEditSequenceRef,
    displayedModelRevisionRef,
    modelSyncMessage,
    setModelSyncMessage,
    latestModelVisualizationSnapshot,
    setLatestModelVisualizationSnapshot,
    parsedComposerModel,
    parsedComposerModelError,
    modelPreviewBaseTitle,
  }
}
