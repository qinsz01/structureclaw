import { BrainCircuit, Cuboid } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import type { VisualizationSnapshot } from '@/components/visualization/types'
import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import type { AgentResult } from './types'
import { extractSeismicContext } from './seismic-context'

export function ContextTabContent({
  result,
  modelVisualizationSnapshot,
  onOpenVisualization,
  t,
  locale,
  modelText,
  onModelTextChange,
  modelSyncMessage,
  parsedComposerModelError,
}: {
  result: AgentResult | null
  modelVisualizationSnapshot: VisualizationSnapshot | null
  onOpenVisualization: (source: 'result' | 'model') => void
  t: (key: MessageKey) => string
  locale: AppLocale
  modelText?: string
  onModelTextChange?: (text: string) => void
  modelSyncMessage?: string
  parsedComposerModelError?: string | null
}) {
  const seismicContext = extractSeismicContext(result, t, locale)
  return (
    <div className="flex h-full flex-col gap-4">
      <Card className="flex flex-1 flex-col border-border/70 bg-card/85 text-foreground shadow-none dark:border-white/10 dark:bg-slate-950/50">
        <CardHeader className="shrink-0">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Cuboid className="h-5 w-5 text-cyan-500 dark:text-cyan-300" />
            {t('contextSectionModel')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
          <p className="shrink-0 text-xs leading-5 text-muted-foreground">{t('contextSectionModelHelp')}</p>
          {seismicContext && (
            <details
              data-testid="seismic-context-details"
              className="shrink-0 rounded-xl border border-border/70 bg-background/70 px-3 py-2 dark:border-white/10 dark:bg-white/5"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 items-center gap-2">
                  <BrainCircuit className="h-4 w-4 shrink-0 text-cyan-600 dark:text-cyan-300" />
                  <span className="truncate">{t('seismicContextTitle')}</span>
                </span>
                {seismicContext.status ? (
                  <Badge variant="outline" className="shrink-0 border-amber-400/40 bg-amber-400/10 text-amber-800 dark:text-amber-200">
                    {seismicContext.status}
                  </Badge>
                ) : null}
              </summary>
              <div className="mt-3 space-y-3">
                <p className="text-xs leading-5 text-muted-foreground">{t('seismicContextHelp')}</p>
                {seismicContext.summaryRows.length > 0 && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {seismicContext.summaryRows.map((row) => (
                      <div key={`seismic-summary-${row.label}`} className="min-w-0 rounded-lg border border-border/50 bg-muted/25 px-3 py-2 dark:border-white/10 dark:bg-white/5">
                        <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{row.label}</div>
                        <div className="mt-1 break-words text-sm font-medium text-foreground">{row.value}</div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="space-y-2">
                  {seismicContext.parameterRows.map((row) => (
                    <div key={`seismic-param-${row.label}`} className="min-w-0 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs dark:border-white/10 dark:bg-white/5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{row.label}</span>
                        {row.assumed ? (
                          <Badge variant="outline" className="border-amber-400/40 bg-amber-400/10 text-[10px] text-amber-800 dark:text-amber-200">
                            {t('seismicContextAssumed')}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 break-words text-sm text-foreground">{row.value}</div>
                      {row.source ? (
                        <div className="mt-1 break-words text-muted-foreground">
                          {t('seismicContextSource')}: {row.source}
                        </div>
                      ) : null}
                      {row.note ? (
                        <div className="mt-1 break-words text-muted-foreground">
                          {t('seismicContextNote')}: {row.note}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </details>
          )}
          {modelVisualizationSnapshot && (
            <Button
              type="button"
              className="shrink-0 rounded-2xl border border-cyan-300/35 bg-cyan-300/10 px-4 text-cyan-800 hover:bg-cyan-300/20 dark:text-cyan-100"
              onClick={() => onOpenVisualization('model')}
            >
              <Cuboid className="h-4 w-4" />
              {t('visualizationPreviewModel')}
            </Button>
          )}
          <Textarea
            className="min-h-0 flex-1 resize-none rounded-xl border border-border/70 bg-background/70 font-mono text-xs dark:border-white/10 dark:bg-white/5"
            placeholder={t('modelJsonPlaceholder')}
            value={modelText || ''}
            onChange={(e) => onModelTextChange?.(e.target.value)}
          />
          {modelSyncMessage && (
            <div className="shrink-0 rounded-2xl border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-xs leading-5 text-cyan-900 dark:text-cyan-100">
              {modelSyncMessage}
            </div>
          )}
          {parsedComposerModelError ? (
            <div className="shrink-0 rounded-2xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-100">
              {parsedComposerModelError}
              {modelVisualizationSnapshot ? ` ${t('visualizationModelInvalidKeepingLast')}` : ''}
            </div>
          ) : modelVisualizationSnapshot ? (
            <div className="shrink-0 text-xs leading-5 text-muted-foreground">
              {t('visualizationModelPreviewHelp')}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
