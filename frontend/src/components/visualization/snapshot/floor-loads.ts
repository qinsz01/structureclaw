import type { VisualizationLoad, VisualizationNode } from '../types'
import { asRecord, asNonEmptyString, asStringId, pickNumber, pickNodeCoordinate } from './values'

export function nearlyEqual(left: number, right: number, tolerance = 1e-6) {
  return Math.abs(left - right) <= tolerance
}

export function getStoryFloorLoadComponents(story: Record<string, unknown>): Array<{ type: string; value: number }> {
  const components: Array<{ type: string; value: number }> = []
  const seenTypes = new Set<string>()
  const floorLoads = Array.isArray(story.floor_loads) ? story.floor_loads : []

  floorLoads.forEach((entry) => {
    const record = asRecord(entry)
    const value = pickNumber(record, ['value'])
    if (!record || value === null || Math.abs(value) <= 1e-12) {
      return
    }
    if (value < 0) {
      throw new Error('Story floor-load intensities must be nonnegative')
    }
    const type = asNonEmptyString(record.type)?.toLowerCase() || 'other'
    components.push({ type, value })
    seenTypes.add(type)
  })

  const fallbackFields: Array<[string, string]> = [
    ['dead_load', 'dead'],
    ['live_load', 'live'],
  ]
  fallbackFields.forEach(([field, type]) => {
    if (seenTypes.has(type)) {
      return
    }
    const value = pickNumber(story, [field])
    if (value !== null && Math.abs(value) > 1e-12) {
      if (value < 0) {
        throw new Error('Story floor-load intensities must be nonnegative')
      }
      components.push({ type, value })
    }
  })

  return components
}

export function getFloorAreaLoads(model: Record<string, unknown> | null, nodes: VisualizationNode[]): VisualizationLoad[] {
  const stories = Array.isArray(model?.stories) ? model.stories : []
  if (!stories.length || nodes.length < 4) {
    return []
  }

  const rawNodes = Array.isArray(model?.nodes) ? model.nodes : []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const rawNodeById = new Map<string, Record<string, unknown>>()
  rawNodes.forEach((entry) => {
    const record = asRecord(entry)
    const id = asStringId(record?.id)
    if (record && id) {
      rawNodeById.set(id, record)
    }
  })

  const loads: VisualizationLoad[] = []
  stories.forEach((entry, storyIndex) => {
    const story = asRecord(entry)
    if (!story) {
      return
    }

    const components = getStoryFloorLoadComponents(story)
    const intensity = components.reduce((sum, component) => sum + component.value, 0)
    if (Math.abs(intensity) <= 1e-12) {
      return
    }

    const storyId = asStringId(story.id)
    if (!storyId) {
      throw new Error(`Story at index ${storyIndex} must have a non-empty id`)
    }
    const height = pickNumber(story, ['height'])
    const baseElevation = pickNumber(story, ['elevation'])
    if (height === null || height <= 0 || baseElevation === null) {
      throw new Error(`Story '${storyId}' must declare finite elevation and positive height`)
    }
    const floorElevation = baseElevation + height

    const storyNodeIds = new Set<string>()
    rawNodeById.forEach((rawNode, nodeId) => {
      const rawStoryId = asStringId(rawNode.story)
      const z = pickNodeCoordinate(rawNode, 'z')
      if (
        z !== null
        && nearlyEqual(z, floorElevation)
        && (rawStoryId === null || rawStoryId === storyId)
      ) {
        storyNodeIds.add(nodeId)
      }
    })

    const floorNodes = Array.from(storyNodeIds)
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is VisualizationNode => Boolean(node))
    if (floorNodes.length < 4) {
      return
    }

    const coordinateKey = (value: number) => value.toFixed(9)
    const uniqueX = Array.from(new Set(floorNodes.map((node) => coordinateKey(node.position.x))))
    const uniqueY = Array.from(new Set(floorNodes.map((node) => coordinateKey(node.position.y))))
    const planCoordinates = new Set(
      floorNodes.map((node) => `${coordinateKey(node.position.x)}:${coordinateKey(node.position.y)}`),
    )
    if (
      planCoordinates.size !== floorNodes.length
      || planCoordinates.size !== uniqueX.length * uniqueY.length
      || uniqueX.some((x) => uniqueY.some((y) => !planCoordinates.has(`${x}:${y}`)))
    ) {
      // A story without a complete rectangular Cartesian grid has no exact
      // footprint polygon in the current schema.  Its explicit nodal/member
      // loads remain renderable, but an inferred area polygon would be wrong.
      return
    }

    const minX = Math.min(...floorNodes.map((node) => node.position.x))
    const maxX = Math.max(...floorNodes.map((node) => node.position.x))
    const minY = Math.min(...floorNodes.map((node) => node.position.y))
    const maxY = Math.max(...floorNodes.map((node) => node.position.y))
    if (maxX - minX <= 1e-6 || maxY - minY <= 1e-6) {
      return
    }

    const z = floorElevation
    const area = (maxX - minX) * (maxY - minY)
    loads.push({
      kind: 'area',
      storyId,
      label: storyId,
      intensity,
      area,
      components,
      vector: {
        x: 0,
        y: 0,
        z: -intensity,
      },
      polygon: [
        { x: minX, y: minY, z },
        { x: maxX, y: minY, z },
        { x: maxX, y: maxY, z },
        { x: minX, y: maxY, z },
      ],
    })
  })

  return loads
}
