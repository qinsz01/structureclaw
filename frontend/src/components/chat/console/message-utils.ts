import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { API_BASE } from '@/lib/api-base'
import { conversationStageLabel } from '@/lib/conversation-stage'
import type { Message, MessageDebugDetails, AgentResult, StreamPayload, MessageRenderGroup } from './types'
import { normalizeToolCalls } from './persisted-messages'

/** Check the text actually rendered in this turn, not tool output or older replies. */
export function isQuestionVisibleInCurrentTurn(messages: Message[], question: string): boolean {
  const text = question.trim()
  if (!text) return false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user') break
    if (message.role !== 'assistant') continue
    const visibleText = message.presentation ? message.presentation.summaryText : message.content
    if (visibleText.includes(text)) return true
  }
  return false
}

export function groupMessagesForRendering(messages: Message[]): MessageRenderGroup[] {
  const groups: MessageRenderGroup[] = []

  messages.forEach((message) => {
    if (message.role === 'tool') {
      const previous = groups[groups.length - 1]
      if (previous?.type === 'assistant-execution') {
        groups[groups.length - 1] = {
          ...previous,
          tools: [...previous.tools, message],
        }
        return
      }
      groups.push({ type: 'single', message })
      return
    }

    if (message.role === 'assistant' && (message.presentation?.mode === 'execution')) {
      groups.push({ type: 'assistant-execution', assistant: message, tools: [] })
      return
    }

    groups.push({ type: 'single', message })
  })

  return groups
}

export function findPreviousUserMessage(messages: Message[], messageId: string): Message | null {
  const index = messages.findIndex((message) => message.id === messageId)
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i]
  }
  return null
}

export function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function buildPromptSnapshot(message: string, context: Record<string, unknown>) {
  return JSON.stringify({ message, context }, null, 2)
}

export function resolveAbortedAssistantContent(content: string, assistantSeed: string) {
  return content.trim() === assistantSeed.trim() ? '' : content
}

export function buildMessageDebugDetails(promptSnapshot: string, skillIds: string[], toolIds: string[], result: AgentResult): MessageDebugDetails {
  const safeToolCalls = normalizeToolCalls(result.toolCalls)

  return {
    promptSnapshot,
    skillIds,
    toolIds,
    routing: result.routing,
    responseSummary: result.response || '',
    plan: Array.isArray(result.plan) ? result.plan : [],
    toolCalls: safeToolCalls,
  }
}

export function formatDebugPayload(value: unknown, fallback: string) {
  if (value === undefined) {
    return fallback
  }
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function buildInteractionMessage(
  payload: Extract<StreamPayload, { type: 'interaction_update' }>,
  t: (key: MessageKey) => string,
  locale: AppLocale
) {
  const questions = payload.content?.questions || []
  const conversationStage = payload.content?.conversationStage
  const fallbackSupportNote = payload.content?.fallbackSupportNote
  const recommendedNextStep = payload.content?.recommendedNextStep
  const criticalMissing = payload.content?.pending?.criticalMissing || []
  const lines: string[] = []

  if (conversationStage) {
    lines.push(`${t('guidanceCurrentStage')}: ${conversationStageLabel(conversationStage, t)}`)
  }
  if (fallbackSupportNote) {
    lines.push(fallbackSupportNote)
  }

  if (questions.length > 0) {
    lines.push(...questions
      .map((item) => item.question || item.label)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  }

  if (criticalMissing.length > 0) {
    lines.push(`${t('interactionMissingInfo')}: ${criticalMissing.join(locale === 'zh' ? '、' : ', ')}`)
  }

  // Options are rendered as interactive chips in the composer area, not here.

  if (recommendedNextStep) {
    lines.push(`${t('guidanceRecommendedNextStep')}: ${recommendedNextStep}`)
  }

  return lines.length > 0 ? lines.join('\n') : t('interactionNeedMoreParams')
}

const PDF_LINK_RE = /\[PDF[^\]]*\]\(([^)\s]+)\)/

export function extractPdfUrl(content: string): string | null {
  const m = content.match(PDF_LINK_RE)
  if (!m) return null
  const relative = m[1]
  if (relative.startsWith('http') || relative.startsWith('//')) return relative
  return `${API_BASE}${relative}`
}
