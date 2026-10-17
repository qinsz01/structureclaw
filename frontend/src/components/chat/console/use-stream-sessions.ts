import { useRef, useState } from 'react'
import type { StreamSession } from './types'

/** Tracks in-flight chat streams per conversation (state for rendering, ref for handlers). */
export function useStreamSessions(conversationId: string) {
  const [streamingSessions, setStreamingSessions] = useState<Map<string, StreamSession>>(new Map())
  const streamingSessionsRef = useRef<Map<string, StreamSession>>(new Map())

  // Streaming session helpers
  function registerStreamSession(session: StreamSession) {
    setStreamingSessions((prev) => new Map(prev).set(session.conversationId, session))
    streamingSessionsRef.current.set(session.conversationId, session)
  }

  function updateStreamSessionStatus(convId: string, status: StreamSession['status']) {
    setStreamingSessions((prev) => {
      const next = new Map(prev)
      const existing = next.get(convId)
      if (existing) next.set(convId, { ...existing, status })
      return next
    })
    const existing = streamingSessionsRef.current.get(convId)
    if (existing) streamingSessionsRef.current.set(convId, { ...existing, status })
  }

  function removeStreamSession(convId: string) {
    setStreamingSessions((prev) => {
      const next = new Map(prev)
      next.delete(convId)
      return next
    })
    streamingSessionsRef.current.delete(convId)
  }

  function stopStream(targetConversationId?: string) {
    const id = targetConversationId || conversationId
    const session = streamingSessionsRef.current.get(id)
    if (session?.status === 'streaming') {
      session.abortController.abort()
      session.reader?.cancel().catch(() => {})
      updateStreamSessionStatus(id, 'aborted')
    }
  }

  return {
    streamingSessions,
    streamingSessionsRef,
    registerStreamSession,
    updateStreamSessionStatus,
    removeStreamSession,
    stopStream,
  }
}
