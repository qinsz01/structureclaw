import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { VisualizationSnapshot } from '@/components/visualization/types'
import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { normalizeClarificationOptions } from '../clarification-options'
import { reducePresentationEvent } from '../message-presentation'
import type { AgentInteraction, AgentResult, Message, PanelTab, StreamPayload } from './types'
import { buildInteractionMessage, createId } from './message-utils'
import { ensureTextMessage, syncTextPresentation, type TurnBaseDeps, type TurnState } from './turn-state'

export type TurnStreamDeps = TurnBaseDeps & {
  t: (key: MessageKey) => string
  locale: AppLocale
  contextModel: Record<string, unknown> | undefined
  promptSnapshot: string
  debugSkillIds: string[]
  debugToolIds: string[]
  conversationIdRef: RefObject<string>
  setPendingOptions: Dispatch<SetStateAction<string[]>>
  setConversationId: Dispatch<SetStateAction<string>>
  setLatestResult: Dispatch<SetStateAction<AgentResult | null>>
  setLatestResultVisualizationSnapshot: Dispatch<SetStateAction<VisualizationSnapshot | null>>
  setLatestModelVisualizationSnapshot: Dispatch<SetStateAction<VisualizationSnapshot | null>>
  setActivePanel: Dispatch<SetStateAction<PanelTab>>
  setErrorMessage: Dispatch<SetStateAction<string>>
  applySynchronizedModel: (nextModel: Record<string, unknown>, source: 'conversation' | 'tool') => void
  persistConversationSnapshotsToArchive: (
    targetConversationId: string,
    params: {
      latestResult?: AgentResult | null
      modelSnapshot?: VisualizationSnapshot | null
      resultSnapshot?: VisualizationSnapshot | null
    },
  ) => void
}

/**
 * Applies text, interaction and presentation timeline events (tokens, tool
 * steps, phases, artifacts, summary) of a chat stream to the turn's messages.
 */
export function handlePresentationPayload(turn: TurnState, deps: TurnStreamDeps, payload: StreamPayload) {
  const {
    t,
    locale,
    assistantSeed,
    currentPresentationRef,
    conversationIdRef,
    appendMessageForConversation,
    replaceMessageForConversation,
    setPendingOptions,
    setConversationId,
  } = deps

  if (payload.type === 'token') {
    const token = typeof payload.content === 'string' ? payload.content : ''
    turn.chatBuffer += token
    turn.assistantContent = turn.chatBuffer || assistantSeed
    ensureTextMessage(turn, deps)
    replaceMessageForConversation(turn.activeConversationId, turn.currentTextMessageId, (message) => ({
      ...message,
      content: turn.assistantContent,
      status: 'streaming',
    }))
  }

  if (payload.type === 'interaction_update') {
    // Interrupts send an authoritative summary before their interaction state.
    // Interaction metadata is not another assistant response. Keep a fallback
    // for older streams that only supply the interaction event.
    const interactionMessage = currentPresentationRef.current?.summaryText || buildInteractionMessage(payload, t, locale)
    turn.assistantContent = interactionMessage
    if (currentPresentationRef.current) {
      const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
        type: 'summary_replace',
        summaryText: interactionMessage,
      })
      syncTextPresentation(turn, deps, nextPresentation, 'streaming')
    } else {
      ensureTextMessage(turn, deps)
      replaceMessageForConversation(turn.activeConversationId, turn.currentTextMessageId, (message) => ({
        ...message,
        content: turn.assistantContent,
        status: 'streaming',
      }))
    }
    const interactionOpts = normalizeClarificationOptions((payload.content as AgentInteraction)?.options)
    if (interactionOpts.length > 0 && turn.activeConversationId === conversationIdRef.current) setPendingOptions(interactionOpts)
  }

  // 处理 'start' 类型消息（包含 conversationId）
  if (payload.type === 'start' && payload.content && typeof payload.content === 'object') {
    const { conversationId: newConversationId } = payload.content as { conversationId?: string; startedAt?: string }
    if (newConversationId && (!conversationIdRef.current || turn.activeConversationId === conversationIdRef.current)) {
      setConversationId(newConversationId)
    }
  }

  if (payload.type === 'presentation_init' && payload.presentation) {
    syncTextPresentation(turn, deps, payload.presentation, 'streaming')
  }

  if (payload.type === 'phase_upsert' && payload.phase && currentPresentationRef.current) {
    const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
      type: 'phase_upsert',
      phase: payload.phase,
    })
    syncTextPresentation(turn, deps, nextPresentation, 'streaming')
  }

  if (payload.type === 'step_upsert' && payload.phaseId && payload.step) {
    if (payload.step.status === 'running') {
      const existingToolMsgId = turn.toolMessageIds.get(payload.step.id)

      if (existingToolMsgId) {
        // Duplicate running event — update existing message instead of creating a new one
        replaceMessageForConversation(turn.activeConversationId, existingToolMsgId, (msg) => ({
          ...msg,
          toolStep: { ...msg.toolStep!, ...payload.step },
        }))
      } else {
        // Finalize current text message
        if (turn.currentTextMessageId) {
          replaceMessageForConversation(turn.activeConversationId, turn.currentTextMessageId, (msg) => {
            if (msg.status !== 'streaming') return msg
            return { ...msg, status: 'done' as const }
          })
          turn.currentTextMessageId = ''
          turn.chatBuffer = ''  // Reset so next text bubble only contains new tokens
        }
        // Create a new tool message bubble
        const toolMsgId = createId('tool')
        turn.toolMessageIds.set(payload.step.id, toolMsgId)
        turn.turnMessageIds.add(toolMsgId)
        appendMessageForConversation(turn.activeConversationId, {
          id: toolMsgId,
          role: 'tool',
          content: '',
          status: 'streaming',
          timestamp: new Date().toISOString(),
          toolStep: payload.step,
        })
      }
      // Also track in presentation (for data continuity)
      if (currentPresentationRef.current) {
        const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
          type: 'step_upsert',
          phaseId: payload.phaseId,
          step: payload.step,
        })
        currentPresentationRef.current = nextPresentation
      }
    } else {
      // Update existing tool message (done / error)
      const toolMsgId = turn.toolMessageIds.get(payload.step.id)
      if (toolMsgId) {
        replaceMessageForConversation(turn.activeConversationId, toolMsgId, (msg) => ({
          ...msg,
          status: (payload.step!.status === 'error' ? 'error' : 'done') as Message['status'],
          toolStep: { ...msg.toolStep!, ...payload.step },
        }))
      } else {
        if (turn.currentTextMessageId) {
          replaceMessageForConversation(turn.activeConversationId, turn.currentTextMessageId, (msg) => {
            if (msg.status !== 'streaming') return msg
            return { ...msg, status: 'done' as const }
          })
          turn.currentTextMessageId = ''
          turn.chatBuffer = ''
        }

        const completedToolMsgId = createId('tool')
        turn.toolMessageIds.set(payload.step.id, completedToolMsgId)
        turn.turnMessageIds.add(completedToolMsgId)
        appendMessageForConversation(turn.activeConversationId, {
          id: completedToolMsgId,
          role: 'tool',
          content: '',
          status: (payload.step.status === 'error' ? 'error' : 'done') as Message['status'],
          timestamp: new Date().toISOString(),
          toolStep: payload.step,
        })
      }
      // On tool done, create a "thinking" text bubble so the user sees
      // the LLM is still running. The next token will replace this content.
      if (payload.step.status === 'done' && !turn.currentTextMessageId) {
        turn.currentTextMessageId = createId('assistant')
        turn.turnMessageIds.add(turn.currentTextMessageId)
        appendMessageForConversation(turn.activeConversationId, {
          id: turn.currentTextMessageId,
          role: 'assistant',
          content: '',
          status: 'streaming',
          timestamp: new Date().toISOString(),
        })
      }
      // Also track in presentation
      if (currentPresentationRef.current) {
        const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
          type: 'step_upsert',
          phaseId: payload.phaseId,
          step: payload.step,
        })
        currentPresentationRef.current = nextPresentation
      }
    }
  }

  if (payload.type === 'artifact_upsert' && payload.artifact && currentPresentationRef.current) {
    const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
      type: 'artifact_upsert',
      artifact: payload.artifact,
    })
    syncTextPresentation(turn, deps, nextPresentation, 'streaming')
  }

  if (payload.type === 'summary_replace' && typeof payload.summaryText === 'string' && currentPresentationRef.current) {
    turn.assistantContent = payload.summaryText
    const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
      type: 'summary_replace',
      summaryText: payload.summaryText,
    })
    syncTextPresentation(turn, deps, nextPresentation, 'streaming')
  }

  if (payload.type === 'presentation_complete' && typeof payload.completedAt === 'string' && currentPresentationRef.current) {
    const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
      type: 'presentation_complete',
      completedAt: payload.completedAt,
    })
    syncTextPresentation(turn, deps, nextPresentation, 'done')
  }

  if (payload.type === 'presentation_error' && payload.phase && payload.message && currentPresentationRef.current) {
    turn.assistantContent = payload.message || turn.assistantContent
    const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
      type: 'presentation_error',
      phase: payload.phase as 'understanding' | 'modeling' | 'validation' | 'analysis' | 'report',
      message: payload.message,
    })
    syncTextPresentation(turn, deps, nextPresentation, 'error')
  }
}
