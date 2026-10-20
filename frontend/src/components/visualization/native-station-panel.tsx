"use client"
import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { formatResultNumber } from '@/lib/utils'
import { getResultPeak, isForceComponent, isMomentMetric, type ForceMetric } from './structural-scene-utils'
import type { VisualizationMemberResponse, VisualizationSnapshot } from './types'

/** Native samples share the viewer component; no second component selector. */
export function NativeStationPanel({ response, locale, snapshot, component, t }: {
  response: VisualizationMemberResponse; locale: AppLocale; snapshot: VisualizationSnapshot;
  component: ForceMetric; t: (key: MessageKey) => string
}) {
  if (response.state !== 'native-stations' || !isForceComponent(component)) return null
  const samples = response.samples.filter(sample => typeof sample[component] === 'number')
  if (!samples.length) return null
  const values = samples.map(sample => sample[component]!)
  const minimum = Math.min(0, ...values), maximum = Math.max(0, ...values)
  const range = maximum - minimum || 1
  const x = (position: number) => 18 + 264 * position / response.length
  const y = (value: number) => 16 + 88 * (maximum - value) / range
  const unit = isMomentMetric(component) ? snapshot.momentUnit : snapshot.resultUnit
  const lengthUnit = snapshot.lengthUnit
  const peak = getResultPeak(snapshot.cases.find(row => row.id === snapshot.defaultCaseId), 'forces', component)
    || Math.max(...values.map(Math.abs))
  const format = (value: number, reference = peak) => formatResultNumber(value, locale, reference)
  const recovered = samples.some(sample => sample.provenance === 'mechanics-recovery')
  const label = t(samples.some(sample => sample.provenance === 'linear-combination') ? 'visualizationCombinedStations' : 'visualizationNativeStations')
  const source = (provenance?: string) => t(provenance === 'mechanics-recovery' ? 'visualizationStationRecovered' : provenance === 'linear-combination' ? 'visualizationStationCombined' : 'visualizationStationNative')
  return <section className="mt-4 space-y-2 border-t border-border pt-3" aria-label={label}>
    <div className="text-xs font-medium text-foreground">{label} · {component}</div>
    <svg viewBox="0 0 300 130" className="w-full rounded-lg bg-background" role="img" aria-label={`${component} (${unit})`}>
      <line x1="18" y1={y(0)} x2="282" y2={y(0)} stroke="currentColor" opacity="0.2" />
      <polyline points={samples.map((sample, index) => `${x(sample.x)},${y(values[index])}`).join(' ')} fill="none" stroke="currentColor" strokeDasharray="3 3" opacity="0.4" />
      {samples.map((sample, index) => <circle key={`${sample.x}:${sample.side || index}`} cx={x(sample.x)} cy={y(values[index])}
        r={sample.provenance === 'mechanics-recovery' ? '1.5' : '3'} className="fill-primary"><title>{`${format(sample.x, response.length)} ${lengthUnit}: ${format(values[index])} ${unit} · ${source(sample.provenance)}`}</title></circle>)}
      <text x="18" y="122" fontSize="9" fill="currentColor">0 {lengthUnit}</text>
      <text x="282" y="122" textAnchor="end" fontSize="9" fill="currentColor">{format(response.length, response.length)} {lengthUnit}</text>
    </svg>
    <div className="max-h-40 overflow-auto rounded-md border border-border">
      <table className="w-full text-right text-xs tabular-nums">
        <thead className="sticky top-0 bg-card"><tr><th className="p-1.5 text-left">x ({lengthUnit})</th><th className="p-1.5">{component} ({unit})</th><th className="p-1.5">{t('visualizationStationSource')}</th></tr></thead>
        <tbody>{samples.map((sample, index) => <tr key={`${sample.x}:${sample.side || index}`}>
          <td className="p-1.5 text-left">{format(sample.x, response.length)}{sample.side ? ` ${t(sample.side === 'left' ? 'visualizationStationLeft' : 'visualizationStationRight')}` : ''}</td>
          <td className="p-1.5">{format(values[index])}</td><td className="p-1.5">{source(sample.provenance)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('visualizationStationNote')} {recovered && t('visualizationStationRecoveryNote')}</p>
  </section>
}
