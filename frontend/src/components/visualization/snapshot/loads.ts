import type { VisualizationElement, VisualizationLoad, VisualizationNode, VisualizationVector3 } from '../types'
import { asRecord, asNonEmptyString, asNumber, asStringId, vectorMagnitude } from './values'
import { COORDINATE_TOLERANCE, transformLocalVectorToGlobal } from './vectors'
import { getFloorAreaLoads } from './floor-loads'

function resolveTargetAlias(load: Record<string, unknown>, keys: string[], label: string): string | null {
  const values = keys
    .filter((key) => load[key] !== undefined && load[key] !== null)
    .map((key) => asStringId(load[key]))
  if (values.some((value) => value === null)) {
    throw new Error(`${label} target must have a non-empty id`)
  }
  const unique = Array.from(new Set(values as string[]))
  if (unique.length > 1) {
    throw new Error(`${label} contains conflicting target aliases`)
  }
  return unique[0] || null
}

function resolveNumericAliases(
  load: Record<string, unknown>,
  keys: string[],
  label: string,
  fallback = 0,
): number {
  const values = keys
    .filter((key) => load[key] !== undefined && load[key] !== null)
    .map((key) => {
      const value = asNumber(load[key])
      if (value === null) throw new Error(`${label} must be finite`)
      return value
    })
  if (!values.length) return fallback
  if (values.some((value) => Math.abs(value - values[0]) > COORDINATE_TOLERANCE)) {
    throw new Error(`${label} has conflicting aliases`)
  }
  return values[0]
}

function resolveDirectionalMagnitude(
  load: Record<string, unknown>,
  componentKeys: string[],
  magnitudeKeys: string[],
  label: string,
): number {
  const keys = [...magnitudeKeys, ...componentKeys]
  const present = keys.filter((key) => load[key] !== undefined && load[key] !== null)
  if (!present.length) throw new Error(`${label} requires a finite magnitude`)
  return resolveNumericAliases(load, present, label)
}

function resolveNodalLoadVectors(load: Record<string, unknown>): {
  force: VisualizationVector3
  moment: VisualizationVector3
} {
  if (load.forces !== undefined) {
    if (!Array.isArray(load.forces) || load.forces.length !== 6) {
      throw new Error('Nodal load forces must contain [fx, fy, fz, mx, my, mz]')
    }
    if (
      ['fx', 'fy', 'fz', 'mx', 'my', 'mz', 'value', 'magnitude', 'direction', 'axis']
        .some((key) => load[key] !== undefined)
    ) {
      throw new Error('Nodal load forces cannot be combined with component or directional aliases')
    }
    const values = load.forces.map((value) => asNumber(value))
    if (values.some((value) => value === null)) {
      throw new Error('Nodal load forces must contain six finite values')
    }
    return {
      force: { x: values[0] as number, y: values[1] as number, z: values[2] as number },
      moment: { x: values[3] as number, y: values[4] as number, z: values[5] as number },
    }
  }

  const direction = String(load.direction ?? load.axis ?? '').trim().toLowerCase()
  const magnitudeKeys = ['value', 'magnitude'].filter((key) => load[key] !== undefined)
  const legacyComponentNames = ['Fx', 'Fy', 'Fz', 'Mx', 'My', 'Mz', 'momentX', 'momentY', 'momentZ']
    .filter((key) => load[key] !== undefined)
  if (legacyComponentNames.length) {
    throw new Error(`V2 nodal load components must use lowercase names: ${legacyComponentNames.join(', ')}`)
  }
  let x = resolveNumericAliases(load, ['fx'], 'Nodal load fx')
  let y = resolveNumericAliases(load, ['fy'], 'Nodal load fy')
  let z = resolveNumericAliases(load, ['fz'], 'Nodal load fz')
  let mx = resolveNumericAliases(load, ['mx'], 'Nodal load mx')
  let my = resolveNumericAliases(load, ['my'], 'Nodal load my')
  let mz = resolveNumericAliases(load, ['mz'], 'Nodal load mz')
  if (direction === 'x' || direction === 'fx') {
    x = resolveDirectionalMagnitude(load, ['fx'], magnitudeKeys, 'Nodal load X')
  } else if (direction === 'y' || direction === 'fy') {
    y = resolveDirectionalMagnitude(load, ['fy'], magnitudeKeys, 'Nodal load Y')
  } else if (direction === 'z' || direction === 'fz') {
    z = resolveDirectionalMagnitude(load, ['fz'], magnitudeKeys, 'Nodal load Z')
  } else if (direction === 'mx' || direction === 'rx') {
    mx = resolveDirectionalMagnitude(load, ['mx'], magnitudeKeys, 'Nodal moment X')
  } else if (direction === 'my' || direction === 'ry') {
    my = resolveDirectionalMagnitude(load, ['my'], magnitudeKeys, 'Nodal moment Y')
  } else if (direction === 'mz' || direction === 'rz') {
    mz = resolveDirectionalMagnitude(load, ['mz'], magnitudeKeys, 'Nodal moment Z')
  } else if (direction) {
    throw new Error(`Nodal load has unknown direction '${direction}'`)
  } else if (!direction && magnitudeKeys.length) {
    throw new Error('Nodal load value/magnitude requires an explicit direction')
  }
  return { force: { x, y, z }, moment: { x: mx, y: my, z: mz } }
}

function resolveDistributedLoadVector(load: Record<string, unknown>): VisualizationVector3 {
  const direction = String(load.direction ?? load.axis ?? '').trim().toLowerCase()
  const magnitudeKeys = ['q', 'w', 'value', 'magnitude'].filter((key) => load[key] !== undefined)
  let x = resolveNumericAliases(load, ['wx'], 'Distributed load wx')
  let y = resolveNumericAliases(load, ['wy'], 'Distributed load wy')
  let z = resolveNumericAliases(load, ['wz'], 'Distributed load wz')
  if (['x', 'local-x', '0'].includes(direction)) {
    x = resolveDirectionalMagnitude(load, ['wx'], magnitudeKeys, 'Distributed load X')
    y = 0
    z = 0
  } else if (['y', 'local-y', '1'].includes(direction)) {
    y = resolveDirectionalMagnitude(load, ['wy'], magnitudeKeys, 'Distributed load Y')
    z = 0
  } else if (['z', 'local-z', '2'].includes(direction)) {
    y = 0
    z = resolveDirectionalMagnitude(load, ['wz'], magnitudeKeys, 'Distributed load Z')
  } else if (direction) {
    throw new Error(`Distributed load has unknown direction '${direction}'`)
  } else if (magnitudeKeys.length) {
    throw new Error('Distributed load q/w/value/magnitude requires an explicit direction')
  }
  return { x, y, z }
}

export function getLoads(
  model: Record<string, unknown> | null,
  nodes: VisualizationNode[],
  elements: VisualizationElement[],
  dimension: 2 | 3,
  includeFloorAreas = true,
): VisualizationLoad[] {
  const loadCases = Array.isArray(model?.load_cases) ? model?.load_cases : []
  const loads: VisualizationLoad[] = includeFloorAreas ? getFloorAreaLoads(model, nodes) : []
  const representedFloorLoads = new Set(
    loads.flatMap((load) => (load.kind === 'area' && load.storyId
      ? (load.components || []).map((component) => `${load.storyId}:${component.type}`)
      : [])),
  )
  const elementById = new Map(elements.map((element) => [element.id, element]))
  const nodeById = new Map(nodes.map(node => [node.id, node.position]))
  const nodeIds = new Set(nodes.map((node) => node.id))

  loadCases.forEach((loadCase) => {
    const loadCaseRecord = asRecord(loadCase)
    const caseId = typeof loadCaseRecord?.id === 'string' ? loadCaseRecord.id : undefined
    const caseLoads = Array.isArray(loadCaseRecord?.loads) ? loadCaseRecord.loads : []
    caseLoads.forEach((entry) => {
      const load = asRecord(entry)
      if (!load) {
        return
      }
      const referenceFrameValue = load.reference_frame ?? 'global'
      if (referenceFrameValue !== 'global' && referenceFrameValue !== 'element-local') {
        throw new Error(`Unsupported load reference frame '${String(referenceFrameValue)}'`)
      }
      const referenceFrame = referenceFrameValue
      const declaredDirection = String(load.direction ?? load.axis ?? '').trim().toLowerCase()
      if (declaredDirection.startsWith('local-') && referenceFrame !== 'element-local') {
        throw new Error(`Load direction '${declaredDirection}' requires reference_frame='element-local'`)
      }
      const nodeId = resolveTargetAlias(load, ['node', 'nodeId', 'node_id'], 'Nodal load')
      const elementId = resolveTargetAlias(load, ['element', 'elementId', 'element_id'], 'Distributed load')
      if (nodeId && elementId) {
        throw new Error('A load cannot target both a node and an element')
      }
      if (nodeId) {
        if (!nodeIds.has(nodeId)) {
          throw new Error(`Nodal load references unknown node '${nodeId}'`)
        }
        if (referenceFrame !== 'global') {
          throw new Error(`Nodal load on '${nodeId}' cannot use an element-local reference frame`)
        }
        if (['wx', 'wy', 'wz'].some((key) => load[key] !== undefined)) {
          throw new Error(`Nodal load on '${nodeId}' must not use member-load w components`)
        }
        const { force, moment } = resolveNodalLoadVectors(load)
        if (dimension === 2 && Math.abs(force.y) > COORDINATE_TOLERANCE) {
          throw new Error(`Nodal load on '${nodeId}' has an out-of-plane global Y component in a 2-D model`)
        }
        if (dimension === 2 && (Math.abs(moment.x) > COORDINATE_TOLERANCE || Math.abs(moment.z) > COORDINATE_TOLERANCE)) {
          throw new Error(`Nodal moment on '${nodeId}' must act only about global Y in a 2-D model`)
        }
        const derivedFloorLoadKey = `${asStringId(load.story) || ''}:${asNonEmptyString(load.load_kind)?.toLowerCase() || ''}`
        if (load.source === 'story_floor_loads' && representedFloorLoads.has(derivedFloorLoadKey)) {
          return
        }
        if (vectorMagnitude([force.x, force.y, force.z]) > COORDINATE_TOLERANCE) {
          loads.push({
            nodeId,
            caseId,
            kind: 'nodal',
            vector: force,
            referenceFrame,
            sourceVector: force,
          })
        }
        if (vectorMagnitude([moment.x, moment.y, moment.z]) > COORDINATE_TOLERANCE) {
          loads.push({
            nodeId,
            caseId,
            kind: 'moment',
            vector: moment,
            referenceFrame,
            sourceVector: moment,
          })
        }
        return
      }
      if (elementId) {
        const element = elementById.get(elementId)
        if (!element) {
          throw new Error(`Distributed load references unknown element '${elementId}'`)
        }
        const first = nodeById.get(element.nodeIds[0])!
        const last = nodeById.get(element.nodeIds[1])!
        const length = Math.hypot(last.x - first.x, last.y - first.y, last.z - first.z)
        const position = (value: unknown, fallback?: number) => {
          const number = value === undefined ? fallback : asNumber(value)
          if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > length) {
            throw new Error(`Member load on '${elementId}' must lie within [0, ${length}] from its i end`)
          }
          return number
        }
        const globalVector = (vector: VisualizationVector3) => referenceFrame === 'element-local'
          ? transformLocalVectorToGlobal(vector, element.localAxes!) : { ...vector }
        if (referenceFrame === 'element-local' && !element.localAxes) throw new Error('Member load local axes are unavailable')
        if (load.type === 'point') {
          if (['wx', 'wy', 'wz', 'forces', 'direction', 'magnitude'].some(key => load[key] !== undefined)) {
            throw new Error('Member point loads must use explicit fx/fy/fz/mx/my/mz')
          }
          const point = position(load.position)
          const { force, moment } = resolveNodalLoadVectors(load)
          if (dimension === 2 && (Math.abs(force.y) > COORDINATE_TOLERANCE
            || Math.abs(moment.x) > COORDINATE_TOLERANCE || Math.abs(moment.z) > COORDINATE_TOLERANCE)) {
            throw new Error('Member point load has inactive 2-D components')
          }
          for (const [kind, vector] of [['point', force], ['moment', moment]] as const) {
            if (vectorMagnitude([vector.x, vector.y, vector.z]) <= COORDINATE_TOLERANCE) continue
            loads.push({ elementId, caseId, kind, position: point, vector: globalVector(vector), referenceFrame, sourceVector: vector })
          }
          return
        }
        if (['fx', 'fy', 'fz', 'mx', 'my', 'mz', 'forces'].some((key) => load[key] !== undefined)) {
          throw new Error(`Distributed load on '${elementId}' must use only wx/wy/wz components`)
        }
        const start = position(load.start, 0)
        const end = position(load.end, length)
        if (end <= start) throw new Error('Distributed load end must exceed start')
        const distribution = load.distribution ?? 'uniform'
        let points: Array<{ position: number; vector: VisualizationVector3 }>
        if (distribution === 'piecewise_linear') {
          if (!Array.isArray(load.points) || load.points.length < 2) throw new Error('Piecewise load needs at least two points')
          points = load.points.map(value => {
            const point = asRecord(value)
            const fraction = asNumber(point?.position)
            if (!point || fraction === null || fraction < 0 || fraction > 1) throw new Error('Piecewise positions must be member-length fractions')
            return { position: fraction * length, vector: resolveDistributedLoadVector(point) }
          })
          if (Math.abs(points[0].position - start) > COORDINATE_TOLERANCE || Math.abs(points.at(-1)!.position - end) > COORDINATE_TOLERANCE
            || points.some((point, index) => index > 0 && point.position <= points[index - 1].position)) {
            throw new Error('Piecewise points must increase and cover the declared load interval')
          }
        } else if (distribution === 'uniform' && load.points === undefined) {
          const vector = resolveDistributedLoadVector(load)
          points = [{ position: start, vector }, { position: end, vector }]
        } else throw new Error(`Unsupported member load distribution '${String(distribution)}'`)
        if (dimension === 2 && points.some(point => Math.abs(point.vector.y) > COORDINATE_TOLERANCE)) {
          throw new Error(`Distributed load on '${elementId}' has an out-of-plane Y component in a 2-D model`)
        }
        for (let index = 1; index < points.length; index++) {
          const p = points[index - 1], q = points[index]
          loads.push({ elementId, caseId, kind: 'distributed', start: p.position, end: q.position,
            vector: globalVector(p.vector), endVector: globalVector(q.vector), referenceFrame,
            sourceVector: p.vector, sourceEndVector: q.vector })
        }
        return
      }
      throw new Error('Every visualization load must target exactly one node or element')
    })
  })

  return loads
}
