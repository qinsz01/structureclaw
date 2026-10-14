'use client'

import type { MessageKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { VisualizationSnapshot, VisualizationViewMode } from './types'
import { FORCE_COMPONENTS, forceMetricLabel, isForceComponent, type ForceMetric } from './structural-scene-utils'

type VisualizationToolbarProps = {
  snapshot: VisualizationSnapshot
  activeCaseId: string
  deformationScale: number
  deformationScaleMin: number
  deformationScaleMax: number
  deformationScaleStep: number
  forceMetric: ForceMetric
  forceMetricLocked?: boolean
  selectedView: VisualizationViewMode
  showElementLabels: boolean
  showLegend: boolean
  showLoads: boolean
  showNodeLabels: boolean
  showUndeformed: boolean
  onActiveCaseChange: (caseId: string) => void
  onDeformationScaleChange: (value: number) => void
  onForceMetricChange: (value: ForceMetric) => void
  onSwitchToForcesView: () => void
  onSwitchToUtilizationView: () => void
  onToggleElementLabels: () => void
  onToggleLegend: () => void
  onToggleLoads: () => void
  onToggleNodeLabels: () => void
  onToggleUndeformed: () => void
  t: (key: MessageKey) => string
}

function getCaseLabel(caseId: string, fallbackLabel: string, t: (key: MessageKey) => string) {
  if (caseId === 'model') return t('visualizationSourceModel')
  if (caseId === 'result') return t('visualizationSourceResult')
  if (caseId === 'envelope') return t('visualizationEnvelope')
  return fallbackLabel
}

export function VisualizationToolbar({
  snapshot,
  activeCaseId,
  deformationScale,
  deformationScaleMin,
  deformationScaleMax,
  deformationScaleStep,
  forceMetric,
  forceMetricLocked = false,
  selectedView,
  showElementLabels,
  showLegend,
  showLoads,
  showNodeLabels,
  showUndeformed,
  onActiveCaseChange,
  onDeformationScaleChange,
  onForceMetricChange,
  onSwitchToForcesView,
  onSwitchToUtilizationView,
  onToggleElementLabels,
  onToggleLegend,
  onToggleLoads,
  onToggleNodeLabels,
  onToggleUndeformed,
  t,
}: VisualizationToolbarProps) {
  const supportsDeformedView = snapshot.availableViews.includes('deformed')
  const supportsForcesView = snapshot.availableViews.includes('forces')
  const supportsUtilizationView = snapshot.availableViews.includes('utilization')
  const showCaseSelector = snapshot.source === 'result' && snapshot.cases.length > 1
  const activeCase = snapshot.cases.find(item => item.id === activeCaseId)
  const hasComponents = Object.values(activeCase?.memberResponses ?? {}).some(row =>
    row.samples.some(sample => FORCE_COMPONENTS.some(component => typeof sample[component] === 'number')))
  const metrics: readonly ForceMetric[] = forceMetricLocked ? [forceMetric]
    : hasComponents || isForceComponent(forceMetric) ? FORCE_COMPONENTS : ['axial', 'shear', 'moment']

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border/70 px-4 py-3 dark:border-white/10">
      {showCaseSelector ? (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{t('visualizationCurrentCase')}</span>
          <select
            className="rounded-full border border-border/70 bg-background/80 px-3 py-2 text-foreground dark:border-white/10 dark:bg-white/5"
            onChange={(event) => onActiveCaseChange(event.target.value)}
            value={activeCaseId}
          >
            {snapshot.cases.map((item) => (
              <option key={item.id} value={item.id}>
                {getCaseLabel(item.id, item.label, t)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {supportsForcesView ? (
        <div className="flex flex-wrap items-center gap-2">
          {metrics.map((metric) => (
            <button
              key={metric}
              className={cn(
                'rounded-full border px-3 py-2 text-sm transition',
                selectedView === 'forces' && forceMetric === metric
                  ? 'border-cyan-300/45 bg-cyan-300/14 text-foreground'
                  : 'border-border/70 bg-background/70 text-muted-foreground hover:border-cyan-300/30 hover:text-foreground dark:border-white/10 dark:bg-white/5'
              )}
              onClick={() => {
                onForceMetricChange(metric)
                if (selectedView !== 'forces') {
                  onSwitchToForcesView()
                }
              }}
              type="button"
            >
              {forceMetricLabel(metric, t)}
            </button>
          ))}
          {(hasComponents || isForceComponent(forceMetric)) && <p className="w-full text-xs text-muted-foreground">{t('visualizationForceComponentNote')}</p>}
        </div>
      ) : null}

      {supportsUtilizationView ? (
        <button
          className={cn(
            'rounded-full border px-3 py-2 text-sm transition',
            selectedView === 'utilization'
              ? 'border-orange-300/50 bg-orange-300/14 text-foreground'
              : 'border-border/70 bg-background/70 text-muted-foreground hover:border-orange-300/30 hover:text-foreground dark:border-white/10 dark:bg-white/5'
          )}
          onClick={onSwitchToUtilizationView}
          type="button"
        >
          {t('visualizationUtilizationRatio')}
        </button>
      ) : null}

      {supportsDeformedView ? (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{t('visualizationScale')}</span>
          <input
            className="accent-cyan-500"
            max={deformationScaleMax}
            min={deformationScaleMin}
            onChange={(event) => onDeformationScaleChange(Number(event.target.value))}
            step={deformationScaleStep}
            type="range"
            value={deformationScale}
          />
          <span className="min-w-[52px] text-right">{deformationScale.toFixed(1)}x</span>
        </label>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {[
          ...(supportsDeformedView ? [{ active: showUndeformed, key: 'visualizationUndeformedOverlay', onClick: onToggleUndeformed }] : []),
          { active: showNodeLabels, key: 'visualizationNodeLabels', onClick: onToggleNodeLabels },
          { active: showElementLabels, key: 'visualizationElementLabels', onClick: onToggleElementLabels },
          { active: showLoads, key: 'visualizationShowLoads', onClick: onToggleLoads },
          { active: showLegend, key: 'visualizationLegend', onClick: onToggleLegend },
        ].map((item) => (
          <button
            key={item.key}
            className={cn(
              'rounded-full border px-3 py-2 text-sm transition',
              item.active
                ? 'border-cyan-300/45 bg-cyan-300/14 text-foreground'
                : 'border-border/70 bg-background/70 text-muted-foreground hover:border-cyan-300/30 hover:text-foreground dark:border-white/10 dark:bg-white/5'
            )}
            onClick={item.onClick}
            type="button"
          >
            {t(item.key as MessageKey)}
          </button>
        ))}
      </div>
    </div>
  )
}
