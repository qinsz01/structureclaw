import type { VisualizationPlane } from '../types'
import { asRecord } from './values'

export function deriveCoordinateSemantics(model: Record<string, unknown> | null): {
  dimension: 2 | 3
  plane?: VisualizationPlane
  semantics: string
  version?: number
} | null {
  if (!model || typeof model !== 'object') return null
  const coordinateSystem = asRecord(model.coordinate_system)
  const metadata = asRecord(model.metadata)
  if (coordinateSystem) {
    if (coordinateSystem.semantics !== 'global-z-up') {
      throw new Error(`Unsupported coordinate semantics '${String(coordinateSystem.semantics)}'`)
    }
    if (coordinateSystem.version !== 1) {
      throw new Error(`Unsupported coordinate contract version '${String(coordinateSystem.version)}'`)
    }
    if (coordinateSystem.dimension !== '2d' && coordinateSystem.dimension !== '3d') {
      throw new Error(`Unsupported coordinate dimension '${String(coordinateSystem.dimension)}'`)
    }
    const dimension = coordinateSystem.dimension === '3d' ? 3 : 2
    if (dimension === 2 && coordinateSystem.plane !== 'xz') {
      throw new Error("Canonical 2-D visualization requires the global X-Z plane")
    }
    if (dimension === 3 && coordinateSystem.plane !== null) {
      throw new Error("Canonical 3-D visualization cannot declare a 2-D plane")
    }
    const dofOrder = coordinateSystem.dof_order
    const canonicalDofOrder = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz']
    if (!Array.isArray(dofOrder) || dofOrder.length !== canonicalDofOrder.length || !dofOrder.every((value, index) => value === canonicalDofOrder[index])) {
      throw new Error('Coordinate contract has an invalid six-DOF order')
    }
    if (metadata?.coordinateSemantics !== undefined && metadata.coordinateSemantics !== 'global-z-up') {
      throw new Error('Model metadata conflicts with coordinate_system.semantics')
    }
    if (metadata?.coordinateContractVersion !== undefined && metadata.coordinateContractVersion !== 1) {
      throw new Error('Model metadata conflicts with coordinate_system.version')
    }
    const metadataDimension = metadata?.frameDimension
    if (metadataDimension !== undefined && metadataDimension !== coordinateSystem.dimension) {
      throw new Error('Model metadata conflicts with coordinate_system.dimension')
    }
    return {
      dimension,
      plane: dimension === 2 ? 'xz' : 'xy',
      semantics: 'global-z-up',
      version: 1,
    }
  }
  return null
}

export function analysisCoordinateContractMatches(
  analysis: Record<string, unknown> | null,
  data: Record<string, unknown> | null,
  dimension: 2 | 3,
): boolean {
  const coordinateKeys = [
    'coordinateSemantics',
    'coordinateContractVersion',
    'dimension',
    'plane',
    'dofOrder',
    'activeDofs',
    'nodalResultFrame',
    'elementForceFrame',
  ]
  const declarations = [asRecord(data?.meta), asRecord(analysis?.meta)]
    .filter((meta): meta is Record<string, unknown> => Boolean(meta))
    .filter((meta) => coordinateKeys.some((key) => meta[key] !== undefined))
  if (!declarations.length) return false
  const expectedDimension = dimension === 2 ? '2d' : '3d'
  const dofOrder = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz']
  const activeDofs = dimension === 2 ? ['ux', 'uz', 'ry'] : dofOrder
  const matchesOrder = (value: unknown, expected: string[]) => (
    Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index])
  )
  return declarations.every((meta) => (
    meta.coordinateSemantics === 'global-z-up'
    && meta.coordinateContractVersion === 1
    && meta.dimension === expectedDimension
    && meta.plane === (dimension === 2 ? 'xz' : null)
    && matchesOrder(meta.dofOrder, dofOrder)
    && matchesOrder(meta.activeDofs, activeDofs)
    && meta.nodalResultFrame === 'global'
    && meta.elementForceFrame === 'element-local'
  ))
}
