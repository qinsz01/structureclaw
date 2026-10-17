import type { VisualizationLocalAxes, VisualizationVector3 } from '../types'

export const COORDINATE_TOLERANCE = 1e-9

function cleanCoordinate(value: number) {
  return Math.abs(value) <= COORDINATE_TOLERANCE ? 0 : value
}

export function vectorLength(vector: VisualizationVector3) {
  return Math.sqrt(vector.x ** 2 + vector.y ** 2 + vector.z ** 2)
}

function normalizeVector(vector: VisualizationVector3): VisualizationVector3 | null {
  const length = vectorLength(vector)
  if (!Number.isFinite(length) || length <= COORDINATE_TOLERANCE) {
    return null
  }
  return {
    x: cleanCoordinate(vector.x / length),
    y: cleanCoordinate(vector.y / length),
    z: cleanCoordinate(vector.z / length),
  }
}

function dotVector(left: VisualizationVector3, right: VisualizationVector3) {
  return left.x * right.x + left.y * right.y + left.z * right.z
}

function crossVector(left: VisualizationVector3, right: VisualizationVector3): VisualizationVector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  }
}

function scaleAndAdd(
  left: VisualizationVector3,
  leftScale: number,
  right: VisualizationVector3,
  rightScale: number,
): VisualizationVector3 {
  return {
    x: left.x * leftScale + right.x * rightScale,
    y: left.y * leftScale + right.y * rightScale,
    z: left.z * leftScale + right.z * rightScale,
  }
}

export function transformLocalVectorToGlobal(vector: VisualizationVector3, axes: VisualizationLocalAxes): VisualizationVector3 {
  return {
    x: cleanCoordinate(axes.x.x * vector.x + axes.y.x * vector.y + axes.z.x * vector.z),
    y: cleanCoordinate(axes.x.y * vector.x + axes.y.y * vector.y + axes.z.y * vector.z),
    z: cleanCoordinate(axes.x.z * vector.x + axes.y.z * vector.y + axes.z.z * vector.z),
  }
}

export function buildElementLocalAxes(params: {
  start: VisualizationVector3
  end: VisualizationVector3
  dimension: 2 | 3
  referenceVector?: VisualizationVector3 | null
  rotationDegrees?: number | null
}): VisualizationLocalAxes | null {
  const localX = normalizeVector({
    x: params.end.x - params.start.x,
    y: params.end.y - params.start.y,
    z: params.end.z - params.start.z,
  })
  if (!localX) {
    return null
  }

  if (params.dimension === 2) {
    if (Math.abs(localX.y) > COORDINATE_TOLERANCE || Math.abs(params.rotationDegrees || 0) > COORDINATE_TOLERANCE) {
      return null
    }
    const localY = { x: 0, y: 1, z: 0 }
    const localZ = normalizeVector(crossVector(localX, localY))
    return localZ ? { x: localX, y: localY, z: localZ } : null
  }

  let reference = params.referenceVector
    ? normalizeVector(params.referenceVector)
    : null
  if (params.referenceVector && !reference) {
    return null
  }
  if (!reference) {
    reference = { x: 0, y: 0, z: 1 }
    if (Math.abs(dotVector(localX, reference)) > 0.9) {
      reference = { x: 1, y: 0, z: 0 }
    }
  }

  let localY = normalizeVector(crossVector(reference, localX))
  if (!localY) {
    return null
  }
  let localZ = normalizeVector(crossVector(localX, localY))
  if (!localZ) {
    return null
  }

  const angle = params.rotationDegrees || 0
  if (Math.abs(angle) > COORDINATE_TOLERANCE) {
    const radians = angle * Math.PI / 180
    const cosine = Math.cos(radians)
    const sine = Math.sin(radians)
    const rotatedY = normalizeVector(scaleAndAdd(localY, cosine, localZ, sine))
    const rotatedZ = normalizeVector(scaleAndAdd(localY, -sine, localZ, cosine))
    if (!rotatedY || !rotatedZ) {
      return null
    }
    localY = rotatedY
    localZ = rotatedZ
  }

  return { x: localX, y: localY, z: localZ }
}
