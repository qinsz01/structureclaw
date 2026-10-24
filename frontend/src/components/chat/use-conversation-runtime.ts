'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationRuntimeSnapshot } from '../../../../backend/src/types/conversation-runtime'
import { API_BASE } from '@/lib/api-base'

export type { ConversationRuntimeSnapshot }

export async function readConversationRuntime(conversationId: string): Promise<ConversationRuntimeSnapshot> {
  const response = await fetch(`${API_BASE}/api/v1/chat/conversation/${encodeURIComponent(conversationId)}/session`)
  if (!response.ok) throw new Error(`CONVERSATION_STATE_UNAVAILABLE: HTTP ${response.status}`)
  const value = await response.json() as ConversationRuntimeSnapshot
  if (value.conversationId !== conversationId || typeof value.waitingForReply !== 'boolean' || typeof value.busy !== 'boolean') {
    throw new Error('CONVERSATION_STATE_UNAVAILABLE')
  }
  return value
}

/** UI projection only. A response from a previously selected conversation cannot overwrite this one. */
export function useConversationRuntime(conversationId: string, streaming: boolean) {
  const [view, setView] = useState<ConversationRuntimeSnapshot | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const active = useRef(conversationId)
  const sequence = useRef(0)
  const invalidate = useCallback(() => { ++sequence.current }, [])
  const refresh = useCallback(async (id = conversationId) => {
    if (!id) return null
    const request = ++sequence.current
    if (active.current === id) setLoading(true)
    try {
      const result = await readConversationRuntime(id)
      if (active.current === id && request === sequence.current) { setView(result); setError('') }
      return result
    } catch (failure) {
      if (active.current === id && request === sequence.current) {
        setView(null); setError(failure instanceof Error ? failure.message : String(failure))
      }
      throw failure
    } finally {
      if (active.current === id && request === sequence.current) setLoading(false)
    }
  }, [conversationId])
  useEffect(() => {
    active.current = conversationId
    ++sequence.current
    setView(null); setError(''); setLoading(false)
    if (conversationId) void refresh().catch(() => {})
    return invalidate
  }, [conversationId, refresh, invalidate])
  useEffect(() => {
    if (!conversationId || (!streaming && !view?.busy)) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refresh().catch(() => {})
      if (!cancelled) timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [conversationId, streaming, view?.busy, refresh])
  return { view: view?.conversationId === conversationId ? view : null, error, loading, refresh }
}
