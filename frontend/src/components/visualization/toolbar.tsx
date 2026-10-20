"use client"
import type { MessageKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { VisualizationSnapshot } from './types'
import { forceMetricLabel, getElementMetric } from './structural-scene-utils'
import { availableMetrics, hasCaseLoads, viewControls, type VizState } from './state'
import { viewerButtonClass } from './button-style'

type Props = { snapshot: VisualizationSnapshot; state: VizState; scaleRange: { min: number; max: number; step: number }; onChange: (patch: Partial<VizState>) => void; t: (key: MessageKey) => string }
export function VisualizationToolbar({ snapshot, state, scaleRange, onChange, t }: Props) {
  const activeCase = snapshot.cases.find(item => item.id === snapshot.defaultCaseId)!
  const hasOrdinates = snapshot.elements.some(element => Math.abs(getElementMetric(activeCase, element.id, state.component) ?? 0) > 0)
  const controls = viewControls(state.view, hasCaseLoads(snapshot, activeCase))
  const toggles: { key: keyof Pick<VizState, 'showOriginal' | 'showNodeLabels' | 'showElementLabels' | 'showLoads' | 'showLegend'>; label: MessageKey }[] = [
    ...(controls.deformation ? [{ key: 'showOriginal' as const, label: 'visualizationUndeformedOverlay' as const }] : []),
    ...(controls.labels ? [{ key: 'showNodeLabels' as const, label: 'visualizationNodeLabels' as const }, { key: 'showElementLabels' as const, label: 'visualizationElementLabels' as const }] : []),
    ...(controls.loads ? [{ key: 'showLoads' as const, label: 'visualizationShowLoads' as const }] : []),
    ...(controls.legend ? [{ key: 'showLegend' as const, label: 'visualizationLegend' as const }] : []),
  ]
  const button = (active: boolean) => cn('rounded-full px-3 py-2 text-sm', viewerButtonClass(active))
  return <div data-testid="visualization-toolbar" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
    {controls.diagram && availableMetrics(snapshot, activeCase).map(component => <button key={component} type="button"
      aria-pressed={state.component === component} className={button(state.component === component)} onClick={() => onChange({ component })}>
      {forceMetricLabel(component, t)}
    </button>)}
    {(controls.deformation || controls.diagram && hasOrdinates) && <label className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>{t(controls.diagram ? 'visualizationDiagramScale' : 'visualizationScale')}</span>
      <input className="accent-primary" type="range" min={controls.diagram ? 0.25 : scaleRange.min}
        max={controls.diagram ? 3 : scaleRange.max} step={controls.diagram ? 0.05 : scaleRange.step}
        value={controls.diagram ? state.diagramScale : state.deformScale}
        onChange={event => onChange(controls.diagram ? { diagramScale: Number(event.target.value) } : { deformScale: Number(event.target.value) })} />
      <span className="min-w-14 tabular-nums">{(controls.diagram ? state.diagramScale : state.deformScale).toFixed(1)}×</span>
    </label>}
    {toggles.map(({ key, label }) => <button key={key} type="button" className={button(state[key])}
      aria-pressed={state[key]} onClick={() => onChange({ [key]: !state[key] })}>{t(label)}</button>)}
  </div>
}
