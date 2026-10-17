import type { MessageKey } from '@/lib/i18n'

/** Backend conversation-stage keys with a localized label; unknown stages are shown as sent. */
const CONVERSATION_STAGE_LABELS: Readonly<Record<string, MessageKey>> = {
  awaiting_user_input: 'guidanceStageAwaitingUserInput',
}

export function conversationStageLabel(stage: string, t: (key: MessageKey) => string): string {
  const key = CONVERSATION_STAGE_LABELS[stage.trim()]
  return key ? t(key) : stage
}
