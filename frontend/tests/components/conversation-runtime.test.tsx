import { act, renderHook, waitFor, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readConversationRuntime, useConversationRuntime } from '@/components/chat/use-conversation-runtime'

const snapshot = (id: string, waitingForReply = false) => ({ conversationId: id, busy: false, waitingForReply,
  question: waitingForReply ? 'Support?' : null, options: [], modelRevision: 0, modelPending: false,
  policy: null, usage: null, analysis: { current: false, runId: null, resultKey: null, reason: 'ANALYSIS_REQUIRED' },
  report: { current: false, runId: null }, jobs: [] })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('authoritative conversation state', () => {
  it('waits for a slow status read before polling again so the completed session can unlock', async () => {
    vi.useFakeTimers()
    let finish!: (value: Response) => void
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ ...snapshot('a'), busy: true }))
      .mockImplementation(() => new Promise<Response>(resolve => { finish = resolve }))
    const { result } = renderHook(() => useConversationRuntime('a', false))
    await act(async () => {})
    expect(result.current.view?.busy).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => { finish(Response.json(snapshot('a'))) })
    expect(result.current.view?.busy).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('recovers a paused state after a fresh mount, clears it on new chat and rejects late previous-chat responses', async () => {
    let finishA!: (value: Response) => void
    let slow = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const id = String(input).split('/').at(-2)!
      if (id === 'a' && slow) return new Promise<Response>(resolve => { finishA = resolve })
      return Response.json(snapshot(id, id === 'a'))
    })
    const { result, rerender } = renderHook(({ id }) => useConversationRuntime(id, false), { initialProps: { id: 'a' } })
    await waitFor(() => expect(result.current.view?.waitingForReply).toBe(true))
    slow = true
    let pending!: Promise<unknown>
    act(() => { pending = result.current.refresh() })
    rerender({ id: 'b' })
    await waitFor(() => expect(result.current.view?.conversationId).toBe('b'))
    await act(async () => { finishA(Response.json(snapshot('a', true))); await pending })
    expect(result.current.view?.waitingForReply).toBe(false)
    rerender({ id: '' })
    expect(result.current.view).toBeNull()
  })
  it('does not turn unavailable or misbound state into permission to start a new turn', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(snapshot('other')))
    await expect(readConversationRuntime('a')).rejects.toThrow('CONVERSATION_STATE_UNAVAILABLE')
    fetch.mockResolvedValue(Response.json({ error: 'unavailable' }, { status: 503 }))
    await expect(readConversationRuntime('a')).rejects.toThrow('HTTP 503')
    expect(fetch.mock.calls.every(([, options]) => !options || options.method === undefined)).toBe(true)
  })
})
