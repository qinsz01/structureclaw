'use client'

import { useI18n, type MessageKey } from '@/lib/i18n'

export type CapabilityReadiness = {
  generatedAt?: string
  skills?: Array<{ id: string; domain?: string; engineId?: string; name?: { zh?: string; en?: string }; implementationScope?: { zh?: string; en?: string } }>
  engines?: Array<{ id: string; name?: string; environment?: { status: string; reason?: string; checkedAt?: string; scope?: string } }>
  currentAssessment?: {
    status: string; conversationId?: string | null; modelRevision?: number | null; runId?: string | null; codeCheckStatus?: string
    codeCheckCounts?: Record<string, number | null> | null
    issues?: Array<{ kind: string; field: string; reason: string }>; totalIssues?: number; issuesTruncated?: boolean
  }
}

const environmentLabels: Record<string, MessageKey> = {
  available: 'readinessAvailable', unavailable: 'readinessUnavailable', disabled: 'readinessDisabled', unknown: 'readinessUnknown',
}
const assessmentLabels: Record<string, MessageKey> = {
  not_assessed: 'readinessNotAssessed', unavailable: 'readinessUnknown', needs_attention: 'readinessNeedsAttention', current_result: 'readinessCurrentResult',
}

export function CapabilityReadinessPanel({ matrix, conversations, conversationId, onConversationChange, loading, failed }: {
  matrix: CapabilityReadiness | null
  conversations: Array<{ id: string; title?: string }>
  conversationId: string
  onConversationChange: (id: string) => void
  loading: boolean
  failed: boolean
}) {
  const { t, locale } = useI18n()
  const assessment = matrix?.currentAssessment
  return <section aria-label={t('readinessTitle')} className="space-y-4 rounded-3xl border border-border/70 bg-background/75 p-5">
    <div><h2 className="text-base font-semibold">{t('readinessTitle')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('readinessIntro')}</p></div>
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="rounded-2xl border border-border/60 p-4">
        <h3 className="text-sm font-semibold">{t('readinessImplementation')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('readinessImplementationHint')}</p>
        <div className="mt-3 space-y-2">{matrix?.skills?.filter(skill => skill.domain === 'analysis').map(skill =>
          <details key={skill.id} className="rounded-xl bg-muted/40 p-3">
            <summary className="cursor-pointer text-sm font-medium">{skill.name?.[locale] || skill.id}</summary>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{skill.implementationScope?.[locale] || t('readinessUnknown')}</p>
          </details>)}</div>
      </div>
      <div className="rounded-2xl border border-border/60 p-4">
        <h3 className="text-sm font-semibold">{t('readinessEnvironment')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('readinessEnvironmentHint')}</p>
        <ul className="mt-3 space-y-3">{matrix?.engines?.map(engine => <li key={engine.id} className="rounded-xl bg-muted/40 p-3">
          <div className="flex flex-wrap justify-between gap-2 text-sm"><span>{engine.name || engine.id}</span>
            <span className={engine.environment?.status === 'available' ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}>
              {t(environmentLabels[engine.environment?.status ?? 'unknown'] ?? 'readinessUnknown')}</span></div>
          {engine.environment?.reason && <p className="mt-1 break-words text-xs text-muted-foreground">{engine.environment.reason}</p>}
          {engine.environment?.checkedAt && <time className="mt-1 block text-xs text-muted-foreground" dateTime={engine.environment.checkedAt}>{engine.environment.checkedAt}</time>}
        </li>)}</ul>
        {!matrix?.engines?.length && <p className="mt-3 text-sm text-muted-foreground">{t('readinessUnknown')}</p>}
      </div>
    </div>
    <div className="rounded-2xl border border-border/60 p-4">
      <label htmlFor="capability-conversation" className="text-sm font-semibold">{t('readinessCurrentInput')}</label>
      <select id="capability-conversation" value={conversationId} onChange={event => onConversationChange(event.target.value)}
        className="mt-2 block w-full rounded-xl border border-border bg-background px-3 py-2 text-sm">
        <option value="">{t('readinessChooseConversation')}</option>
        {conversations.map(conversation => <option key={conversation.id} value={conversation.id}>{conversation.title || conversation.id}</option>)}
      </select>
      <p className="mt-3 text-sm" role="status">{failed ? t('readinessLoadFailed') : loading ? t('readinessLoading')
        : t(assessmentLabels[assessment?.status ?? 'not_assessed'] ?? 'readinessUnknown')}</p>
      {!loading && !failed && assessment?.conversationId && <>
        <p className="mt-1 break-all text-xs text-muted-foreground">{t('readinessRevision')}: {assessment.modelRevision ?? '—'} · {t('readinessRun')}: {assessment.runId ?? '—'}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('readinessCodeCheck')}: {assessment.codeCheckStatus || '—'}</p>
        {assessment.codeCheckCounts && <p className="mt-1 text-xs text-muted-foreground">{t('readinessCheckCounts')}: {['passed','failed','inputRequired','unsupported'].map(key => assessment.codeCheckCounts?.[key] ?? '—').join(' / ')}</p>}
        {!!assessment.issues?.length && <ul className="mt-3 max-h-56 space-y-2 overflow-auto text-xs">{assessment.issues.map((issue, index) =>
          <li key={`${issue.kind}:${issue.field}:${index}`} className="rounded-lg bg-amber-100/50 p-2 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <span className="font-mono">{issue.field}</span><span className="ml-2 break-words">{issue.reason}</span>
          </li>)}</ul>}
        {assessment.issuesTruncated && <p className="mt-2 text-xs text-muted-foreground">{t('readinessMoreIssues')} ({assessment.totalIssues})</p>}
      </>}
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('readinessCurrentHint')}</p>
    </div>
  </section>
}
