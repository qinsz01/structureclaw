import type { RefObject } from 'react'
import type { AssistantPresentation } from '../message-presentation'
import type { Message } from './types'
import { createId, resolveAbortedAssistantContent } from './message-utils'
import { saveConversationMessagesToBackend } from './backend-sync'

/**
 * Mutable bookkeeping for one chat turn (formerly the `let` locals of the
 * submit handler). Shared by the stream event handlers of the same turn.
 */
export type TurnState = {
  assistantContent: string
  chatBuffer: string
  // The active text assistant message being appended to. Set to '' when a
  // tool call starts (text finalized). Next token creates a new one.
  currentTextMessageId: string
  receivedResult: boolean
  shouldBumpConversationActivity: boolean
  activeConversationId: string
  // Maps stepId -> messageId for tool bubbles.
  toolMessageIds: Map<string, string>
  // All message IDs created during this turn (for finalization).
  turnMessageIds: Set<string>
}

export type TurnBaseDeps = {
  assistantSeed: string
  trimmedInput: string
  traceId: string
  currentPresentationRef: RefObject<AssistantPresentation | null>
  appendMessageForConversation: (targetConvId: string, message: Message) => void
  replaceMessageForConversation: (
    targetConvId: string,
    messageId: string,
    updater: (message: Message) => Message,
  ) => void
}

export function finalizeStreamingMessage(message: Message, contentFallback: string, presentation: AssistantPresentation | null | undefined): Message {
  if (message.status !== 'streaming') return message
  return {
    ...message,
    content: message.content || contentFallback,
    status: 'done' as const,
    toolStep: message.role === 'tool' && message.toolStep?.status === 'running'
      ? { ...message.toolStep, status: 'done' as const }
      : message.toolStep,
    presentation: message.role === 'tool' ? undefined : (presentation ?? message.presentation),
  }
}

/** Ensure a text assistant message exists for writing. Creates one if needed. */
export function ensureTextMessage(turn: TurnState, deps: TurnBaseDeps) {
  const { appendMessageForConversation } = deps
  if (!turn.currentTextMessageId) {
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
}

export function syncTextPresentation(
  turn: TurnState,
  deps: TurnBaseDeps,
  nextPresentation: AssistantPresentation,
  nextStatus: Message['status'] = nextPresentation.status === 'done'
    ? 'done'
    : nextPresentation.status === 'error'
      ? 'error'
      : nextPresentation.status === 'aborted'
        ? 'aborted'
        : 'streaming',
) {
  const { currentPresentationRef, replaceMessageForConversation } = deps
  currentPresentationRef.current = nextPresentation
  ensureTextMessage(turn, deps)
  replaceMessageForConversation(turn.activeConversationId, turn.currentTextMessageId, (message) => ({
    ...message,
    content: nextPresentation.summaryText || turn.assistantContent,
    status: nextStatus,
    presentation: nextPresentation,
  }))
}

export async function finalizeAbortedTurn(turn: TurnState, deps: TurnBaseDeps) {
  const { assistantSeed, currentPresentationRef, replaceMessageForConversation, trimmedInput, traceId } = deps
  const abortedContent = resolveAbortedAssistantContent(turn.assistantContent, assistantSeed)
  const abortedPresentation = currentPresentationRef.current
    ? {
        ...currentPresentationRef.current,
        status: 'aborted' as const,
        completedAt: currentPresentationRef.current.completedAt || new Date().toISOString(),
        summaryText: currentPresentationRef.current.summaryText || abortedContent,
      }
    : undefined

  // Finalize ALL messages created during this turn
  for (const msgId of turn.turnMessageIds) {
    replaceMessageForConversation(turn.activeConversationId, msgId, (message) => {
      if (message.status !== 'streaming') return message
      return message.role === 'tool'
        ? { ...message, status: 'aborted' as const }
        : {
            ...message,
            content: message.id === turn.currentTextMessageId ? abortedContent : message.content || abortedContent,
            status: 'aborted' as const,
            presentation: abortedPresentation ?? message.presentation,
          }
    })
  }

  if (turn.activeConversationId) {
    await saveConversationMessagesToBackend(turn.activeConversationId, {
      userMessage: trimmedInput,
      assistantContent: abortedContent,
      assistantAborted: true,
      traceId,
      assistantPresentation: abortedPresentation,
    })
  }
}
