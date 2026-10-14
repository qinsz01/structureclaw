import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIConsole } from '@/components/chat/ai-console'
import { normalizeClarificationOptions } from '@/components/chat/clarification-options'
import { AppStoreProvider } from '@/lib/stores/context'

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); localStorage.clear()
  document.cookie.split(';').forEach(cookie => { document.cookie = `${cookie.split('=')[0].trim()}=; max-age=0; path=/` })
})

describe('clarification choices from older sessions and model responses', () => {
  it('keeps readable choices and drops malformed objects without coercing them to text', () => {
    expect(normalizeClarificationOptions([' A ', { label: 'B', value: 'hidden' }, { text: 'C' }, { value: 'D' },
      { label: '', value: 'E' }, null, 3, { label: {} }, 'A', ''])).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(normalizeClarificationOptions({ options: ['A'] })).toEqual([])
  })

  it.each([
    ['en', 'restored'], ['zh', 'restored'], ['en', 'stream'], ['zh', 'stream'],
  ] as const)('renders object options and submits the visible text (%s, %s)', async (locale, entry) => {
    const user = userEvent.setup()
    const id = `old-${locale}-${entry}`
    const label = locale === 'en' ? 'Use steel Q235' : '使用 Q235 钢材'
    const question = locale === 'en' ? 'Which beam material and section should I use?' : '请确认梁的材料和截面。'
    const sent: Array<Record<string, unknown>> = []
    const runtime = { conversationId: id, busy: false, waitingForReply: entry === 'restored', question,
      options: [{ label, value: 'Q235' }, { label: {} }], policy: null, usage: null, modelRevision: 0, modelPending: false,
      analysis: { current: false, runId: null, resultKey: null, reason: 'ANALYSIS_REQUIRED' },
      report: { current: false, runId: null }, jobs: [] }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/session')) return Response.json(runtime)
      if (url.pathname.endsWith('/conversations')) return Response.json([{ id, title: 'Old clarification' }])
      if (url.pathname.endsWith(`/conversation/${id}`)) return Response.json({ id, title: 'Old clarification',
        messages: [
          { id: 'old-user', role: 'user', content: 'Calculate a beam', createdAt: '2026-10-14T00:00:00Z' },
          { id: 'old-msg', role: 'assistant', content: question, createdAt: '2026-10-14T00:00:01Z',
            metadata: { presentation: { version: 3, mode: 'conversation', status: 'done',
              summaryText: 'templateProperties.material missing', phases: [], artifacts: [] } } },
        ],
        session: { runtime } })
      if (url.pathname.endsWith('/stream/resume')) {
        sent.push(JSON.parse(String(options?.body)))
        runtime.waitingForReply = false
        return new Response('data: {"type":"done"}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.pathname.endsWith('/chat/stream')) {
        runtime.waitingForReply = true
        const interaction = { type: 'interaction_update', content: { questions: [{ question }], options: runtime.options } }
        return new Response(`data: ${JSON.stringify(interaction)}\n\ndata: {"type":"done"}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.pathname.endsWith('/skills') || url.pathname.endsWith('/tools')) return Response.json([])
      return Response.json({})
    })
    render(<AppStoreProvider initialState={{ locale }}><AIConsole /></AppStoreProvider>)
    await user.click(await screen.findByRole('button', { name: 'Old clarification' }))
    if (entry === 'stream') {
      await user.type(screen.getByRole('textbox'), 'Calculate the beam')
      await user.click(screen.getByRole('button', { name: locale === 'en' ? 'Send' : '发送' }))
    }
    await screen.findByText(locale === 'en' ? /Waiting for your reply/ : /等待你的答复/)
    expect(within(await screen.findByTestId('pending-clarification')).getByText(question)).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: label }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({ conversationId: id, resumeValue: label })
    await screen.findByRole('button', { name: locale === 'en' ? 'Send' : '发送' })
    await waitFor(() => expect(screen.queryByTestId('pending-clarification')).not.toBeInTheDocument())
  })
})
