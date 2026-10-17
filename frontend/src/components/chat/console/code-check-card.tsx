import { Badge } from '@/components/ui/badge'
import type { MessageKey } from '@/lib/i18n'
import type { extractCodeCheckOverview } from '../code-check-overview'

type CodeCheckOverview = NonNullable<ReturnType<typeof extractCodeCheckOverview>>

export function CodeCheckSummaryCard({
  codeCheckOverview,
  t,
}: {
  codeCheckOverview: CodeCheckOverview
  t: (key: MessageKey) => string
}) {
  const codeCheckSummaryNotApplicableText = codeCheckOverview?.summary?.notApplicable
    ? ` · ${t('codeCheckSummaryNotApplicable').replace('{notApplicable}', codeCheckOverview.summary.notApplicable)}`
    : ''
  const codeCheckSummaryText = codeCheckOverview?.summary
    ? `${t('codeCheckSummaryCounts')
      .replace('{total}', codeCheckOverview.summary.total)
      .replace('{passed}', codeCheckOverview.summary.passed)
      .replace('{failed}', codeCheckOverview.summary.failed)
      .replace('{warnings}', codeCheckOverview.summary.warnings)}${codeCheckSummaryNotApplicableText}`
    : ''
  const codeCheckGoverningText = codeCheckOverview?.governing
    ? t('codeCheckSummaryGoverning')
      .replace('{element}', codeCheckOverview.governing.element)
      .replace('{check}', codeCheckOverview.governing.check)
      .replace('{utilization}', codeCheckOverview.governing.utilization)
    : ''
  const codeCheckStatusLabel = codeCheckOverview?.summary?.status === 'failed'
    ? t('codeCheckSummaryStatusFailed')
    : codeCheckOverview?.summary?.status === 'warning'
      ? t('codeCheckSummaryStatusWarning')
      : codeCheckOverview?.summary?.status === 'passed'
        ? t('codeCheckSummaryStatusPassed')
        : ''
  const codeCheckStatusClassName = codeCheckOverview?.summary?.status === 'failed'
    ? 'border-rose-400/40 bg-rose-400/10 text-rose-700 dark:text-rose-200'
    : codeCheckOverview?.summary?.status === 'warning'
      ? 'border-amber-400/40 bg-amber-400/10 text-amber-800 dark:text-amber-200'
      : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-700 dark:text-emerald-200'
  return (
    <div className="rounded-2xl border border-emerald-300/30 bg-emerald-300/10 p-4 dark:border-emerald-200/20 dark:bg-emerald-300/5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-200">{t('codeCheckSummaryTitle')}</div>
          {codeCheckSummaryText ? (
            <div className="mt-2 break-words text-base font-semibold text-foreground">{codeCheckSummaryText}</div>
          ) : null}
          {codeCheckGoverningText ? (
            <div className="mt-2 text-sm text-muted-foreground">{codeCheckGoverningText}</div>
          ) : null}
        </div>
        {codeCheckStatusLabel ? (
          <Badge className={codeCheckStatusClassName} variant="outline">
            {codeCheckStatusLabel}
          </Badge>
        ) : null}
      </div>

      <div className="mt-4">
        <div className="mb-2 text-sm font-medium text-foreground">{t('codeCheckSummaryAttentionItems')}</div>
        {codeCheckOverview.attentionItems.length > 0 ? (
          <div className="space-y-2">
            {codeCheckOverview.attentionItems.map((item, index) => (
              <div key={`${index}-${item.elementId}-${item.check}-${item.item ?? ''}`} className="rounded-xl border border-border/70 bg-background/70 p-3 text-sm dark:border-white/10 dark:bg-white/5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="border-border/70 bg-background/70 text-muted-foreground dark:border-white/10 dark:bg-white/5" variant="outline">
                    {item.status}
                  </Badge>
                  <span className="font-medium text-foreground">
                    {item.scopeKind === 'global' ? t('codeCheckSummaryScopeLabel') : t('codeCheckSummaryElementLabel')} {item.elementId} / {item.check}
                  </span>
                </div>
                {item.item ? (
                  <div className="mt-1 text-sm text-foreground">{item.item}</div>
                ) : null}
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('codeCheckSummaryUtilizationLabel')} {item.utilization}
                  {item.clause ? ` / ${t('codeCheckSummaryClauseLabel')} ${item.clause}` : ''}
                </div>
                {item.message ? (
                  <div className="mt-1 text-xs text-muted-foreground">{item.message}</div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-border/70 bg-background/70 p-3 text-sm text-muted-foreground dark:border-white/10 dark:bg-white/5">
            {t('codeCheckSummaryNoAttention')}
          </div>
        )}
      </div>
    </div>
  )
}
