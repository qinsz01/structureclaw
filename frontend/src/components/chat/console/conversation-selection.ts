import { toast } from '@/components/ui/toast'
import { API_BASE } from '@/lib/api-base'
import { normalizeClarificationOptions } from '../clarification-options'
import type { ConversationDetail } from './types'
import { normalizeAgentResultPayload } from './result-utils'
import { sanitizePersistedConversation } from './snapshot-utils'
import { mapBackendConversationMessages, resolveRestoredConversationState } from './conversation-restore'
import type { ConsoleState } from './use-console-state'

/** Switching, resetting, ending turns in and deleting conversations. */
export function createConversationSelection(state: ConsoleState) {
  const {
    conversationId,
    conversationSelectionRef,
    setErrorMessage,
    setVisualizationOpen,
    conversationArchive,
    locale,
    t,
    initialAssistantMessage,
    setConversationId,
    conversationIdRef,
    setPendingOptions,
    setAttachedFiles,
    setMessages,
    setModelText,
    modelEditedRef,
    displayedModelRevisionRef,
    setModelSyncMessage,
    setLatestResult,
    setLatestModelVisualizationSnapshot,
    setLatestResultVisualizationSnapshot,
    setActivePanel,
    setConversationArchive,
    setRunPolicy,
    setInput,
    setVisualizationSource,
    setPendingDeleteConversationId,
    sessionRuntime,
    isStreaming,
    submittingRef,
    endingTurnConversationId,
    setEndingTurnConversationId,
    streamingSessions,
    deletingConversationId,
    setDeletingConversationId,
    deletedConversationIdsRef,
    mergedConversations,
    setServerConversations,
    setConversationActivityAt,
  } = state

  async function handleSelectConversation(nextConversationId: string) {
    if (nextConversationId === conversationId) {
      return
    }

    const selection = ++conversationSelectionRef.current
    setErrorMessage('')
    setVisualizationOpen(false)
    const archived = conversationArchive[nextConversationId]

    try {
      const response = await fetch(`${API_BASE}/api/v1/chat/conversation/${nextConversationId}?locale=${encodeURIComponent(locale)}`)
      if (!response.ok) {
        throw new Error(`${t('loadConversationFailed')}: HTTP ${response.status}`)
      }

      const payload = await response.json() as ConversationDetail | null
      if (selection !== conversationSelectionRef.current) return
      const backendMessages = Array.isArray(payload?.messages)
        ? mapBackendConversationMessages(payload.messages)
        : []
      const {
        nextMessages,
        authoritativeRuntime,
        hasStaleStructuralData,
        safeLatestResult,
        safeModelSnapshot,
        safeResultSnapshot,
        safeModelText,
        safeModelSyncMessage,
        safeActivePanel,
      } = resolveRestoredConversationState({ payload, archived, backendMessages, initialAssistantMessage, t })

      setConversationId(nextConversationId)
      conversationIdRef.current = nextConversationId
      setPendingOptions(authoritativeRuntime?.waitingForReply ? normalizeClarificationOptions(authoritativeRuntime.options) : [])
      setAttachedFiles([])
      setMessages(nextMessages)
      setModelText(safeModelText)
      modelEditedRef.current = false
      displayedModelRevisionRef.current = authoritativeRuntime?.modelRevision ?? null
      setModelSyncMessage(safeModelSyncMessage)
      setLatestResult(safeLatestResult)
      setLatestModelVisualizationSnapshot(safeModelSnapshot)
      setLatestResultVisualizationSnapshot(safeResultSnapshot)
      setActivePanel(safeActivePanel)

      if (hasStaleStructuralData) {
        setConversationArchive((current) => {
          const existing = current[nextConversationId]
          if (!existing) {
            return current
          }
          return {
            ...current,
            [nextConversationId]: sanitizePersistedConversation({
              ...existing,
              modelText: '',
              modelSyncMessage: '',
              activePanel: 'analysis',
              latestResult: null,
              modelVisualizationSnapshot: null,
              resultVisualizationSnapshot: null,
              visualizationSnapshot: null,
              staleStructuralData: true,
            }),
          }
        })
        toast.error(`${t('staleStructuralSessionTitle')}: ${t('staleStructuralSessionBody')}`)
      }
    } catch (error) {
      if (selection !== conversationSelectionRef.current) return
      if (archived) {
        const restoredArchive = sanitizePersistedConversation(archived)
        setConversationId(nextConversationId)
        conversationIdRef.current = nextConversationId
        setPendingOptions([])
        setAttachedFiles([])
        setMessages(restoredArchive.messages.length ? restoredArchive.messages : [initialAssistantMessage])
        setModelText('')
        modelEditedRef.current = false
        displayedModelRevisionRef.current = null
        setModelSyncMessage('')
        const archivedLatestResult = normalizeAgentResultPayload(restoredArchive.latestResult || null)
        const historicalOnly = archivedLatestResult ? { ...archivedLatestResult, analysis: undefined, codeCheck: undefined, report: undefined } : null
        setLatestResult(historicalOnly)
        setLatestModelVisualizationSnapshot(restoredArchive.modelVisualizationSnapshot || null)
        setLatestResultVisualizationSnapshot(null)
        setActivePanel('analysis')

        if (restoredArchive.staleStructuralData) {
          toast.error(`${t('staleStructuralSessionTitle')}: ${t('staleStructuralSessionBody')}`)
        }

        return
      }

      setErrorMessage(error instanceof Error ? error.message : `${t('loadConversationFailed')}.`)
    }
  }

  function resetConsoleState() {
    ++conversationSelectionRef.current
    conversationIdRef.current = ''
    setConversationId('')
    setRunPolicy({})
    setPendingOptions([])
    setAttachedFiles([])
    setInput('')
    setMessages([initialAssistantMessage])
    setModelText('')
    modelEditedRef.current = false
    displayedModelRevisionRef.current = 0
    setModelSyncMessage('')
    setLatestResult(null)
    setLatestModelVisualizationSnapshot(null)
    setLatestResultVisualizationSnapshot(null)
    setVisualizationOpen(false)
    setVisualizationSource('result')
    setErrorMessage('')
    setActivePanel('analysis')
    setPendingDeleteConversationId('')
  }

  function handleNewConversation() {
    resetConsoleState()
  }

  async function handleEndTurn() {
    const targetId = conversationId
    const expectedRunId = sessionRuntime.view?.usage?.runId
    if (!targetId || isStreaming || submittingRef.current || endingTurnConversationId
      || !expectedRunId || sessionRuntime.view?.busy || !sessionRuntime.view?.waitingForReply) return
    submittingRef.current = true
    setEndingTurnConversationId(targetId)
    setErrorMessage('')
    try {
      const response = await fetch(`${API_BASE}/api/v1/chat/conversation/${encodeURIComponent(targetId)}/turn/end`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRunId }),
      })
      if (!response.ok) throw new Error(response.status === 409 ? t('endTurnConflict') : `HTTP ${response.status}`)
      await sessionRuntime.refresh(targetId)
    } catch (error) {
      const nextError = `${t('endTurnFailed')} ${error instanceof Error ? error.message : ''}`.trim()
      if (conversationIdRef.current === targetId) setErrorMessage(nextError)
      toast.error(nextError)
    } finally {
      submittingRef.current = false
      setEndingTurnConversationId('')
    }
  }

  async function handleDeleteConversation(targetConversationId: string) {
    if (streamingSessions.get(targetConversationId)?.status === 'streaming' || deletingConversationId || !targetConversationId) {
      return
    }

    setDeletingConversationId(targetConversationId)
    setErrorMessage('')

    try {
      const response = await fetch(`${API_BASE}/api/v1/chat/conversation/${targetConversationId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error(`${t('deleteConversationFailed')} HTTP ${response.status}`)
      }

      deletedConversationIdsRef.current.add(targetConversationId)
      const remainingConversations = mergedConversations.filter((conversation) => conversation.id !== targetConversationId)
      setServerConversations((current) => current.filter((conversation) => conversation.id !== targetConversationId))
      setConversationArchive((current) => {
        const next = { ...current }
        delete next[targetConversationId]
        return next
      })
      setConversationActivityAt((current) => {
        const next = { ...current }
        delete next[targetConversationId]
        return next
      })
      setPendingDeleteConversationId('')

      if (targetConversationId === conversationId) {
        const nextConversation = remainingConversations[0]
        if (nextConversation) {
          await handleSelectConversation(nextConversation.id)
        } else {
          resetConsoleState()
        }
      }

      toast.success(t('deleteConversationSucceeded'))
    } catch (error) {
      const nextError = error instanceof Error ? error.message : t('deleteConversationFailed')
      setErrorMessage(nextError)
      toast.error(nextError)
    } finally {
      setDeletingConversationId('')
    }
  }

  return {
    handleSelectConversation,
    resetConsoleState,
    handleNewConversation,
    handleEndTurn,
    handleDeleteConversation,
  }
}
