'use client'

import { useEffect, useRef, useState } from 'react'
import { API_BASE } from '@/lib/api-base'
import type { ConversationRuntimeSnapshot } from './use-conversation-runtime'

/** Job data are always the server projection; local state only tracks the button request. */
export function ConversationJobs({ runtime, locale, onRefresh }: {
  runtime: ConversationRuntimeSnapshot; locale: 'zh' | 'en'; onRefresh?: () => void
}) {
  const zh = locale === 'zh'
  const [pending, setPending] = useState('')
  const [message, setMessage] = useState('')
  const active = useRef(runtime.conversationId)
  const sequence = useRef(0)
  active.current = runtime.conversationId
  useEffect(() => {
    const counter = sequence
    ++counter.current; setPending(''); setMessage('')
    return () => { ++counter.current }
  }, [runtime.conversationId])
  const status = (value: string) => ({ running: zh ? '运行中' : 'Running', completed: zh ? '已完成' : 'Completed',
    failed: zh ? '失败' : 'Failed', cancelled: zh ? '已取消' : 'Cancelled', outcome_unknown: zh ? '结果待核查' : 'Outcome unknown' }[value] ?? value)
  async function act(job: ConversationRuntimeSnapshot['jobs'][number], action: 'cancel' | 'recover') {
    if (pending || !job.stateHash) return
    const id = runtime.conversationId
    const request = ++sequence.current
    const current = () => active.current === id && sequence.current === request
    setPending(job.requestId); setMessage('')
    try {
      const response = await fetch(`${API_BASE}/api/v1/agent/jobs/${encodeURIComponent(id)}/${encodeURIComponent(job.requestId)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedStateHash: job.stateHash }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      if (!current()) return
      setMessage(action === 'cancel' ? (zh ? '已请求取消，等待作业确认结束。' : 'Cancellation requested; waiting for the job to stop.')
        : (zh ? '归档已加入历史结果，当前模型与结果未变。' : 'Archive added to history; current model and results are unchanged.'))
      onRefresh?.()
    } catch (error) {
      if (!current()) return
      setMessage(`${zh ? '操作未完成，请刷新状态后核查：' : 'Action not completed; refresh the state and inspect: '}${error instanceof Error ? error.message : String(error)}`)
      onRefresh?.()
    } finally { if (current()) setPending('') }
  }
  if (!runtime.jobs.length) return null
  return <section className="space-y-2 border-t border-border/50 pt-2" aria-label={zh ? '计算作业' : 'Analysis jobs'}>
    <p className="font-medium text-foreground">{zh ? '计算作业' : 'Analysis jobs'}</p>
    {runtime.jobs.map(job => <div key={job.requestId} className="space-y-1">
      <p className="break-all">{job.kind === 'native-design' ? (zh ? '原生设计' : 'Native design') : (zh ? '计算' : 'Analysis')} · {status(job.status)} · {job.requestId}</p>
      {job.runId && <p className="break-all">{zh ? '运行' : 'Run'}: {job.runId}{job.inHistory ? (zh ? ' · 已在历史中' : ' · In history') : ''}</p>}
      <div className="flex gap-3">
        {job.cancellationAvailable && job.stateHash && <button type="button" disabled={Boolean(pending)} onClick={() => void act(job, 'cancel')} className="underline disabled:opacity-50">{zh ? '取消作业' : 'Cancel job'}</button>}
        {job.recoveryAvailable && job.stateHash && <button type="button" disabled={Boolean(pending) || runtime.busy} onClick={() => void act(job, 'recover')} className="underline disabled:opacity-50">{zh ? '核验归档并加入历史' : 'Verify archive and add to history'}</button>}
      </div>
      {job.recoveryAvailable && <p>{zh ? '仅恢复匹配的完整归档，不重新计算。' : 'Only a matching complete archive can be restored; no recalculation.'}</p>}
      {job.status === 'outcome_unknown' && !job.recoveryAvailable && <p>{zh ? '尚不能确认可恢复的归档；请核查作业输出后再操作。' : 'A recoverable archive is not confirmed; inspect the job output before proceeding.'}</p>}
    </div>)}
    {message && <p role="status" className="break-words">{message}</p>}
  </section>
}
