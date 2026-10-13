import type {
  VisualizationElement,
  VisualizationLocalAxes,
  VisualizationMemberResponse,
  VisualizationSnapshot,
  VisualizationVector3,
} from './types'

const COORDINATE_TOLERANCE = 1e-8
const LINE_ELEMENT_TYPES = new Set(['beam', 'truss', 'column', 'brace', 'link'])

/** Validates transport samples without introducing a second mechanics implementation. */
export function normalizeMemberResponses(
  value: unknown,
  elements: Map<string, VisualizationElement>,
  dimension: 2 | 3,
): Record<string, VisualizationMemberResponse> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('memberResponses must be an array')
  const responses: Record<string, VisualizationMemberResponse> = {}
  const finiteTuple = (entry: unknown): entry is [number, number, number] => Array.isArray(entry)
    && entry.length === 3 && entry.every((number) => typeof number === 'number' && Number.isFinite(number))
  for (const raw of value) {
    const row = raw as VisualizationMemberResponse
    if (!row || typeof row.id !== 'string' || !elements.has(row.id) || Object.hasOwn(responses, row.id)
      || !['recovered', 'interpolated', 'truss', 'unavailable', 'native-stations'].includes(row.state)
      || typeof row.length !== 'number' || !Number.isFinite(row.length) || row.length < 0
      || typeof row.reason !== 'string' || !Array.isArray(row.samples)) {
      throw new Error('Invalid member response identity or status')
    }
    let previous = -Infinity
    const nativeCuts = new Map<number, Set<string>>()
    for (const sample of row.samples) {
      if (!sample || typeof sample.x !== 'number' || !Number.isFinite(sample.x)
        || sample.x < -COORDINATE_TOLERANCE || sample.x > row.length + COORDINATE_TOLERANCE || sample.x < previous
        || !finiteTuple(sample.position)
        || (row.state === 'native-stations' ? sample.displacement !== undefined : !finiteTuple(sample.displacement))
        || (sample.side !== undefined && !['left', 'right'].includes(sample.side))
        || (sample.segmentId !== undefined && typeof sample.segmentId !== 'string')
        || (dimension === 2 && (Math.abs(sample.position[1]) > COORDINATE_TOLERANCE
          || (sample.displacement !== undefined && Math.abs(sample.displacement[1]) > COORDINATE_TOLERANCE)))
        || (row.state === 'native-stations' && (!['N', 'V2', 'V3', 'T', 'M2', 'M3'].every(key => {
          const value = sample[key as 'N']; return typeof value === 'number' && Number.isFinite(value)
        }) || !['solver-direct', 'linear-combination'].includes(sample.provenance || '') || !sample.source))) {
        throw new Error(`Invalid member response sample for '${row.id}'`)
      }
      if (row.state === 'native-stations') {
        const side = sample.side || 'continuous'
        const sides = nativeCuts.get(sample.x) || new Set<string>()
        if (sides.has(side) || sides.has('continuous') || (side === 'continuous' && sides.size)) {
          throw new Error(`Ambiguous native station for '${row.id}'`)
        }
        sides.add(side)
        nativeCuts.set(sample.x, sides)
      }
      previous = sample.x
    }
    if (row.state === 'unavailable' ? row.samples.length !== 0 : row.state === 'native-stations'
      ? (row.length <= 0 || row.samples.length < 1)
      : (row.length <= 0 || row.samples.length < 2
      || Math.abs(row.samples[0].x) > COORDINATE_TOLERANCE
      || Math.abs(row.samples.at(-1)!.x - row.length) > COORDINATE_TOLERANCE)) {
      throw new Error(`Incomplete member response samples for '${row.id}'`)
    }
    responses[row.id] = row
  }
  return responses
}

function isFiniteVector(value: unknown): value is VisualizationVector3 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const vector = value as Partial<VisualizationVector3>
  return [vector.x, vector.y, vector.z].every((entry) => typeof entry === 'number' && Number.isFinite(entry))
}

function vectorLength(vector: VisualizationVector3) {
  return Math.hypot(vector.x, vector.y, vector.z)
}

function dot(left: VisualizationVector3, right: VisualizationVector3) {
  return left.x * right.x + left.y * right.y + left.z * right.z
}

function cross(left: VisualizationVector3, right: VisualizationVector3): VisualizationVector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  }
}

function subtract(left: VisualizationVector3, right: VisualizationVector3): VisualizationVector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z }
}

function vectorsMatch(left: VisualizationVector3, right: VisualizationVector3) {
  return vectorLength(subtract(left, right)) <= COORDINATE_TOLERANCE
}

function validLocalAxes(
  element: VisualizationElement,
  axes: VisualizationLocalAxes,
  nodePositions: Map<string, VisualizationVector3>,
  dimension: 2 | 3,
) {
  if (![axes.x, axes.y, axes.z].every(isFiniteVector)) return false
  const start = nodePositions.get(element.nodeIds[0])
  const end = nodePositions.get(element.nodeIds[1])
  if (!start || !end) return false
  const direction = subtract(end, start)
  const length = vectorLength(direction)
  if (length <= COORDINATE_TOLERANCE) return false
  const expectedX = { x: direction.x / length, y: direction.y / length, z: direction.z / length }
  if (!vectorsMatch(axes.x, expectedX)) return false
  if ([axes.x, axes.y, axes.z].some((axis) => Math.abs(vectorLength(axis) - 1) > COORDINATE_TOLERANCE)) return false
  if (
    Math.abs(dot(axes.x, axes.y)) > COORDINATE_TOLERANCE
    || Math.abs(dot(axes.x, axes.z)) > COORDINATE_TOLERANCE
    || Math.abs(dot(axes.y, axes.z)) > COORDINATE_TOLERANCE
    || !vectorsMatch(cross(axes.x, axes.y), axes.z)
  ) return false
  return dimension === 3 || vectorsMatch(axes.y, { x: 0, y: 1, z: 0 })
}

function finiteResultComponents(value: unknown) {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((entry) => typeof entry === 'number' && Number.isFinite(entry))
}

/** Strictly validates snapshots restored from storage before they bypass the model adapter. */
export function isCanonicalVisualizationSnapshot(snapshot: VisualizationSnapshot): boolean {
  if (
    snapshot.version !== 1
    || snapshot.coordinateSemantics !== 'global-z-up'
    || snapshot.coordinateContractVersion !== 1
    || (snapshot.dimension !== 2 && snapshot.dimension !== 3)
    || (snapshot.dimension === 2 && snapshot.plane !== 'xz')
    || (snapshot.dimension === 3 && !['xy', 'xz', 'yz'].includes(snapshot.plane))
    || !Array.isArray(snapshot.nodes)
    || !Array.isArray(snapshot.elements)
    || !Array.isArray(snapshot.loads)
    || !Array.isArray(snapshot.cases)
  ) return false

  const nodePositions = new Map<string, VisualizationVector3>()
  for (const node of snapshot.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || nodePositions.has(node.id) || !isFiniteVector(node.position)) return false
    if (snapshot.dimension === 2 && Math.abs(node.position.y) > COORDINATE_TOLERANCE) return false
    if (node.restraints !== undefined && (
      !Array.isArray(node.restraints)
      || node.restraints.length !== 6
      || node.restraints.some((entry) => typeof entry !== 'boolean')
    )) return false
    nodePositions.set(node.id, node.position)
  }

  const elements = new Map<string, VisualizationElement>()
  for (const element of snapshot.elements) {
    if (
      !element
      || typeof element.id !== 'string'
      || !element.id
      || elements.has(element.id)
      || !Array.isArray(element.nodeIds)
      || element.nodeIds.length < 2
      || new Set(element.nodeIds).size !== element.nodeIds.length
      || element.nodeIds.some((nodeId) => !nodePositions.has(nodeId))
    ) return false
    if (LINE_ELEMENT_TYPES.has(element.type)) {
      if (element.nodeIds.length !== 2 || !element.localAxes || !validLocalAxes(element, element.localAxes, nodePositions, snapshot.dimension)) return false
    } else if (element.localAxes && !validLocalAxes(element, element.localAxes, nodePositions, snapshot.dimension)) {
      return false
    }
    elements.set(element.id, element)
  }

  for (const load of snapshot.loads) {
    if (!load || !isFiniteVector(load.vector)) return false
    const referenceFrame = load.referenceFrame ?? 'global'
    if (referenceFrame !== 'global' && referenceFrame !== 'element-local') return false
    if (load.sourceVector !== undefined && !isFiniteVector(load.sourceVector)) return false
    if (load.endVector !== undefined && !isFiniteVector(load.endVector)) return false
    if (load.sourceEndVector !== undefined && !isFiniteVector(load.sourceEndVector)) return false
    if (load.kind === 'area') {
      if (!Array.isArray(load.polygon) || load.polygon.length < 3 || !load.polygon.every(isFiniteVector)) return false
    } else if (load.kind === 'nodal' || (load.kind === 'moment' && load.nodeId)) {
      if (!load.nodeId || load.elementId || !nodePositions.has(load.nodeId) || referenceFrame !== 'global') return false
    } else if (load.kind === 'distributed' || load.kind === 'point' || load.kind === 'moment') {
      if (!load.elementId || load.nodeId || !elements.has(load.elementId)) return false
      const element = elements.get(load.elementId)!
      const length = vectorLength(subtract(nodePositions.get(element.nodeIds[1])!, nodePositions.get(element.nodeIds[0])!))
      const validPosition = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= length
      if (load.kind === 'distributed') {
        if (!validPosition(load.start ?? 0) || !validPosition(load.end ?? length) || (load.start ?? 0) >= (load.end ?? length)) return false
      } else if (!validPosition(load.position)) return false
    } else {
      return false
    }
    if (snapshot.dimension === 2) {
      const vector = load.sourceVector ?? load.vector
      if (load.kind === 'moment') {
        if (Math.abs(vector.x) > COORDINATE_TOLERANCE || Math.abs(vector.z) > COORDINATE_TOLERANCE) return false
      } else if (Math.abs(vector.y) > COORDINATE_TOLERANCE || Math.abs((load.sourceEndVector ?? load.endVector)?.y || 0) > COORDINATE_TOLERANCE) {
        return false
      }
    }
    if (load.sourceVector) {
      if (referenceFrame === 'global' && !vectorsMatch(load.sourceVector, load.vector)) return false
      if (referenceFrame === 'element-local') {
        const axes = load.elementId ? elements.get(load.elementId)?.localAxes : undefined
        if (!axes) return false
        const expected = {
          x: axes.x.x * load.sourceVector.x + axes.y.x * load.sourceVector.y + axes.z.x * load.sourceVector.z,
          y: axes.x.y * load.sourceVector.x + axes.y.y * load.sourceVector.y + axes.z.y * load.sourceVector.z,
          z: axes.x.z * load.sourceVector.x + axes.y.z * load.sourceVector.y + axes.z.z * load.sourceVector.z,
        }
        if (!vectorsMatch(expected, load.vector)) return false
      }
    } else if (referenceFrame === 'element-local') {
      return false
    }
    if (load.endVector) {
      if (!load.sourceEndVector) return false
      if (referenceFrame === 'global' && !vectorsMatch(load.sourceEndVector, load.endVector)) return false
      if (referenceFrame === 'element-local') {
        const axes = elements.get(load.elementId!)?.localAxes
        if (!axes) return false
        const vector = load.sourceEndVector
        if (!vectorsMatch(load.endVector, {
          x: axes.x.x * vector.x + axes.y.x * vector.y + axes.z.x * vector.z,
          y: axes.x.y * vector.x + axes.y.y * vector.y + axes.z.y * vector.z,
          z: axes.x.z * vector.x + axes.y.z * vector.y + axes.z.z * vector.z,
        })) return false
      }
    }
  }

  const caseIds = new Set<string>()
  for (const resultCase of snapshot.cases) {
    if (!resultCase || typeof resultCase.id !== 'string' || !resultCase.id || caseIds.has(resultCase.id)) return false
    caseIds.add(resultCase.id)
    if (resultCase.memberResponses !== undefined) {
      if (!resultCase.memberResponses || typeof resultCase.memberResponses !== 'object' || Array.isArray(resultCase.memberResponses)
        || Object.entries(resultCase.memberResponses).some(([id, row]) => id !== row?.id)) return false
      try {
        normalizeMemberResponses(Object.values(resultCase.memberResponses), elements, snapshot.dimension)
      } catch { return false }
    }
    for (const [nodeId, result] of Object.entries(resultCase.nodeResults || {})) {
      if (!nodePositions.has(nodeId) || !result) return false
      if (!finiteResultComponents(result.displacement) || !finiteResultComponents(result.reaction)) return false
      if (snapshot.dimension === 2) {
        const displacement = result.displacement || {}
        const reaction = result.reaction || {}
        if ([displacement.uy, displacement.rx, displacement.rz, reaction.fy, reaction.mx, reaction.mz]
          .some((entry) => typeof entry === 'number' && Math.abs(entry) > COORDINATE_TOLERANCE)) return false
      }
    }
    for (const [elementId, result] of Object.entries(resultCase.elementResults || {})) {
      if (!elements.has(elementId) || !result) return false
      const numericValues = [result.axial, result.shear, result.moment, result.torsion, result.utilization]
      if (numericValues.some((entry) => entry !== undefined && (typeof entry !== 'number' || !Number.isFinite(entry)))) return false
      if (!finiteResultComponents(result.endForces)) return false
    }
  }
  if (snapshot.cases.length > 0 && !caseIds.has(snapshot.defaultCaseId)) return false

  return [...(snapshot.bucklingModes || []), ...snapshot.cases.flatMap(item => item.bucklingModes || [])].every((mode) => (
    Number.isFinite(mode.lambda)
    && Object.entries(mode.modeShape).every(([nodeId, vector]) => (
      nodePositions.has(nodeId)
      && Array.isArray(vector)
      && vector.length === 3
      && vector.every(Number.isFinite)
      && (snapshot.dimension === 3 || Math.abs(vector[1]) <= COORDINATE_TOLERANCE)
    ))
  ))
}

export function normalizeVisualizationSnapshot(snapshot: VisualizationSnapshot): VisualizationSnapshot {
  return snapshot
}
