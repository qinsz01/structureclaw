import { describe, expect, it } from 'vitest'
import { conversationStageLabel } from '@/lib/conversation-stage'
import { messages, type MessageKey } from '@/lib/i18n'

const translator = (locale: 'en' | 'zh') => (key: MessageKey) => messages[locale][key]

describe('conversation stage labels', () => {
  it('maps backend stage keys to localized labels in en and zh', () => {
    expect(conversationStageLabel('awaiting_user_input', translator('en'))).toBe('Waiting for your reply')
    expect(conversationStageLabel('awaiting_user_input', translator('zh'))).toBe('等待用户回复')
  })

  it('shows an unknown stage as sent', () => {
    expect(conversationStageLabel('custom stage', translator('zh'))).toBe('custom stage')
  })
})
