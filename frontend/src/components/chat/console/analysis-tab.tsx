import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { VisualizationSnapshot } from '@/components/visualization/types'
import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { MarkdownBody } from '../markdown-body'
import { extractCodeCheckOverview } from '../code-check-overview'
import type { AgentResult } from './types'
import { extractAnalysis } from './result-utils'
import { extractSummaryStats } from './summary-stats'
import { extractEngineLabel } from './engine-label'
import { CodeCheckSummaryCard } from './code-check-card'
import { GuidanceCard } from './guidance-card'

export function AnalysisTabContent({
  result,
  modelVisualizationSnapshot,
  visualizationSnapshot,
  t,
  locale,
}: {
  result: AgentResult
  modelVisualizationSnapshot: VisualizationSnapshot | null
  visualizationSnapshot: VisualizationSnapshot | null
  t: (key: MessageKey) => string
  locale: AppLocale
}) {
  const analysis = extractAnalysis(result)
  const stats = extractSummaryStats(analysis, t, locale)
  const engineInfo = extractEngineLabel(analysis, result, t)
  const codeCheckOverview = extractCodeCheckOverview(result, locale)
  const guidance = result?.interaction
  return (
    <div className="space-y-4">
      <Card className="border-border/70 bg-card/85 text-foreground shadow-none dark:border-white/10 dark:bg-slate-950/50">
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="border-emerald-400/30 bg-emerald-400/15 text-emerald-200" variant="outline">
              {result.success ? t('analysisDone') : result.needsModelInput ? t('needsMoreInfo') : t('returnedResult')}
            </Badge>
            {!visualizationSnapshot && (
              <Badge className="border-amber-300/30 bg-amber-300/10 text-amber-800 dark:text-amber-200" variant="outline">
                {modelVisualizationSnapshot ? t('visualizationFallbackToModel') : t('visualizationMissingModel')}
              </Badge>
            )}
            {result.traceId && (
              <Badge className="border-border/70 bg-background/70 text-muted-foreground dark:border-white/10 dark:bg-white/5" variant="outline">
                Trace {result.traceId.slice(0, 8)}
              </Badge>
            )}
            {typeof result.durationMs === 'number' && (
              <Badge className="border-cyan-400/30 bg-cyan-400/10 text-cyan-200" variant="outline">
                {result.durationMs} ms
              </Badge>
            )}
          </div>
          <div>
            <CardTitle className="text-xl text-foreground">{t('executionSummary')}</CardTitle>
            <MarkdownBody compact content={result.response || t('noNaturalLanguageSummary')} />
          </div>
        </CardHeader>
        {(stats.length > 0 || result.plan?.length || codeCheckOverview) && (
          <CardContent className="space-y-4">
            {engineInfo && (
              <div className="rounded-2xl border border-cyan-300/30 bg-cyan-300/10 p-4 dark:border-cyan-200/20 dark:bg-cyan-300/5">
                <div className="text-xs uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-200">{engineInfo.label}</div>
                <div className="mt-2 text-base font-semibold text-foreground">{engineInfo.value}</div>
                <div className="mt-2 text-sm text-muted-foreground">{engineInfo.modeLabel}</div>
                {engineInfo.requestedEngineId ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('analysisEngineRequestedLabel')} {engineInfo.requestedEngineId}
                  </div>
                ) : null}
                {engineInfo.engineId ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('analysisEngineActualLabel')} {engineInfo.engineId}
                  </div>
                ) : null}
                {engineInfo.fallbackFrom ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('analysisEngineFallbackFrom')} {engineInfo.fallbackFrom}
                  </div>
                ) : null}
                {engineInfo.unavailableReason ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {engineInfo.unavailableReason}
                  </div>
                ) : null}
              </div>
            )}
            {codeCheckOverview && <CodeCheckSummaryCard codeCheckOverview={codeCheckOverview} t={t} />}
            {stats.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {stats.map((item) => (
                  <div key={item.label} className="rounded-2xl border border-border/70 bg-background/70 p-4 dark:border-white/10 dark:bg-white/5">
                    <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{item.label}</div>
                    <div className="mt-2 break-words text-xl font-semibold leading-snug text-foreground">{item.value}</div>
                  </div>
                ))}
              </div>
            )}
            {result.plan?.length ? (
              <div className="rounded-2xl border border-border/70 bg-background/70 p-4 dark:border-white/10 dark:bg-white/5">
                <div className="mb-3 text-sm font-medium text-foreground">{t('executionPath')}</div>
                <ol className="space-y-2 text-sm text-muted-foreground">
                  {result.plan.map((step, index) => (
                    <li key={`${index}-${step}`} className="flex gap-3">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-400/15 text-[11px] text-cyan-700 dark:text-cyan-200">
                        {index + 1}
                      </span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </CardContent>
        )}
      </Card>

      {result.clarification?.question && (
        <Card className="border-amber-300/30 bg-amber-100/70 text-amber-950 shadow-none dark:bg-amber-300/10 dark:text-amber-50">
          <CardHeader>
            <CardTitle className="text-lg">{t('clarificationTitle')}</CardTitle>
            <CardDescription className="text-amber-900/80 dark:text-amber-100/80">
              {result.clarification.question}
            </CardDescription>
          </CardHeader>
          {result.clarification.missingFields?.length ? (
            <CardContent className="flex flex-wrap gap-2">
              {result.clarification.missingFields.map((field) => (
                <Badge key={field} className="border-amber-300/40 bg-amber-50/80 text-amber-950 dark:border-amber-200/20 dark:bg-black/10 dark:text-amber-50" variant="outline">
                  {field}
                </Badge>
              ))}
            </CardContent>
          ) : null}
        </Card>
      )}

      {guidance && <GuidanceCard guidance={guidance} result={result} t={t} />}

      {analysis && (
        <Card className="border-border/70 bg-card/85 text-foreground shadow-none dark:border-white/10 dark:bg-slate-950/50">
          <CardHeader>
            <CardTitle className="text-lg">{t('structuredResult')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('structuredResultDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-2xl border border-border/70 bg-muted/60 p-4 text-xs leading-6 text-cyan-900 dark:border-white/10 dark:bg-black/30 dark:text-cyan-100">
              {JSON.stringify(analysis, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
