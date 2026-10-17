import { useEffect, useRef } from 'react'
import type { Message } from './types'

/** Keeps the chat scrolled to the bottom unless the user has scrolled away. */
export function useChatAutoScroll(messages: Message[], isStreaming: boolean) {
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const shouldStickToBottomRef = useRef(true)

  useEffect(() => {
    const chatScrollElement = chatScrollRef.current
    if (!chatScrollElement) {
      return
    }

    const handleScroll = () => {
      const distanceFromBottom =
        chatScrollElement.scrollHeight - chatScrollElement.scrollTop - chatScrollElement.clientHeight
      shouldStickToBottomRef.current = distanceFromBottom < 48
    }

    handleScroll()
    chatScrollElement.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      chatScrollElement.removeEventListener('scroll', handleScroll)
    }
  }, [])

  useEffect(() => {
    if (!shouldStickToBottomRef.current) {
      return
    }

    const chatScrollElement = chatScrollRef.current
    if (!chatScrollElement) {
      return
    }

    if (typeof chatScrollElement.scrollTo === 'function') {
      chatScrollElement.scrollTo({
        top: chatScrollElement.scrollHeight,
        behavior: isStreaming ? 'auto' : 'smooth',
      })
      return
    }

    chatScrollElement.scrollTop = chatScrollElement.scrollHeight
  }, [messages, isStreaming])

  return chatScrollRef
}
