import { createColorScale } from '../structural-scene-utils'

export function ColorBar({
  maxValue,
  valueScale = 1,
  unit,
  label,
  show,
  colorMode = 'scale',
}: {
  maxValue: number
  valueScale?: number
  unit?: string
  label: string
  show: boolean
  colorMode?: 'scale' | 'utilization'
}) {
  if (!show) return null

  const formatValue = (val: number) => {
    if (val >= 1000) return val.toFixed(0)
    if (val >= 1) return val.toFixed(2)
    return val.toExponential(1)
  }

  const gradient = colorMode === 'utilization'
    // Matches createUtilizationColor: blue(0%) → green → yellow → red(100%)
    ? 'linear-gradient(to bottom, #d91a1a, #e6b800, #22c55e, #1a6fd9)'
    : `linear-gradient(to bottom, ${createColorScale(maxValue, maxValue)}, ${createColorScale(0, maxValue)})`

  return (
    <div className="pointer-events-none absolute right-4 top-4 z-10 flex flex-col items-end gap-1.5">
      <div className="rounded-lg border border-border/70 bg-background/90 px-3 py-1.5 text-sm font-medium text-foreground shadow-lg dark:border-white/10 dark:bg-slate-950/85">
        {label}{unit ? ` (${unit})` : ''}
      </div>
      <div className="flex items-end gap-2.5 rounded-lg border border-border/70 bg-background/90 p-2.5 shadow-lg dark:border-white/10 dark:bg-slate-950/85">
        <div className="flex flex-col justify-between items-end text-xs text-muted-foreground" style={{ height: '128px' }}>
          <span>{formatValue(maxValue * valueScale)}</span>
          <span>{formatValue(maxValue * 0.5 * valueScale)}</span>
          <span>0</span>
        </div>
        <div
          className="h-32 w-6 rounded-sm"
          style={{ background: gradient }}
        />
      </div>
    </div>
  )
}
