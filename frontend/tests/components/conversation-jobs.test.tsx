import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationJobs } from '@/components/chat/conversation-jobs'
import type { ConversationRuntimeSnapshot } from '@/components/chat/use-conversation-runtime'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const snapshot = (id = 'conversation-a'): ConversationRuntimeSnapshot => ({ conversationId: id, busy: true, waitingForReply: false,
  question: null, options: [], modelRevision: 2, modelPending: false, policy: null, usage: null,
  analysis: { runId: null, resultKey: null, current: false, reason: null }, report: { current: false, runId: null },
  jobs: [{ requestId: 'job-a', kind: 'analysis', status: 'running', runId: 'run-a', cancellationAvailable: true, stateHash: 'a'.repeat(64) }] })

describe('same conversation jobs', () => {
  it.each(['en', 'zh'] as const)('permits cancellation during a busy chat and sends its inspected state hash (%s)', async locale => {
    const refresh = vi.fn(), fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'cancellation_requested' }) })
    vi.stubGlobal('fetch', fetch)
    render(<ConversationJobs runtime={snapshot()} locale={locale} onRefresh={refresh} />)
    const button = screen.getByRole('button', { name: locale === 'en' ? 'Cancel job' : '取消作业' })
    expect(button).not.toBeDisabled(); fireEvent.click(button)
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/conversation-a/job-a/cancel'), expect.objectContaining({ body: JSON.stringify({ expectedStateHash: 'a'.repeat(64) }) }))
    expect(screen.getByRole('status')).toHaveTextContent(locale === 'en' ? 'waiting for the job' : '等待作业')
    expect(screen.getByText(/job-a/)).toHaveTextContent(locale === 'en' ? 'Running' : '运行中') // Receipt, not optimistic UI, owns completion.
  })
  it('does not offer unowned cancellation and recovery never resubmits a solve', async () => {
    const runtime = snapshot(); runtime.busy = false
    runtime.jobs[0] = { ...runtime.jobs[0], cancellationAvailable: false, recoveryAvailable: true, status: 'outcome_unknown' }
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'ANALYSIS_REQUEST_STATE_CHANGED' }) })
    vi.stubGlobal('fetch', fetch)
    render(<ConversationJobs runtime={runtime} locale="en" />)
    expect(screen.queryByRole('button', { name: 'Cancel job' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Verify archive and add to history' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('STATE_CHANGED'))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toContain('/recover')
  })
  it('ignores a late action response after the selected conversation changes', async () => {
    let finish!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(resolve => { finish = resolve })))
    const refresh = vi.fn()
    const { rerender } = render(<ConversationJobs runtime={snapshot()} locale="en" onRefresh={refresh} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel job' }))
    rerender(<ConversationJobs runtime={snapshot('conversation-b')} locale="en" onRefresh={refresh} />)
    finish({ ok: true, json: async () => ({}) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel job' })).not.toBeDisabled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument(); expect(refresh).not.toHaveBeenCalled()
  })
})
