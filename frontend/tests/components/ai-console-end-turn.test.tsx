import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIConsole } from '@/components/chat/ai-console'
import { AppStoreProvider } from '@/lib/stores/context'

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); localStorage.clear()
  document.cookie.split(';').forEach(cookie => { document.cookie = `${cookie.split('=')[0].trim()}=; max-age=0; path=/` })
})

describe('explicitly ending a paused conversation turn', () => {
  it.each([
    ['en', true], ['zh', true], ['en', false], ['zh', false],
  ] as const)('requires a click and uses authoritative runtime afterwards (%s, success=%s)', async (locale, succeeds) => {
    const user = userEvent.setup()
    const id = `end-turn-${locale}-${succeeds}`
    const endLabel = locale === 'en' ? 'End turn' : '结束本轮'
    const choice = locale === 'en' ? 'Use the original section' : '使用原截面'
    const sent: Array<{ path: string; method?: string; body?: Record<string, unknown> }> = []
    const runtime = { conversationId: id, busy: false, waitingForReply: true,
      question: locale === 'en' ? 'Which section should I use?' : '使用哪个截面？', options: [choice],
      policy: null, usage: { runId: 'paused-run', tools: 3, llmCalls: 2, recoveries: 0 }, modelRevision: 4, modelPending: false,
      analysis: { current: false, runId: null, resultKey: null, reason: 'ANALYSIS_REQUIRED' },
      report: { current: false, runId: null }, jobs: [] }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/admin/settings')) return Response.json({agent:{runPolicy:{value:{}}}})
      if (url.pathname.endsWith('/session')) return Response.json(runtime)
      if (url.pathname.endsWith('/conversations')) return Response.json([{ id, title: 'Paused beam' }])
      if (url.pathname.endsWith(`/conversation/${id}`)) return Response.json({ id, title: 'Paused beam', messages: [
        { id: 'user', role: 'user', content: 'Calculate the beam', createdAt: '2026-10-14T00:00:00Z' },
        { id: 'assistant', role: 'assistant', content: 'Preserved beam history', createdAt: '2026-10-14T00:00:01Z' },
      ], session: { runtime } })
      if (url.pathname.endsWith('/turn/end')) {
        sent.push({ path: url.pathname, method: options?.method, body: JSON.parse(String(options?.body)) })
        if (!succeeds) return Response.json({ message: 'Conversation is busy' }, { status: 409 })
        runtime.waitingForReply = false
        runtime.options = []
        return Response.json({ success: true, runtime })
      }
      if (url.pathname.includes('/chat/stream')) {
        sent.push({ path: url.pathname, method: options?.method, body: JSON.parse(String(options?.body)) })
        runtime.waitingForReply = false
        return new Response('data: {"type":"done"}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.pathname.endsWith('/capability-matrix')) return Response.json({ skills: [], tools: [] })
      if (url.pathname.endsWith('/skills') || url.pathname.endsWith('/tools')) return Response.json([])
      return Response.json({})
    })
    render(<AppStoreProvider initialState={{ locale }}><AIConsole /></AppStoreProvider>)
    await user.click(screen.getByRole('button', { name: /^(Expand History|展开历史)$/ }))
    await user.click(await screen.findByRole('button', { name: 'Paused beam' }))
    const endButton = await screen.findByRole('button', { name: endLabel })
    await screen.findByText(locale === 'en' ? /Waiting for your reply/ : /等待你的答复/)
    expect(sent).toHaveLength(0)
    await user.click(endButton)
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual({ path: `/api/v1/chat/conversation/${id}/turn/end`, method: 'POST', body: { expectedRunId: 'paused-run' } })
    if (succeeds) {
      await waitFor(() => expect(screen.queryByTestId('pending-clarification')).not.toBeInTheDocument())
      expect(screen.queryByRole('button', { name: choice })).not.toBeInTheDocument()
      expect(within(screen.getByTestId('console-chat-panel')).getByText('Preserved beam history')).toBeInTheDocument()
      await user.type(screen.getByRole('textbox'), 'Start the next request')
      await user.click(screen.getByRole('button', { name: locale === 'en' ? 'Send' : '发送' }))
      await waitFor(() => expect(sent).toHaveLength(2))
      expect(sent[1]).toMatchObject({ path: '/api/v1/chat/stream', body: { conversationId: id } })
      expect(sent[1].body?.context).not.toHaveProperty('model')
    } else {
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(locale === 'en' ? 'Failed to end this turn.' : '结束本轮失败。')
      expect(alert).toHaveTextContent(locale === 'en' ? 'Refresh the conversation status and try again.' : '请刷新会话状态后重试。')
      expect(screen.getByTestId('pending-clarification')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: choice }))
      await waitFor(() => expect(sent).toHaveLength(2))
      expect(sent[1]).toMatchObject({ path: '/api/v1/chat/stream/resume', body: { conversationId: id, resumeValue: choice } })
    }
    await screen.findByRole('button', { name: locale === 'en' ? 'Send' : '发送' })
  })
})
