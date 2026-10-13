'use client'

import { useState } from 'react'
import type { VisualizationMemberResponse } from './types'

const components = ['N', 'V2', 'V3', 'T', 'M2', 'M3'] as const
type Component = typeof components[number]

/** Show native cuts and explicitly identified equilibrium-recovered samples. */
export function NativeStationPanel({ response, locale }: { response: VisualizationMemberResponse; locale: string }) {
  const [component, setComponent] = useState<Component>('M3')
  if (response.state !== 'native-stations') return null
  const zh = locale.startsWith('zh')
  const samples = response.samples
  const values = samples.map(sample => sample[component]!)
  const minimum = Math.min(0, ...values), maximum = Math.max(0, ...values)
  const range = maximum - minimum || 1
  const x = (position: number) => 18 + 264 * position / response.length
  const y = (value: number) => 16 + 88 * (maximum - value) / range
  const unit = component.startsWith('M') || component === 'T' ? 'kN·m' : 'kN'
  const format = (value: number) => new Intl.NumberFormat(zh ? 'zh-CN' : 'en', { maximumSignificantDigits: 7 }).format(value)
  const combined = samples.some(sample => sample.provenance === 'linear-combination')
  const recovered = samples.some(sample => sample.provenance === 'mechanics-recovery')
  const label = zh ? (combined ? '线性组合站点' : '原生计算站点') : (combined ? 'Linear combination stations' : 'Native solver stations')
  return <section className="mt-4 space-y-2 border-t border-border/60 pt-3" aria-label={label}>
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <select className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        aria-label={zh ? '站点内力分量' : 'Station force component'} value={component}
        onChange={event => setComponent(event.target.value as Component)}>
        {components.map(key => <option key={key} value={key}>{key}</option>)}
      </select>
    </div>
    <svg viewBox="0 0 300 130" className="w-full rounded-lg bg-background/60" role="img" aria-label={`${component} (${unit})`}>
      <line x1="18" y1={y(0)} x2="282" y2={y(0)} stroke="currentColor" opacity="0.2" />
      <polyline points={samples.map((sample, index) => `${x(sample.x)},${y(values[index])}`).join(' ')}
        fill="none" stroke="currentColor" strokeDasharray="3 3" opacity="0.4" />
      {samples.map((sample, index) => <circle key={`${sample.x}:${sample.side || 'continuous'}`} cx={x(sample.x)} cy={y(values[index])}
        r={sample.provenance === 'mechanics-recovery' ? '1.5' : '3'} className="fill-cyan-600 dark:fill-cyan-300"><title>{`${sample.x} m (${sample.side || 'continuous'}): ${values[index]} ${unit} · ${sample.provenance}`}</title></circle>)}
      <text x="18" y="122" fontSize="9" fill="currentColor">0 m</text>
      <text x="282" y="122" textAnchor="end" fontSize="9" fill="currentColor">{format(response.length)} m</text>
    </svg>
    <div className="max-h-40 overflow-auto rounded-md border border-border/50">
      <table className="w-full text-right text-xs tabular-nums">
        <thead className="sticky top-0 bg-card"><tr><th className="p-1.5 text-left">x (m)</th><th className="p-1.5">{component} ({unit})</th><th className="p-1.5">{zh ? '来源' : 'Source'}</th></tr></thead>
        <tbody>{samples.map((sample, index) => <tr key={`${sample.x}:${sample.side || 'continuous'}`}>
          <td className="p-1.5 text-left">{format(sample.x)}{sample.side ? ` ${zh ? (sample.side === 'left' ? '左侧' : '右侧') : sample.side}` : ''}</td>
          <td className="p-1.5" title={String(values[index])}>{format(values[index])}</td>
          <td className="p-1.5">{sample.provenance === 'mechanics-recovery' ? (zh ? '力学恢复' : 'Equilibrium') : sample.provenance === 'linear-combination' ? (zh ? '组合' : 'Combination') : (zh ? '原生' : 'Native')}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">{zh
      ? `位置从构件起点量取；虚线仅连接采样点。${recovered ? '小点按原生端力与明确荷载的截面平衡恢复。' : ''}跨内位移未提供，变形图仅连接节点位移。`
      : `Positions start at the member origin. Dashed lines join sampled values only. ${recovered ? 'Small points use section equilibrium with native end forces and explicit loads. ' : ''}Interior displacement is unavailable; deformation joins nodal displacements.`}</p>
  </section>
}
