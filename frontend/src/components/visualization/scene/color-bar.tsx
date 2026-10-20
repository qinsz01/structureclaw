import { formatResultNumber } from '@/lib/utils'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { createColorScale, createUtilizationColor } from '../structural-scene-utils'
import { useScenePalette, type ScenePalette } from './palette'

export type LegendProps = {
  maxValue: number; valueScale?: number; unit?: string; label: string;
  colorMode?: 'scale' | 'utilization' | 'buckling' | 'signed'
}
export function legendStops(legend: LegendProps, palette: ScenePalette) {
  if (legend.colorMode === 'buckling') return [palette.buckling, palette.buckling]
  if (legend.colorMode === 'signed') return [palette.positive, palette.negative]
  if (legend.colorMode === 'utilization') return [1, 0.85, 0.5, 0].map(ratio => createUtilizationColor(ratio, palette))
  return [createColorScale(legend.maxValue, legend.maxValue, palette), createColorScale(0, legend.maxValue, palette)]
}
export function ColorBar({ show, locale = 'en', ...legend }: LegendProps & { show: boolean; locale?: AppLocale }) {
  const palette = useScenePalette()
  if (!show) return null
  const { maxValue, valueScale = 1, unit, label, colorMode } = legend
  const format = (value: number) => formatResultNumber(value, locale, maxValue * valueScale)
  return <div data-testid="visualization-legend" className="pointer-events-none flex max-w-36 shrink-0 flex-col items-end gap-1.5 p-3">
    <div className="rounded-lg border border-border bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground">{label}{unit ? ` (${unit})` : ''}</div>
    <div className="flex items-end gap-2 rounded-lg border border-border bg-background/95 p-2.5">
      {colorMode === 'buckling' ? <span className="text-xs text-foreground">{format(maxValue)}</span> : <div className="flex h-28 flex-col items-end justify-between text-xs text-muted-foreground">
        <span>{format(maxValue * valueScale)}</span><span>{format(colorMode === 'signed' ? 0 : maxValue * 0.5 * valueScale)}</span><span>{colorMode === 'signed' ? format(-maxValue * valueScale) : '0'}</span>
      </div>}
      <div className={colorMode === 'buckling' ? 'h-4 w-8 rounded-sm' : 'h-28 w-5 rounded-sm'} style={{ background: colorMode === 'signed' ? `linear-gradient(to bottom, ${palette.positive} 0%, ${palette.positive} 50%, ${palette.negative} 50%, ${palette.negative} 100%)` : `linear-gradient(to bottom, ${legendStops(legend, palette).join(',')})` }} />
    </div>
  </div>
}
