import type { VisualizationElement, VisualizationNode } from '../types'
import { asRecord, asNumber, asStringId, parseRestraints, parseVector3, pickElementNodeIds, pickNodeCoordinate } from './values'
import { buildElementLocalAxes } from './vectors'

/** Normalizes model nodes; any malformed or duplicate node invalidates the set. */
export function normalizeSnapshotNodes(nodesInput: unknown[]) {
  let invalidNodeRecord = false
  const nodeIds = new Set<string>()
  const nodes: VisualizationNode[] = []
  for (const value of nodesInput) {
    const node = asRecord(value)
    const id = asStringId(node?.id)
    const x = node ? pickNodeCoordinate(node, 'x') : null
    const y = node ? pickNodeCoordinate(node, 'y') : null
    const z = node ? pickNodeCoordinate(node, 'z') : null
    const restraints = node ? parseRestraints(node.restraints) : null
    if (!node || !id || nodeIds.has(id) || x === null || y === null || z === null || restraints === null) {
      invalidNodeRecord = true
      continue
    }
    nodeIds.add(id)
    nodes.push({
      id,
      position: { x, y, z },
      restraints: restraints || undefined,
    })
  }

  return { nodes, invalidNodeRecord }
}

/**
 * Normalizes model elements and their local axes. `invalidElementCoordinates`
 * is set when ids, node references, reference vectors or rotations are invalid.
 */
export function normalizeSnapshotElements(
  model: Record<string, unknown>,
  nodes: VisualizationNode[],
  elementsInput: unknown[],
  dimension: 2 | 3,
) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const metadata = asRecord(model.metadata)
  const rawElementReferenceVectors = metadata?.elementReferenceVectors
  const elementReferenceVectors = asRecord(rawElementReferenceVectors)
  let invalidElementCoordinates = rawElementReferenceVectors !== undefined
    && (dimension === 2 || !elementReferenceVectors)
  const elementIds = new Set<string>()
  const elements: VisualizationElement[] = []
  for (const value of elementsInput) {
    const element = asRecord(value)
    const id = asStringId(element?.id)
    if (!element || !id || elementIds.has(id)) {
      invalidElementCoordinates = true
      continue
    }
    elementIds.add(id)
    const nodeIds = pickElementNodeIds(element)
    const elementType = typeof element.type === 'string' ? element.type : 'beam'
    const isLineElement = ['beam', 'truss', 'column', 'brace', 'link'].includes(elementType)
    if (
      !nodeIds
      || new Set(nodeIds).size !== nodeIds.length
      || (isLineElement && nodeIds.length !== 2)
      || (!isLineElement && nodeIds.length < 2)
    ) {
      invalidElementCoordinates = true
      continue
    }
    const start = nodeById.get(nodeIds[0])
    const end = nodeById.get(nodeIds[1])
    const rawReferenceVector = elementReferenceVectors?.[id]
    const referenceVector = rawReferenceVector === undefined ? undefined : parseVector3(rawReferenceVector)
    const rotationDegrees = element.rotation_angle === undefined || element.rotation_angle === null
      ? undefined
      : asNumber(element.rotation_angle)
    const localAxes = isLineElement && start && end && referenceVector !== null && rotationDegrees !== null
      ? buildElementLocalAxes({
          start: start.position,
          end: end.position,
          dimension,
          referenceVector,
          rotationDegrees,
        })
      : null
    if (
      !start
      || !end
      || referenceVector === null
      || rotationDegrees === null
      || (isLineElement && !localAxes)
    ) {
      invalidElementCoordinates = true
    }
    elements.push({
      id,
      type: elementType,
      nodeIds,
      material: typeof element.material === 'string' ? element.material : undefined,
      section: typeof element.section === 'string' ? element.section : undefined,
      localAxes: localAxes || undefined,
    })
  }
  if (elementReferenceVectors && Object.keys(elementReferenceVectors).some((id) => !elementIds.has(id))) {
    invalidElementCoordinates = true
  }

  return { elements, elementIds, invalidElementCoordinates }
}
