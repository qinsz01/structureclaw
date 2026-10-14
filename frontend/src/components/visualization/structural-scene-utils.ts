import * as THREE from 'three'
import type { MessageKey } from '@/lib/i18n'
import type { VisualizationCase, VisualizationLoad, VisualizationPlane, VisualizationSnapshot } from './types'

export function isLoadVisible(snapshot: VisualizationSnapshot, activeCase: VisualizationCase, load: VisualizationLoad) {
  return snapshot.source === 'model' || load.caseId === activeCase.id
}

/** Pure display geometry: positions are distances from the original physical i end. */
export function getMemberLoadInterval(load: VisualizationLoad, start: THREE.Vector3, end: THREE.Vector3, physicalLength = start.distanceTo(end)) {
  const at = (position: number) => start.clone().lerp(end, position / physicalLength)
  return load.kind === 'distributed'
    ? { start: at(load.start ?? 0), end: at(load.end ?? physicalLength) }
    : { start: at(load.position ?? 0), end: at(load.position ?? 0) }
}

/** Interpolate the specified load drawing only; this performs no structural response calculation. */
export function getDistributedLoadArrows(start: THREE.Vector3, end: THREE.Vector3, vector: THREE.Vector3, endVector = vector, count = 8) {
  return Array.from({ length: Math.max(2, count) }, (_, index) => {
    const ratio = index / (Math.max(2, count) - 1)
    const arrowVector = vector.clone().lerp(endVector, ratio)
    const tip = start.clone().lerp(end, ratio)
    return { origin: tip.clone().sub(arrowVector), vector: arrowVector, tip }
  })
}

export const FORCE_COMPONENTS = ['N', 'V2', 'V3', 'T', 'M2', 'M3'] as const
export type ForceComponent = typeof FORCE_COMPONENTS[number]
export type ForceMetric = 'axial' | 'shear' | 'moment' | ForceComponent
export const isForceComponent = (metric: string): metric is ForceComponent => (FORCE_COMPONENTS as readonly string[]).includes(metric)
export const isMomentMetric = (metric: ForceMetric) => ['moment', 'T', 'M2', 'M3'].includes(metric)
export function forceMetricLabel(metric: ForceMetric, t: (key: MessageKey) => string) {
  const key = metric === 'T' ? 'visualizationForceTorsion' : metric === 'axial' || metric === 'N'
    ? 'visualizationForceAxial' : metric === 'shear' || metric === 'V2' || metric === 'V3' ? 'visualizationForceShear' : 'visualizationForceMoment'
  return isForceComponent(metric) ? `${metric} · ${t(key)}` : t(key)
}
export type SupportKind = 'none' | 'fixed' | 'pinned' | 'roller-x' | 'roller-y' | 'roller-z' | 'partial'

export function classifySupport(restraints: boolean[] | undefined, dimension: 2 | 3): SupportKind {
  if (!restraints || restraints.length !== 6 || !restraints.some(Boolean)) {
    return 'none'
  }
  const [ux, uy, uz, rx, ry, rz] = restraints
  if (dimension === 2) {
    if (ux && uz && ry) return 'fixed'
    if (ux && uz && !ry) return 'pinned'
    if (!ux && uz && !ry) return 'roller-x'
    if (ux && !uz && !ry) return 'roller-z'
    return 'partial'
  }
  if (ux && uy && uz && rx && ry && rz) return 'fixed'
  if (ux && uy && uz && !rx && !ry && !rz) return 'pinned'
  if (!rx && !ry && !rz) {
    const freeTranslations = [!ux ? 'x' : null, !uy ? 'y' : null, !uz ? 'z' : null].filter(Boolean)
    if (freeTranslations.length === 1) {
      return `roller-${freeTranslations[0]}` as SupportKind
    }
  }
  return 'partial'
}

export function getProjectedRollerAxis(
  kind: SupportKind,
  plane: VisualizationPlane,
  dimension: 2 | 3
) {
  const sourceAxis = kind === 'roller-x'
    ? new THREE.Vector3(1, 0, 0)
    : kind === 'roller-y'
      ? new THREE.Vector3(0, 1, 0)
      : kind === 'roller-z'
        ? new THREE.Vector3(0, 0, 1)
        : null
  if (!sourceAxis) {
    return null
  }
  const projected = projectPosition(sourceAxis, plane, dimension).normalize()
  return new THREE.Vector3(
    Math.abs(projected.x) < 1e-12 ? 0 : projected.x,
    Math.abs(projected.y) < 1e-12 ? 0 : projected.y,
    Math.abs(projected.z) < 1e-12 ? 0 : projected.z
  )
}

export function getCaseNodeDisplacement(activeCase: VisualizationCase, nodeId: string) {
  const displacement = activeCase.nodeResults[nodeId]?.displacement
  return {
    x: displacement?.ux ?? 0,
    y: displacement?.uy ?? 0,
    z: displacement?.uz ?? 0,
  }
}

/** Rendering only: translate precomputed global samples by the selected display scale. */
export function getMemberDeformedPoints(activeCase: VisualizationCase, elementId: string, scale: number) {
  const row = activeCase.memberResponses?.[elementId]
  if (!row || row.state === 'unavailable' || row.state === 'native-stations' || row.state === 'force-only'
    || row.samples.length < 2 || row.samples.some(sample => !sample.displacement)) return undefined
  return row.samples.map((sample) => new THREE.Vector3(...sample.position)
    .addScaledVector(new THREE.Vector3(...sample.displacement!), scale))
}

export function getMemberDisplacementMagnitude(activeCase: VisualizationCase, elementId: string) {
  return (activeCase.memberResponses?.[elementId]?.samples || [])
    .reduce((maximum, sample) => Math.max(maximum, sample.displacement ? Math.hypot(...sample.displacement) : 0), 0)
}

export function getElementMetric(activeCase: VisualizationCase, elementId: string, forceMetric: ForceMetric) {
  const native = activeCase.memberResponses?.[elementId]
  if (isForceComponent(forceMetric)) {
    // Only explicitly named canonical samples can supply an individual component.
    // Legacy grouped or unverified local end forces cannot be relabelled as M2/M3.
    if (!native || native.state === 'unavailable' || native.state === 'interpolated') return null
    const values = native.samples.map(sample => sample[forceMetric])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    return values.length ? values.reduce((largest, value) => Math.abs(value) > Math.abs(largest) ? value : largest) : null
  }
  if (native?.state === 'native-stations' || native?.state === 'force-only') {
    const components = forceMetric === 'axial' ? ['N'] as const
      : forceMetric === 'shear' ? ['V2', 'V3'] as const : ['M2', 'M3'] as const
    const values = native.samples.flatMap(sample => components.map(key => sample[key]))
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    return values.reduce((largest, value) => Math.abs(value) > Math.abs(largest) ? value : largest, 0)
  }
  const result = activeCase.elementResults[elementId]
  if (!result) {
    return 0
  }
  if (activeCase.kind === 'envelope') {
    if (forceMetric === 'axial') {
      return Number(result.envelope?.maxAbsAxialForce || 0)
    }
    if (forceMetric === 'shear') {
      return Number(result.envelope?.maxAbsShearForce || 0)
    }
    return Number(result.envelope?.maxAbsMoment || 0)
  }
  if (forceMetric === 'axial') {
    return Number(result.axial || 0)
  }
  if (forceMetric === 'shear') {
    return Number(result.shear || 0)
  }
  return Number(result.moment || 0)
}

export function getNodeReactionMagnitude(activeCase: VisualizationCase, nodeId: string) {
  const reaction = activeCase.nodeResults[nodeId]?.reaction
  if (activeCase.kind === 'envelope') {
    return Number(activeCase.nodeResults[nodeId]?.envelope?.maxAbsReaction || 0)
  }
  if (!reaction) {
    return 0
  }
  return Math.sqrt((reaction.fx || 0) ** 2 + (reaction.fy || 0) ** 2 + (reaction.fz || 0) ** 2)
}

export function getNodeReactionMomentMagnitude(activeCase: VisualizationCase, nodeId: string) {
  const reaction = activeCase.nodeResults[nodeId]?.reaction
  if (!reaction) {
    return 0
  }
  return Math.sqrt((reaction.mx || 0) ** 2 + (reaction.my || 0) ** 2 + (reaction.mz || 0) ** 2)
}

export function getNodeDisplacementMagnitude(activeCase: VisualizationCase, nodeId: string) {
  if (activeCase.kind === 'envelope') {
    return Number(activeCase.nodeResults[nodeId]?.envelope?.maxAbsDisplacement || 0)
  }
  const displacement = activeCase.nodeResults[nodeId]?.displacement
  if (!displacement) {
    return 0
  }
  return Math.sqrt((displacement.ux || 0) ** 2 + (displacement.uy || 0) ** 2 + (displacement.uz || 0) ** 2)
}

/**
 * Utilization ratio color: HSL rainbow from blue (0%) → green (50%) → yellow (85%) → red (100%+).
 * ratio > 1 clamps to deep red to highlight overstressed members.
 */
export function createUtilizationColor(ratio: number) {
  const clamped = Math.max(0, ratio)
  const color = new THREE.Color()
  if (clamped >= 1) {
    // Overstressed — deep red
    color.setRGB(0.85, 0.1, 0.1)
  } else {
    // Hue: 240° (blue) → 120° (green) → 60° (yellow) → 0° (red)
    const hue = (1 - clamped) * 240 / 360
    color.setHSL(hue, 0.9, 0.48)
  }
  return `#${color.getHexString()}`
}

export function createColorScale(value: number, maxValue: number) {
  const ratio = maxValue <= 0 ? 0 : Math.min(Math.abs(value) / maxValue, 1)
  const color = new THREE.Color()
  color.setRGB(
    0.18 + ratio * 0.72,
    0.82 - ratio * 0.32,
    0.92 - ratio * 0.55
  )
  return `#${color.getHexString()}`
}

function roundUpNice(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 1
  }
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  const normalized = value / base
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * base
}

export function projectPosition(position: THREE.Vector3, plane: VisualizationPlane, dimension: 2 | 3) {
  if (dimension === 2 || plane === 'xy') {
    return position.clone()
  }
  if (plane === 'xz') {
    // Rotate the source XZ plane onto the render XY ground. Source +Y becomes
    // render +Z, while source +Z points toward render -Y.
    return new THREE.Vector3(position.x, -position.z, position.y)
  }
  // Rotate the source YZ plane onto the render XY ground. Source +X becomes
  // render +Z.
  return new THREE.Vector3(position.y, position.z, position.x)
}

export function isRenderableLoadVector(vector: THREE.Vector3) {
  return vector.lengthSq() >= 1e-18
}

export function getLoadArrowLength(snapshot: VisualizationSnapshot, plane: VisualizationPlane) {
  if (!snapshot.nodes.length) {
    return 0.6
  }

  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY

  snapshot.nodes.forEach((node) => {
    const projected = projectPosition(new THREE.Vector3(node.position.x, node.position.y, node.position.z), plane, snapshot.dimension)
    minX = Math.min(minX, projected.x)
    maxX = Math.max(maxX, projected.x)
    minY = Math.min(minY, projected.y)
    maxY = Math.max(maxY, projected.y)
    minZ = Math.min(minZ, projected.z)
    maxZ = Math.max(maxZ, projected.z)
  })

  const spanX = maxX - minX
  const spanY = maxY - minY
  const spanZ = maxZ - minZ
  const modelSpan = Math.max(spanX, spanY, spanZ, 1)

  return Math.max(0.45, Math.min(modelSpan / 6, 2.4))
}

function planeGridFallback(plane: VisualizationPlane) {
  if (plane === 'xy') {
    return {
      size: 24,
      divisions: 24,
      position: [0, 0, 0] as [number, number, number],
      rotation: [Math.PI / 2, 0, 0] as [number, number, number],
    }
  }
  if (plane === 'yz') {
    return {
      size: 24,
      divisions: 24,
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, Math.PI / 2] as [number, number, number],
    }
  }
  return {
    size: 24,
    divisions: 24,
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  }
}

export function getAdaptiveGridConfig(snapshot: VisualizationSnapshot, plane: VisualizationPlane) {
  if (!snapshot.nodes.length) {
    return planeGridFallback(snapshot.dimension === 3 ? 'xy' : plane)
  }

  const positions = snapshot.nodes.map((node) => projectPosition(
    new THREE.Vector3(node.position.x, node.position.y, node.position.z),
    plane,
    snapshot.dimension,
  ))
  const xs = positions.map((position) => position.x)
  const ys = positions.map((position) => position.y)
  const zs = positions.map((position) => position.z)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const minZ = Math.min(...zs)
  const maxZ = Math.max(...zs)

  if (snapshot.dimension === 3) {
    const spanX = Math.max(maxX - minX, 1)
    const spanY = Math.max(maxY - minY, 1)
    const spanZ = Math.max(maxZ - minZ, 1)
    const groundSpan = Math.max(spanX, spanY)
    const size = roundUpNice(groundSpan * 1.5)
    const divisions = Math.min(120, Math.max(8, Math.round(size / Math.max(groundSpan / 18, 0.25))))
    const offset = Math.max(Math.max(spanX, spanY, spanZ) * 0.01, 0.001)

    return {
      size,
      divisions,
      position: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, minZ - offset] as [number, number, number],
      rotation: [Math.PI / 2, 0, 0] as [number, number, number],
    }
  }

  if (plane === 'xy') {
    const spanX = Math.max(maxX - minX, 1)
    const spanY = Math.max(maxY - minY, 1)
    const span = Math.max(spanX, spanY)
    const size = roundUpNice(span * 1.5)
    const divisions = Math.min(120, Math.max(8, Math.round(size / Math.max(span / 18, 0.25))))
    return {
      size,
      divisions,
      position: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, 0] as [number, number, number],
      rotation: [Math.PI / 2, 0, 0] as [number, number, number],
    }
  }

  if (plane === 'yz') {
    const spanY = Math.max(maxY - minY, 1)
    const spanZ = Math.max(maxZ - minZ, 1)
    const span = Math.max(spanY, spanZ)
    const size = roundUpNice(span * 1.5)
    const divisions = Math.min(120, Math.max(8, Math.round(size / Math.max(span / 18, 0.25))))
    return {
      size,
      divisions,
      position: [0, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5] as [number, number, number],
      rotation: [0, 0, Math.PI / 2] as [number, number, number],
    }
  }

  const spanX = Math.max(maxX - minX, 1)
  const spanZ = Math.max(maxZ - minZ, 1)
  const span = Math.max(spanX, spanZ)
  const size = roundUpNice(span * 1.5)
  const divisions = Math.min(120, Math.max(8, Math.round(size / Math.max(span / 18, 0.25))))

  return {
    size,
    divisions,
    position: [(minX + maxX) * 0.5, 0, (minZ + maxZ) * 0.5] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  }
}

export function getPlaneCameraPreset(plane: VisualizationPlane, dimension: 2 | 3) {
  if (dimension === 3) {
    return {
      direction: [1.25, -1.5, 0.65] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
    }
  }
  if (plane === 'xy') {
    return {
      direction: [0, 0, 1] as [number, number, number],
      up: [0, 1, 0] as [number, number, number],
    }
  }
  if (plane === 'yz') {
    return {
      direction: [1, 0, 0] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
    }
  }
  return {
    // View XZ from -Y so positive X remains rightward on screen.
    direction: [0, -1, 0] as [number, number, number],
    up: [0, 0, 1] as [number, number, number],
  }
}

export function getSnapshotCenter(snapshot: VisualizationSnapshot, plane: VisualizationPlane) {
  if (!snapshot.nodes.length) {
    return [0, 0, 0] as [number, number, number]
  }

  const bounds = new THREE.Box3()
  snapshot.nodes.forEach((node) => {
    bounds.expandByPoint(projectPosition(
      new THREE.Vector3(node.position.x, node.position.y, node.position.z),
      plane,
      snapshot.dimension,
    ))
  })
  return bounds.getCenter(new THREE.Vector3()).toArray() as [number, number, number]
}

export function getPlaneCameraFrame(
  plane: VisualizationPlane,
  dimension: 2 | 3,
  target: [number, number, number],
  distance = 10
) {
  const preset = getPlaneCameraPreset(plane, dimension)
  const targetVector = new THREE.Vector3(...target)
  const position = new THREE.Vector3(...preset.direction)
    .normalize()
    .multiplyScalar(distance)
    .add(targetVector)

  return {
    position: position.toArray() as [number, number, number],
    target: [...target] as [number, number, number],
    up: preset.up,
  }
}

export function getNodeLabelOffset(plane: VisualizationPlane, dimension: 2 | 3) {
  const [x, y, z] = getPlaneCameraPreset(plane, dimension).up
  const distance = dimension === 3 ? 0.24 : 0.18
  return new THREE.Vector3(x, y, z).multiplyScalar(distance)
}
