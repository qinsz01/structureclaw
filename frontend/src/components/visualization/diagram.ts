import * as THREE from 'three'
import type { VisualizationElement, VisualizationMemberResponse } from './types'
import { isForceComponent, type ForceMetric } from './structural-scene-utils'

/** Display geometry only: ordinates come directly from saved samples, never from a UI solver. */
export function buildDiagram(response: VisualizationMemberResponse | undefined, element: VisualizationElement,
  component: ForceMetric, maxMagnitude: number, modelSpan: number, scale = 1) {
  if (!response || !isForceComponent(component) || !element.localAxes || response.samples.length < 2) return null
  const axis = ['V2', 'M3'].includes(component) ? element.localAxes.y : element.localAxes.z
  const direction = new THREE.Vector3(axis.x, axis.y, axis.z).normalize()
  const factor = maxMagnitude > 0 ? modelSpan * 0.15 * scale / maxMagnitude : 0
  const samples = response.samples.filter(sample => typeof sample[component] === 'number').map(sample => {
    const value = sample[component]!
    const base = new THREE.Vector3(...sample.position)
    return { base, tip: base.clone().addScaledVector(direction, value * factor), value, x: sample.x }
  })
  if (samples.length < 2) return null
  const triangles: { positive: boolean; vertices: number[] }[] = []
  const add = (a: typeof samples[number], b: typeof samples[number]) => {
    triangles.push({ positive: a.value + b.value >= 0, vertices: [a.base, a.tip, b.tip, a.base, b.tip, b.base].flatMap(point => point.toArray()) })
  }
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i]
    if (a.value * b.value < 0) {
      const ratio = Math.abs(a.value) / (Math.abs(a.value) + Math.abs(b.value))
      const base = a.base.clone().lerp(b.base, ratio)
      const zero = { base, tip: base, value: 0, x: a.x + ratio * (b.x - a.x) }
      add(a, zero); add(zero, b)
    } else add(a, b)
  }
  const peak = samples.reduce((a, b) => Math.abs(a.value) >= Math.abs(b.value) ? a : b)
  return { samples, triangles, peak, factor }
}
