import { buildVisualizationSnapshot } from '@/components/visualization/adapter'
import { reducePresentationEvent, type AssistantPresentation } from '../message-presentation'
import type { AgentResult, StreamPayload } from './types'
import { buildMessageDebugDetails } from './message-utils'
import { buildVisualizationTitle, extractAnalysis, extractVisualizationHints } from './result-utils'
import { saveConversationSnapshotToBackend } from './backend-sync'
import { ensureTextMessage, type TurnState } from './turn-state'
import { handlePresentationPayload, type TurnStreamDeps } from './turn-stream-events'

/** Applies artifact sync, final result and error events of a chat stream. */
export function handleResultPayload(turn: TurnState, deps: TurnStreamDeps, payload: StreamPayload) {
  const {
    t,
    trimmedInput,
    contextModel,
    promptSnapshot,
    debugSkillIds,
    debugToolIds,
    currentPresentationRef,
    conversationIdRef,
    replaceMessageForConversation,
    setPendingOptions,
    setLatestResult,
    setLatestResultVisualizationSnapshot,
    setLatestModelVisualizationSnapshot,
    setActivePanel,
    setErrorMessage,
    applySynchronizedModel,
    persistConversationSnapshotsToArchive,
  } = deps

  if (payload.type === 'artifact_payload_sync') {
    if (payload.invalidated && turn.activeConversationId === conversationIdRef.current) {
      setLatestResult((current) => current ? {
        ...current,
        ...(payload.artifact === 'analysis' ? { analysis: undefined, codeCheck: undefined, report: undefined } : { report: undefined }),
      } : null)
      if (payload.artifact === 'analysis') setLatestResultVisualizationSnapshot(null)
    }
    if (payload.artifact === 'model' && payload.model) {
      if (turn.activeConversationId === conversationIdRef.current) {
        applySynchronizedModel(payload.model, 'tool')
      }
    }
    if (payload.artifact === 'analysis' && payload.latestResult && turn.activeConversationId === conversationIdRef.current) {
      setLatestResult((current) => ({
        ...(current || {}),
        ...(payload.latestResult || {}),
      }))
    }
    if (payload.artifact === 'report' && payload.latestResult && turn.activeConversationId === conversationIdRef.current) {
      setLatestResult((current) => ({
        ...(current || {}),
        ...(payload.latestResult || {}),
      }))
      setActivePanel(payload.latestResult.report?.markdown ? 'report' : 'analysis')
    }
  }

  if (payload.type === 'result' && payload.content && typeof payload.content === 'object') {
    const result = {
      ...(payload.content as AgentResult),
    }
    const visualizationHints = extractVisualizationHints(result)
    const debugDetails = buildMessageDebugDetails(promptSnapshot, debugSkillIds, debugToolIds, result)
    if (result.model && typeof result.model === 'object' && !Array.isArray(result.model)) {
      if (turn.activeConversationId === conversationIdRef.current) {
        applySynchronizedModel(result.model, result.analysis ? 'tool' : 'conversation')
      }
    }
    const visualizationSnapshot = buildVisualizationSnapshot({
      title: buildVisualizationTitle(result, trimmedInput.slice(0, 48) || t('untitledConversation')),
      model: (result.model && typeof result.model === 'object' && !Array.isArray(result.model) ? result.model : contextModel) ?? null,
      analysis: extractAnalysis(result),
      mode: 'analysis-result',
      memberUtilizationMap: visualizationHints?.memberUtilizationMap,
      bucklingModes: visualizationHints?.bucklingModes,
    })
    const modelSnapshot = buildVisualizationSnapshot({
      title: buildVisualizationTitle(result, trimmedInput.slice(0, 48) || t('untitledConversation')),
      model: (result.model && typeof result.model === 'object' && !Array.isArray(result.model) ? result.model : contextModel) ?? null,
      mode: 'model-only',
    })
    turn.receivedResult = true
    // Only update active conversation state when this is the foreground stream
    if (turn.activeConversationId === conversationIdRef.current) {
      setLatestResult(result)
      setLatestModelVisualizationSnapshot(modelSnapshot)
      setLatestResultVisualizationSnapshot(visualizationSnapshot)
      setActivePanel(result.report?.markdown ? 'report' : 'analysis')
    }
    // Always persist results to archive (for both active and background)
    persistConversationSnapshotsToArchive(turn.activeConversationId, {
      latestResult: result,
      modelSnapshot,
      resultSnapshot: visualizationSnapshot,
    })
    // 保存结果快照到后端（fire-and-forget to avoid blocking the stream loop）
    saveConversationSnapshotToBackend(turn.activeConversationId, {
      modelSnapshot,
      resultSnapshot: visualizationSnapshot,
      latestResult: result,
    }).catch(() => {})
    turn.assistantContent = result.response || result.clarification?.question || t('returnedResult')
    let nextPresentation: AssistantPresentation | null = currentPresentationRef.current
    if (nextPresentation) {
      if (!nextPresentation.summaryText) {
        nextPresentation = reducePresentationEvent(nextPresentation, {
          type: 'summary_replace',
          summaryText: turn.assistantContent,
        })
      }
      nextPresentation = reducePresentationEvent(nextPresentation, {
        type: 'presentation_complete',
        completedAt: result.completedAt || new Date().toISOString(),
      })
      currentPresentationRef.current = nextPresentation
    }
    ensureTextMessage(turn, deps)
    replaceMessageForConversation(turn.activeConversationId, turn.currentTextMessageId, (message) => ({
      ...message,
      content: turn.assistantContent,
      status: 'done',
      debugDetails,
      presentation: currentPresentationRef.current ?? message.presentation,
    }))
    turn.shouldBumpConversationActivity = true
  }

  if (payload.type === 'error') {
    let nextError = typeof payload.error === 'string' ? payload.error : t('requestFailed')
    if (payload.code === 'CONTEXT_OVERFLOW') {
      nextError = t('contextOverflowError')
    }
    turn.assistantContent = nextError
    setPendingOptions([])
    if (turn.activeConversationId === conversationIdRef.current) {
      setErrorMessage(nextError)
    }
    ensureTextMessage(turn, deps)
    replaceMessageForConversation(turn.activeConversationId, turn.currentTextMessageId, (message) => ({
      ...message,
      content: turn.assistantContent,
      status: 'error',
      presentation: currentPresentationRef.current ?? message.presentation,
    }))
    turn.shouldBumpConversationActivity = true
  }
}

/** Dispatches one parsed stream payload to the presentation and result handlers. */
export function handleStreamPayload(turn: TurnState, deps: TurnStreamDeps, payload: StreamPayload) {
  handlePresentationPayload(turn, deps, payload)
  handleResultPayload(turn, deps, payload)
}
