'use client'

import { Cuboid, Orbit } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { VisualizationSnapshot } from '@/components/visualization/types'
import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { cn } from '@/lib/utils'
import type { PanelTab, AgentResult } from './types'
import { AnalysisTabContent } from './analysis-tab'
import { ReportTabContent } from './report-tab'
import { ContextTabContent } from './context-tab'

export function AnalysisPanel({
  result,
  modelVisualizationSnapshot,
  visualizationSnapshot,
  onOpenVisualization,
  activeTab,
  onTabChange,
  t,
  locale,
  panelIdPrefix = 'output',
  modelText,
  onModelTextChange,
  modelSyncMessage,
  parsedComposerModelError,
}: {
  result: AgentResult | null
  modelVisualizationSnapshot: VisualizationSnapshot | null
  visualizationSnapshot: VisualizationSnapshot | null
  onOpenVisualization: (source: 'result' | 'model') => void
  activeTab: PanelTab
  onTabChange: (tab: PanelTab) => void
  t: (key: MessageKey) => string
  locale: AppLocale
  panelIdPrefix?: string
  modelText?: string
  onModelTextChange?: (text: string) => void
  modelSyncMessage?: string
  parsedComposerModelError?: string | null
}) {
  const hasVisualizationData = Boolean(visualizationSnapshot || modelVisualizationSnapshot)
  const showVisualizationAction = Boolean(result || visualizationSnapshot)
  const contextTabId = `${panelIdPrefix}-tab-context`
  const analysisTabId = `${panelIdPrefix}-tab-analysis`
  const reportTabId = `${panelIdPrefix}-tab-report`
  const tabPanelId = `${panelIdPrefix}-tabpanel-output`

  return (
    <div
      data-testid="console-output-panel"
      className="flex h-full min-h-[320px] flex-col bg-card/95 xl:min-h-0 dark:bg-slate-950/90"
    >
      <div className="flex flex-col gap-4 border-b border-border/70 px-5 py-4 sm:flex-row sm:items-start sm:justify-between dark:border-white/10">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-700/80 dark:text-cyan-200/70">{t('workspaceOutput')}</p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">{t('analysisAndReport')}</h2>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:min-w-[220px] sm:items-end">
          {showVisualizationAction && (
            <Button
              className="h-11 w-full justify-center rounded-2xl border border-cyan-300/35 bg-cyan-300/10 px-4 text-cyan-800 hover:bg-cyan-300/20 sm:w-auto dark:text-cyan-100"
              disabled={!hasVisualizationData}
              onClick={() => onOpenVisualization('result')}
              title={
                !visualizationSnapshot && !modelVisualizationSnapshot
                  ? t('visualizationMissingModel')
                  : !visualizationSnapshot && modelVisualizationSnapshot
                    ? t('visualizationFallbackToModel')
                    : t('visualizationOpen')
              }
              type="button"
              variant="outline"
            >
              <Cuboid className="h-4 w-4" />
              {!visualizationSnapshot && modelVisualizationSnapshot ? t('visualizationPreviewModel') : t('visualizationOpen')}
            </Button>
          )}
          <div className="grid w-full grid-cols-3 rounded-2xl border border-border/70 bg-background/70 p-1 sm:w-auto dark:border-white/10 dark:bg-white/5"
            role="tablist" aria-label={t('workspaceOutput')}
            onKeyDown={(e) => {
              const tabs: PanelTab[] = ['context', 'analysis', 'report']
              const currentIndex = tabs.indexOf(activeTab)
              const tabCount = tabs.length
              if (e.key === 'ArrowRight') {
                e.preventDefault()
                const nextTab = tabs[(currentIndex + 1) % tabCount]
                onTabChange(nextTab)
                requestAnimationFrame(() => { document.getElementById(`${panelIdPrefix}-tab-${nextTab}`)?.focus() })
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault()
                const prevTab = tabs[(currentIndex - 1 + tabCount) % tabCount]
                onTabChange(prevTab)
                requestAnimationFrame(() => { document.getElementById(`${panelIdPrefix}-tab-${prevTab}`)?.focus() })
              } else if (e.key === 'Home') {
                e.preventDefault()
                onTabChange('context')
                requestAnimationFrame(() => { document.getElementById(`${panelIdPrefix}-tab-context`)?.focus() })
              } else if (e.key === 'End') {
                e.preventDefault()
                onTabChange('report')
                requestAnimationFrame(() => { document.getElementById(reportTabId)?.focus() })
              }
            }}
          >
            <button
              className={cn(
                'rounded-xl px-4 py-2.5 text-sm font-medium transition',
                activeTab === 'context'
                  ? 'bg-foreground text-background shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onTabChange('context')}
              type="button"
              role="tab"
              id={`${panelIdPrefix}-tab-context`}
              aria-selected={activeTab === 'context'}
              aria-controls={tabPanelId}
              tabIndex={activeTab === 'context' ? 0 : -1}
            >
              {t('contextTab')}
            </button>
            <button
              className={cn(
                'rounded-xl px-4 py-2.5 text-sm font-medium transition',
                activeTab === 'analysis'
                  ? 'bg-foreground text-background shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onTabChange('analysis')}
              type="button"
              role="tab"
              id={analysisTabId}
              aria-selected={activeTab === 'analysis'}
              aria-controls={tabPanelId}
              tabIndex={activeTab === 'analysis' ? 0 : -1}
            >
              {t('analysisTab')}
            </button>
            <button
              className={cn(
                'rounded-xl px-4 py-2.5 text-sm font-medium transition',
                activeTab === 'report'
                  ? 'bg-foreground text-background shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onTabChange('report')}
              type="button"
              role="tab"
              id={reportTabId}
              aria-selected={activeTab === 'report'}
              aria-controls={tabPanelId}
              tabIndex={activeTab === 'report' ? 0 : -1}
            >
              {t('reportTab')}
            </button>
          </div>
        </div>
      </div>

      <div data-testid="console-output-scroll" className={cn('flex-1 overflow-auto p-5 xl:min-h-0', activeTab === 'context' && 'flex flex-col')} role="tabpanel" id={tabPanelId} aria-labelledby={activeTab === 'context' ? contextTabId : activeTab === 'analysis' ? analysisTabId : reportTabId}>
        {!result && (
          <Card className="border-border/70 bg-card/85 text-foreground shadow-none dark:border-white/10 dark:bg-slate-950/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-3 text-xl">
                <Orbit className="h-5 w-5 text-cyan-500 dark:text-cyan-300" />
                {t('analysisPanelIdleTitle')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('analysisPanelIdleBody')}
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {result && activeTab === 'analysis' && (
          <AnalysisTabContent
            result={result}
            modelVisualizationSnapshot={modelVisualizationSnapshot}
            visualizationSnapshot={visualizationSnapshot}
            t={t}
            locale={locale}
          />
        )}

        {result && activeTab === 'report' && <ReportTabContent result={result} t={t} locale={locale} />}

        {activeTab === 'context' && (
          <ContextTabContent
            result={result}
            modelVisualizationSnapshot={modelVisualizationSnapshot}
            onOpenVisualization={onOpenVisualization}
            t={t}
            locale={locale}
            modelText={modelText}
            onModelTextChange={onModelTextChange}
            modelSyncMessage={modelSyncMessage}
            parsedComposerModelError={parsedComposerModelError}
          />
        )}
      </div>
    </div>
  )
}
