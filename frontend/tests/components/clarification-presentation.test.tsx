import { createRef } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatTranscript } from '@/components/chat/console/chat-transcript'
import { groupMessagesForRendering } from '@/components/chat/console/message-utils'
import { handlePresentationPayload, type TurnStreamDeps } from '@/components/chat/console/turn-stream-events'
import type { TurnState } from '@/components/chat/console/turn-state'
import type { ConsoleState } from '@/components/chat/console/use-console-state'
import type { Message } from '@/components/chat/console/types'
import type { AssistantPresentation } from '@/components/chat/message-presentation'

afterEach(cleanup)

const question = '荷载施加位置确认：恒载与活载均为竖直向下的梁上线荷载，作用于全部4跨梁上。是否确认？'
const presentation = (text: string): AssistantPresentation => ({
  version: 3, mode: 'execution', status: 'streaming', summaryText: text, phases: [], artifacts: [],
})
const message = (id: string, role: Message['role'], content: string): Message => ({
  id, role, content, timestamp: '2026-10-25T03:33:50Z', status: 'done',
})

function transcript(messages: Message[], pending = question, streaming = false, catalogReady = true) {
  const state = {
    chatScrollRef: createRef<HTMLDivElement>(), messages, quickPrompts: [], setInput: vi.fn(),
    messageRenderGroups: groupMessagesForRendering(messages), t: (key: string) => key, locale: 'zh', availableSkills: [],
    composerTextareaRef: createRef<HTMLTextAreaElement>(), isStreaming: streaming,
    sessionRuntime: { view: { waitingForReply: true, question: pending, busy: false, usage: { runId: 'run' } } },
    endingTurnConversationId: '', conversationId: 'conversation', pendingOptions: ['确认'], errorMessage: '',
    skillsLoaded: catalogReady, capabilityMatrixLoaded: catalogReady,
  } as unknown as ConsoleState
  return <ChatTranscript state={state} composer={<textarea aria-label="Reply" />}
    handleSubmit={vi.fn()} handleEndTurn={vi.fn()} />
}

describe('one visible clarification through streaming and restore', () => {
  it.each(['en', 'zh'] as const)('does not append an interaction copy to the authoritative summary (%s)', locale => {
    let messages = [message('user', 'user', 'Analyze this frame'), message('assistant', 'assistant', '')]
    const currentPresentationRef = { current: presentation('') }
    const turn: TurnState = { assistantContent: '', chatBuffer: '', currentTextMessageId: 'assistant',
      receivedResult: false, shouldBumpConversationActivity: false, activeConversationId: 'conversation',
      toolMessageIds: new Map(), turnMessageIds: new Set(['assistant']) }
    const deps = { locale, t: (key: string) => key, assistantSeed: '', traceId: 'trace', currentPresentationRef,
      conversationIdRef: { current: 'conversation' }, setPendingOptions: vi.fn(),
      appendMessageForConversation: (_id: string, next: Message) => { messages.push(next) },
      replaceMessageForConversation: (_id: string, id: string, update: (value: Message) => Message) => {
        messages = messages.map(value => value.id === id ? update(value) : value)
      },
    } as unknown as TurnStreamDeps
    const text = locale === 'zh' ? question : 'Confirm downward beam line loads on all four spans?'
    handlePresentationPayload(turn, deps, { type: 'summary_replace', summaryText: text })
    const event = { type: 'interaction_update' as const, content: { conversationStage: 'awaiting_user_input',
      resumeRequired: true, questions: [{ question: text }], options: ['Confirm'] } }
    handlePresentationPayload(turn, deps, event)
    handlePresentationPayload(turn, deps, event)
    expect(currentPresentationRef.current.summaryText).toBe(text)
    expect(messages.at(-1)?.content).toBe(text)
    const view = render(transcript(messages, text, true))
    expect(screen.getAllByText(text)).toHaveLength(1)
    view.rerender(transcript(messages, text))
    expect(screen.getAllByText(text)).toHaveLength(1)
    expect(screen.getByTestId('pending-clarification')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'endTurn' })).toBeEnabled()
  })

  it('renders a restored question once while retaining reply and end-turn controls', () => {
    render(transcript([message('user', 'user', 'Analyze the frame'), {
      ...message('assistant', 'assistant', question), presentation: presentation(question),
    }]))
    expect(screen.getAllByText(question)).toHaveLength(1)
    expect(screen.getByRole('button', { name: '确认' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'endTurn' }))
  })

  it('shows the runtime question when no visible assistant question was restored', () => {
    render(transcript([message('user', 'user', 'Analyze the frame'), {
      ...message('assistant', 'assistant', question), presentation: presentation('Earlier progress only'),
    }]))
    expect(within(screen.getByTestId('pending-clarification')).getByText(question)).toBeInTheDocument()
    expect(screen.getAllByText(question)).toHaveLength(1)
  })

  it('does not treat a question from a previous user turn as the current prompt', () => {
    render(transcript([message('old-user', 'user', 'Earlier request'), message('old-answer', 'assistant', question),
      message('user', 'user', 'A new request'), message('progress', 'assistant', 'New request progress')]))
    expect(within(screen.getByTestId('pending-clarification')).getByText(question)).toBeInTheDocument()
  })

  it('keeps reply choices disabled until the capability catalog needed for submission is ready', () => {
    const messages = [message('user', 'user', 'Analyze the frame'), message('assistant', 'assistant', question)]
    const view = render(transcript(messages, question, false, false))
    expect(screen.getByRole('button', { name: '确认' })).toBeDisabled()
    view.rerender(transcript(messages))
    expect(screen.getByRole('button', { name: '确认' })).toBeEnabled()
    expect(screen.getAllByText(question)).toHaveLength(1)
  })
})
