import { useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '@/lib/api-base'
import type { MessageKey } from '@/lib/i18n'
import type { ConversationSummary, PersistedConversation } from './types'
import { loadConversationArchive, saveConversationArchiveToStorage } from './archive-storage'

/**
 * Server conversation list merged with the local conversation archive
 * (localStorage), including load/save of the archive.
 */
export function useConversationHistory(t: (key: MessageKey) => string) {
  const [serverConversations, setServerConversations] = useState<ConversationSummary[]>([])
  const [conversationArchive, setConversationArchive] = useState<Record<string, PersistedConversation>>({})
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [conversationActivityAt, setConversationActivityAt] = useState<Record<string, string>>({})

  const mergedConversations = useMemo(() => {
    const map = new Map<string, ConversationSummary>()

    serverConversations.forEach((conversation) => {
      map.set(conversation.id, conversation)
    })

    Object.values(conversationArchive).forEach((conversation) => {
      const current = map.get(conversation.id)
      if (!current) {
        map.set(conversation.id, conversation)
        return
      }

      const currentUpdatedAt = current.updatedAt || current.createdAt || ''
      const archiveUpdatedAt = conversation.updatedAt || conversation.createdAt || ''
      if (archiveUpdatedAt > currentUpdatedAt) {
        map.set(conversation.id, { ...current, ...conversation })
      }
    })

    return Array.from(map.values()).sort((a, b) => {
      const left = b.updatedAt || b.createdAt || ''
      const right = a.updatedAt || a.createdAt || ''
      return left.localeCompare(right)
    })
  }, [conversationArchive, serverConversations])

  useEffect(() => {
    setConversationArchive(loadConversationArchive())
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const savedArchive = saveConversationArchiveToStorage(conversationArchive)
    if (savedArchive !== conversationArchive) {
      setConversationArchive(savedArchive)
    }
  }, [conversationArchive])

  useEffect(() => {
    let cancelled = false

    async function fetchConversations() {
      setHistoryLoading(true)
      setHistoryError('')

      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(), 8000)

      try {
        const response = await fetch(`${API_BASE}/api/v1/chat/conversations`, { signal: controller.signal })
        window.clearTimeout(timeoutId)
        if (!response.ok) {
          throw new Error(`${t('loadConversationFailed')}: HTTP ${response.status}`)
        }
        const payload = await response.json()
        if (!cancelled) {
          setServerConversations(Array.isArray(payload) ? (payload as ConversationSummary[]) : [])
        }
      } catch (error) {
        if (!cancelled) {
          const isAbort =
            (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') ||
            (error instanceof Error && error.name === 'AbortError')
          if (isAbort) {
            setHistoryError(t('conversationsLoadTimeout'))
          } else {
            setHistoryError(error instanceof Error ? error.message : `${t('loadConversationFailed')}.`)
          }
        }
      } finally {
        window.clearTimeout(timeoutId)
        if (!cancelled) {
          setHistoryLoading(false)
        }
      }
    }

    void fetchConversations()

    return () => {
      cancelled = true
    }
  }, [t])

  // Track which conversation IDs have been deleted locally to prevent auto-persist from restoring them
  const deletedConversationIdsRef = useRef<Set<string>>(new Set())

  return {
    serverConversations,
    setServerConversations,
    conversationArchive,
    setConversationArchive,
    historyLoading,
    historyError,
    conversationActivityAt,
    setConversationActivityAt,
    mergedConversations,
    deletedConversationIdsRef,
  }
}
