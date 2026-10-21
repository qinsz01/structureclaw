import { API_BASE } from '@/lib/api-base'
import type { Message } from './types'
import { buildPromptSnapshot, createId, resolveResumeFromMessage } from './message-utils'
import { parseModelJson } from './result-utils'
import { buildTurnContextPayload } from './turn-context'
import {
  ensureTextMessage,
  finalizeAbortedTurn,
  finalizeStreamingMessage,
  type TurnBaseDeps,
  type TurnState,
} from './turn-state'
import type { TurnStreamDeps } from './turn-stream-events'
import { handleStreamPayload } from './turn-stream-results'
import { readStreamPayloads } from './turn-stream-reader'
import type { ConsoleState } from './use-console-state'
import type { ConversationMutators } from './conversation-mutators'
import type { WorkspaceActions } from './workspace-actions'

/** Sends a chat turn and consumes its event stream. */
export function createTurnSubmission(state: ConsoleState, mutators: ConversationMutators, workspace: WorkspaceActions) {
  const {
    input,
    skillsLoaded,
    capabilityMatrixLoaded,
    submittingRef,
    modelText,
    t,
    locale,
    setErrorMessage,
    setActivePanel,
    setResultDialogOpen,
    modelEditedRef,
    displayedModelRevisionRef,
    modelEditSequenceRef,
    messagesRef,
    attachedFiles,
    currentPresentationRef,
    setInput,
    setAttachedFiles,
    setVisualizationOpen,
    setVisualizationSource,
    setModelSyncMessage,
    setMessages,
    conversationId,
    setIsStreaming,
    sessionRuntime,
    conversationIdRef,
    setConversationId,
    registerStreamSession,
    skillNormalization,
    selectedSkillIds,
    defaultSelectedSkillIds,
    hasExplicitSkillSelection,
    selectedToolIds,
    hasExplicitToolSelection,
    restoredScopeRef,
    storeSkillIds,
    storeToolIds,
    runPolicy,
    hasSelectedCodeCheckSkill,
    setPendingOptions,
    streamingSessionsRef,
    setLatestResult,
    setLatestResultVisualizationSnapshot,
    setLatestModelVisualizationSnapshot,
    updateStreamSessionStatus,
    removeStreamSession,
  } = state
  const {
    ensureConversation,
    appendMessageForConversation,
    replaceMessageForConversation,
    persistConversationSnapshotsToArchive,
    markConversationActivity,
  } = mutators
  const { applySynchronizedModel } = workspace

  async function handleSubmit(overrideInput?: string) {
    const trimmedInput = (overrideInput ?? input).trim()
    if (!skillsLoaded || !capabilityMatrixLoaded || !trimmedInput || submittingRef.current) {
      return
    }
    submittingRef.current = true

    const parsedModel = parseModelJson(modelText, t)
    if (parsedModel.error) {
      setErrorMessage(parsedModel.error)
      setActivePanel('context')
      setResultDialogOpen(true)
    }
    const contextModel = parsedModel.error ? undefined : parsedModel.model
    const requestedContextModel = modelEditedRef.current ? contextModel : undefined
    const requestedModelRevision = displayedModelRevisionRef.current
    const submittedModelEditSequence = modelEditSequenceRef.current
    const resumeFromMessage = resolveResumeFromMessage(messagesRef.current, trimmedInput)

    const userMessage: Message = {
      id: createId('user'),
      role: 'user',
      content: trimmedInput,
      status: 'done',
      timestamp: new Date().toISOString(),
      attachments: attachedFiles.length > 0
        ? attachedFiles.map((f) => ({
            fileId: f.fileId,
            originalName: f.originalName,
            relPath: f.relPath,
            size: f.size,
            mimeType: f.mimeType,
          }))
        : undefined,
    }

    const assistantMessageId = createId('assistant')
    const assistantSeed = t('assistantSeedAuto')

    currentPresentationRef.current = null
    setErrorMessage('')
    setInput('')
    setAttachedFiles([])
    setVisualizationOpen(false)
    setVisualizationSource('result')
    setModelSyncMessage('')
    // Append user message and assistant seed immediately (before async work)
    setMessages((current) => [...current, userMessage])
    setMessages((current) => [...current, {
      id: assistantMessageId,
      role: 'assistant',
      content: assistantSeed,
      status: 'streaming',
      timestamp: new Date().toISOString(),
    }])
    const abortController = new AbortController()
    const traceId = assistantMessageId
    setIsStreaming(true)

    const turn: TurnState = {
      assistantContent: assistantSeed,
      chatBuffer: '',
      currentTextMessageId: assistantMessageId,
      receivedResult: false,
      shouldBumpConversationActivity: false,
      activeConversationId: conversationId,
      toolMessageIds: new Map<string, string>(),
      turnMessageIds: new Set<string>([assistantMessageId]),
    }
    const deps: TurnBaseDeps = {
      assistantSeed,
      trimmedInput,
      traceId,
      currentPresentationRef,
      appendMessageForConversation,
      replaceMessageForConversation,
    }

    try {
      const nextConversationId = await ensureConversation(trimmedInput)
      turn.activeConversationId = nextConversationId
      // Existing conversations are checked against the checkpoint before choosing resume/new turn.
      const turnRuntime = conversationId ? await sessionRuntime.refresh(nextConversationId) : null
      if (turnRuntime?.busy) throw new Error(locale === 'zh' ? '此会话仍在运行，请等待或停止当前作业。' : 'This conversation is still running. Wait or stop its current operation.')
      if (turnRuntime?.jobs.some(job => job.status === 'outcome_unknown')) {
        throw new Error(locale === 'zh' ? '作业结果尚未确认，请先核查原作业；不会自动重复求解。' : 'A job outcome is unknown. Inspect the original operation before continuing; it will not be reissued automatically.')
      }
      if (requestedContextModel && turnRuntime && requestedModelRevision !== turnRuntime.modelRevision) {
        throw new Error(locale === 'zh' ? '模型版本已变更或尚未确认，请重新打开此会话后再编辑。' : 'The model revision changed or is unconfirmed. Reload this conversation before editing.')
      }

      // Set conversationId immediately so the Stop button appears
      // without waiting for the SSE start event.
      if (nextConversationId !== conversationId) {
        conversationIdRef.current = nextConversationId
        setConversationId(nextConversationId)
      }

      registerStreamSession({
        conversationId: nextConversationId,
        status: 'streaming',
        abortController,
        assistantMessageId,
        reader: null,
      })

      const contextPayload = buildTurnContextPayload({
        skillNormalization,
        selectedSkillIds,
        defaultSelectedSkillIds,
        hasExplicitSkillSelection,
        selectedToolIds,
        hasExplicitToolSelection,
        restoredScopeRef,
        turnRuntime,
        nextConversationId,
        storeSkillIds,
        storeToolIds,
        runPolicy,
        locale,
        requestedContextModel,
        requestedModelRevision,
        hasSelectedCodeCheckSkill,
        resumeFromMessage,
        attachedFiles,
      })
      const promptSnapshot = buildPromptSnapshot(trimmedInput, contextPayload as Record<string, unknown>)
      const debugSkillIds = Array.isArray((contextPayload as Record<string, unknown>).skillIds)
        ? ((contextPayload as Record<string, unknown>).skillIds as string[])
        : []
      const debugToolIds = Array.isArray((contextPayload as Record<string, unknown>).enabledToolIds)
        ? ((contextPayload as Record<string, unknown>).enabledToolIds as string[])
        : []

      // If the LangGraph agent is paused with interrupt(), resume it
      // by calling /stream/resume instead of starting a new /stream
      const isResume = turnRuntime?.waitingForReply === true
      setPendingOptions([])

      const response = isResume
        ? await fetch(`${API_BASE}/api/v1/chat/stream/resume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversationId: nextConversationId,
              resumeValue: trimmedInput,
              attachments: contextPayload.attachments,
            }),
            signal: abortController.signal,
          })
        : await fetch(`${API_BASE}/api/v1/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: trimmedInput,
              conversationId: nextConversationId,
              traceId,
              context: contextPayload,
            }),
            signal: abortController.signal,
          })

      if (!response.ok || !response.body) {
        throw new Error(`${t('requestFailedHttp')}: HTTP ${response.status}`)
      }

      const reader = response.body.getReader()
      // Store reader so stopStream can cancel it directly
      const existingSession = streamingSessionsRef.current.get(nextConversationId)
      if (existingSession) {
        existingSession.reader = reader
      }

      const streamDeps: TurnStreamDeps = {
        ...deps,
        t,
        locale,
        contextModel,
        promptSnapshot,
        debugSkillIds,
        debugToolIds,
        conversationIdRef,
        setPendingOptions,
        setConversationId,
        setLatestResult,
        setLatestResultVisualizationSnapshot,
        setLatestModelVisualizationSnapshot,
        setActivePanel,
        setErrorMessage,
        applySynchronizedModel,
        persistConversationSnapshotsToArchive,
      }
      await readStreamPayloads(reader, abortController.signal, (payload) => handleStreamPayload(turn, streamDeps, payload))

      if (abortController.signal.aborted) {
        await finalizeAbortedTurn(turn, deps)
      } else {
        // Finalize all still-streaming messages from this turn
        for (const msgId of turn.turnMessageIds) {
          replaceMessageForConversation(turn.activeConversationId, msgId, (message) =>
            finalizeStreamingMessage(message, assistantSeed, currentPresentationRef.current)
          )
        }
        if (turn.assistantContent !== assistantSeed || turn.receivedResult) {
          turn.shouldBumpConversationActivity = true
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        await finalizeAbortedTurn(turn, deps)
      } else {
        const nextError = error instanceof Error ? error.message : t('requestFailed')

        if ((turn.receivedResult || turn.assistantContent !== assistantSeed) && nextError === 'Failed to fetch') {
          for (const msgId of turn.turnMessageIds) {
            replaceMessageForConversation(turn.activeConversationId, msgId, (message) =>
              finalizeStreamingMessage(message, '', currentPresentationRef.current)
            )
          }
        } else {
          if (turn.activeConversationId === conversationIdRef.current) {
            setErrorMessage(nextError)
          }
          ensureTextMessage(turn, deps)
          replaceMessageForConversation(turn.activeConversationId, turn.currentTextMessageId, (message) => ({
            ...message,
            content: nextError,
            status: 'error',
            presentation: currentPresentationRef.current ?? message.presentation,
          }))
          turn.shouldBumpConversationActivity = Boolean(turn.activeConversationId)
        }
      }
    } finally {
      const confirmedRuntime = turn.activeConversationId
        ? await sessionRuntime.refresh(turn.activeConversationId).catch(() => null) : null
      // A successfully accepted import is no longer an unsaved composer edit.
      // Keep a newer user edit intact, and bind future edits to the confirmed revision.
      if (requestedContextModel && turn.receivedResult && !abortController.signal.aborted
        && turn.activeConversationId === conversationIdRef.current
        && submittedModelEditSequence === modelEditSequenceRef.current && confirmedRuntime) {
        modelEditedRef.current = false
        displayedModelRevisionRef.current = confirmedRuntime.modelRevision
      }
      submittingRef.current = false
      setIsStreaming(false)
      if (turn.shouldBumpConversationActivity || abortController.signal.aborted) {
        markConversationActivity(turn.activeConversationId)
      }
      const finalStatus = abortController.signal.aborted ? 'aborted' : 'completed'
      updateStreamSessionStatus(turn.activeConversationId, finalStatus)
      setTimeout(() => removeStreamSession(turn.activeConversationId), 2000)
    }
  }

  return { handleSubmit }
}
