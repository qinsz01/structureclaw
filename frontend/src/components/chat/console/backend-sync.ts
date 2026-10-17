import type { VisualizationSnapshot } from '@/components/visualization/types'
import type { AssistantPresentation } from '../message-presentation'
import { API_BASE } from '@/lib/api-base'
import type { AgentResult } from './types'

export async function saveConversationSnapshotToBackend(
  conversationId: string,
  params: {
    modelSnapshot?: VisualizationSnapshot | null
    resultSnapshot?: VisualizationSnapshot | null
    latestResult?: AgentResult | null
  }
): Promise<void> {
  if (!conversationId) return

  try {
    await fetch(`${API_BASE}/api/v1/chat/conversation/${conversationId}/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelSnapshot: params.modelSnapshot,
        resultSnapshot: params.resultSnapshot,
        latestResult: params.latestResult,
      }),
    });
  } catch (error) {
    console.warn('Failed to save snapshot to backend:', error);
  }
}

export async function saveConversationMessagesToBackend(
  conversationId: string,
  params: {
    userMessage: string
    assistantContent: string
    assistantAborted?: boolean
    traceId?: string
    assistantPresentation?: AssistantPresentation
  }
): Promise<void> {
  if (!conversationId) return

  try {
    await fetch(`${API_BASE}/api/v1/chat/conversation/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userMessage: params.userMessage,
        assistantContent: params.assistantContent,
        assistantAborted: params.assistantAborted,
        traceId: params.traceId,
        assistantPresentation: params.assistantPresentation,
      }),
    })
  } catch (error) {
    console.warn('Failed to save messages to backend:', error);
  }
}
