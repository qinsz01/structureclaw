import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIConsole } from '@/components/chat/ai-console'
import { AppStoreProvider } from '@/lib/stores/context'

const runtime = (id: string, waitingForReply: boolean) => ({ conversationId: id, busy: false, waitingForReply,
  question: waitingForReply ? 'Support?' : null, options: [], policy: null, usage: null, modelRevision: 1, modelPending: false,
  analysis: { current: false, runId: null, resultKey: null, reason: 'ANALYSIS_REQUIRED' }, report: { current: false, runId: null }, jobs: [] })

function fixture(savedPolicy = false) {
  const sent: Array<{ path: string; body: Record<string, unknown> }> = []
  let failed = false
  const saved = (id: string) => ({ ...runtime(id, id === 'a'), ...(savedPolicy ? { policy: {
    version: 1, policyHash: 'restricted', knowledge: 'disabled', builder: 'llm', skillIds: ['generic'], routing: { mode: 'auto' },
    repair: { enabled: false, maxRecoveriesPerTurn: 0 }, context: { history: 'full', memoryScopes: [] },
    tools: { enabledIds: [], disabledIds: [] }, budgets: { maxToolCallsPerTurn: 20, maxLlmCallsPerTurn: 3 },
    activeSkillIds: ['generic'], activeToolIds: [], deniedSkillIds: [], deniedToolIds: [], executionOwner: 'structureclaw',
    fieldSources: { knowledge: 'session' }, compatibilityNotes: [],
    enforcement: { hostLoop: 'structureclaw', conversationText: 'structureclaw', llmBudget: 'structureclaw-calls', recovery: 'structureclaw-operations' },
  } } : {}) })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/admin/settings')) return Response.json({agent:{runPolicy:{value:{}}}})
    if (url.pathname.endsWith('/files/upload')) return Response.json({ success: true, files: [{ fileId: 'section', originalName: 'section.csv', relPath: '.uploads/a/section.csv', mimeType: 'text/csv', size: 24 }] })
    if (url.pathname.endsWith('/session')) {
      const id = url.pathname.split('/').at(-2)!
      return failed ? Response.json({}, { status: 503 }) : Response.json(saved(id))
    }
    if (url.pathname.endsWith('/conversations')) return Response.json([{ id: 'a', title: 'Paused A' }, { id: 'b', title: 'Ready B' }])
    if (url.pathname.includes('/chat/stream')) {
      sent.push({ path: url.pathname, body: JSON.parse(String(options?.body)) })
      return new Response('data: {"type":"done"}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    const match = url.pathname.match(/\/conversation\/([ab])$/)
    if (match) return Response.json({ id: match[1], title: match[1] === 'a' ? 'Paused A' : 'Ready B', messages: [
      { id: `${match[1]}-message`, role: 'assistant', content: 'Restored conversation', createdAt: '2026-10-14T00:00:00Z' },
    ], session: { model: { note: 'server-owned model' }, runtime: saved(match[1]) } })
    if (url.pathname.endsWith('/conversation')) return Response.json({ id: 'new-chat', title: 'New chat' })
    if (url.pathname.endsWith('/capability-matrix')) return Response.json({ skills: [], tools: [] })
    if (url.pathname.endsWith('/skills') || url.pathname.endsWith('/tools')) return Response.json([])
    return Response.json({})
  })
  return { sent, failState: () => { failed = true } }
}
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); localStorage.clear()
  document.cookie.split(';').forEach(cookie => { document.cookie = `${cookie.split('=')[0].trim()}=; max-age=0; path=/` })
})

describe('web conversation resume routing', () => {
  it.each(['en', 'zh'] as const)('sends each changed run control, including empty memory, from the real console (%s)', async locale => {
    const user = userEvent.setup()
    const { sent } = fixture(true)
    render(<AppStoreProvider initialState={{ locale }}><AIConsole /></AppStoreProvider>)
    await user.click(screen.getByRole('button', { name: /^(Expand History|展开历史)$/ }))
    await user.click(await screen.findByRole('button', { name: 'Ready B' }))
    await waitFor(() => expect(screen.getByText(/restricted/)).toBeInTheDocument())
    await user.click(screen.getByText(locale === 'en' ? 'Conversation settings' : '会话设置'))
    await user.selectOptions(screen.getByLabelText(locale === 'en' ? 'Engineering guidance' : '工程指导'), 'enabled')
    await user.selectOptions(screen.getByLabelText(locale === 'en' ? 'Model builder' : '建模方式'), 'auto')
    const repair = screen.getByLabelText(locale === 'en' ? 'Recovery limit (0 disables recovery)' : '自动纠正次数（0 为关闭）')
    await user.clear(repair); await user.type(repair, '0')
    await user.selectOptions(screen.getByLabelText(locale === 'en' ? 'Conversation context' : '对话上下文'), 'current-turn')
    await user.selectOptions(screen.getByLabelText(locale === 'en' ? 'Memory read and write scopes' : '记忆读写范围'), '')
    await user.type(screen.getByRole('textbox'), 'Use these explicit settings')
    await user.click(screen.getByRole('button', { name: locale === 'en' ? 'Send' : '发送' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].body.context).toMatchObject({ runPolicy: {
      knowledge: 'enabled', builder: 'auto', repair: { enabled: false, maxRecoveriesPerTurn: 0 },
      context: { history: 'current-turn', memoryScopes: [] },
    } })
    expect(sent[0].body.context).not.toHaveProperty('skillIds')
    expect(sent[0].body.context).not.toHaveProperty('enabledToolIds')
  })
  it('keeps saved permissions when opening a conversation instead of sending browser defaults', async () => {
    const user = userEvent.setup()
    const { sent } = fixture(true)
    render(<AppStoreProvider><AIConsole /></AppStoreProvider>)
    await user.click(screen.getByRole('button', { name: 'Expand History' }))
    await user.click(await screen.findByRole('button', { name: 'Ready B' }))
    await waitFor(() => expect(screen.getByText(/restricted/)).toBeInTheDocument())
    await user.type(screen.getByRole('textbox'), 'Continue')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].body.context).not.toHaveProperty('skillIds')
    expect(sent[0].body.context).not.toHaveProperty('enabledToolIds')
    expect(sent[0].body.context).not.toHaveProperty('runPolicy')
  })
  it.each(['en', 'zh'] as const)('freshly loaded pause resumes; switching and a new conversation do not inherit it (%s)', async locale => {
    const user = userEvent.setup()
    const { sent } = fixture()
    render(<AppStoreProvider initialState={{ locale }}><AIConsole /></AppStoreProvider>)
    await user.click(screen.getByRole('button', { name: /^(Expand History|展开历史)$/ }))
    await user.click(await screen.findByRole('button', { name: 'Paused A' }))
    await waitFor(() => expect(screen.getByText(locale === 'en' ? /Waiting for your reply/ : /等待你的答复/)).toBeInTheDocument())
    const upload = document.querySelector('input[type=file]') as HTMLInputElement
    expect(upload.accept).toContain('.json')
    expect(upload.accept).toContain('.tsv')
    await user.upload(upload, new File(['id,A,Iy\nS,0.01,0.0001'], 'section.csv', { type: 'text/csv' }))
    await screen.findByText('section.csv')
    const composer = screen.getByRole('textbox')
    await user.type(composer, 'Pinned')
    await user.click(screen.getByRole('button', { name: locale === 'en' ? 'Send' : '发送' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({ path: '/api/v1/chat/stream/resume', body: { conversationId: 'a', resumeValue: 'Pinned', attachments: [expect.objectContaining({ fileId: 'section', relPath: '.uploads/a/section.csv' })] } })
    await user.click(screen.getByRole('button', { name: /^(Expand History|展开历史)$/ }))
    await user.click(screen.getByRole('button', { name: 'Ready B' }))
    await waitFor(() => expect(screen.queryByText('Support?')).not.toBeInTheDocument())
    await user.type(screen.getByRole('textbox'), 'Calculate B')
    await user.click(screen.getByRole('button', { name: locale === 'en' ? 'Send' : '发送' }))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toMatchObject({ path: '/api/v1/chat/stream', body: { conversationId: 'b' } })
    expect(sent[1].body.context).not.toHaveProperty('model')
    await user.click(screen.getByRole('button', { name: locale === 'en' ? 'New Conversation' : '新建对话' }))
    await user.type(screen.getByRole('textbox'), 'Start anew')
    await user.click(screen.getByRole('button', { name: locale === 'en' ? 'Send' : '发送' }))
    await waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2]).toMatchObject({ path: '/api/v1/chat/stream', body: { conversationId: 'new-chat' } })
  })
  it('refuses to send when the server state cannot be confirmed', async () => {
    const user = userEvent.setup()
    const { sent, failState } = fixture()
    render(<AppStoreProvider><AIConsole /></AppStoreProvider>)
    await user.click(screen.getByRole('button', { name: 'Expand History' }))
    await user.click(await screen.findByRole('button', { name: 'Ready B' }))
    await waitFor(() => expect(screen.getByText(/Model revision/)).toBeInTheDocument())
    failState()
    await user.type(screen.getByRole('textbox'), 'Do not guess the state')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByText(/Server session state is unavailable/)).toBeInTheDocument())
    expect(sent).toEqual([])
  })
})
