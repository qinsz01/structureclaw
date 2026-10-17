import type { BucklingMode, VisualizationCase, VisualizationSource, VisualizationViewMode } from '../types'
import { asRecord, asNonEmptyString, asNumber, vectorMagnitude, parseVector3 } from './values'
import { COORDINATE_TOLERANCE } from './vectors'

export function buildAvailableViews(cases: VisualizationCase[], source: VisualizationSource, hasUtilization = false, hasBuckling = false): VisualizationViewMode[] {
  if (source === 'model') {
    return ['model']
  }
  const hasDisplacements = cases.some((item) =>
    Object.values(item.nodeResults).some((result) => vectorMagnitude([result.displacement?.ux, result.displacement?.uy, result.displacement?.uz]) > 0)
    || Object.values(item.memberResponses || {}).some((row) => row.samples.some((sample) => sample.displacement && vectorMagnitude(sample.displacement) > 0))
  )
  const hasForces = cases.some((item) =>
    Object.values(item.elementResults).some((result) =>
      [result.axial, result.shear, result.moment, result.torsion].some((value) => typeof value === 'number')
    ) || Object.values(item.memberResponses || {}).some(row => (row.state === 'native-stations' || row.state === 'force-only') && row.samples.length > 0)
  )
  const hasReactions = cases.some((item) =>
    Object.values(item.nodeResults).some((result) =>
      vectorMagnitude([result.reaction?.fx, result.reaction?.fy, result.reaction?.fz]) > 0
      || vectorMagnitude([result.reaction?.mx, result.reaction?.my, result.reaction?.mz]) > 0
    )
  )

  return [
    'model',
    ...(hasDisplacements ? (['deformed'] as const) : []),
    ...(hasForces ? (['forces'] as const) : []),
    ...(hasReactions ? (['reactions'] as const) : []),
    ...(hasUtilization ? (['utilization'] as const) : []),
    ...(hasBuckling ? (['buckling'] as const) : []),
  ]
}

export function deriveUnits(model: Record<string, unknown> | null, analysis: Record<string, unknown> | null) {
  const analysisMeta = asRecord(analysis?.meta)
  const unitSystemRaw = asNonEmptyString(model?.unit_system)
    || asNonEmptyString(model?.unitSystem)
    || asNonEmptyString(model?.units)
    || asNonEmptyString(analysisMeta?.unitSystem)
    || asNonEmptyString(analysisMeta?.unit_system)
    || 'SI'
  const unitSystem = unitSystemRaw.toUpperCase()
  const normalizedUnitSystem = unitSystem.replace(/[^A-Z0-9]/g, '')
  const unitTokens = unitSystem.split(/[^A-Z0-9]+/).filter(Boolean)
  const usesMillimeterLength = normalizedUnitSystem.includes('MM')
  const usesKilonewton = normalizedUnitSystem.includes('KN')
  const usesNewton = !usesKilonewton && (
    unitTokens.includes('N')
    || normalizedUnitSystem === 'N'
    || normalizedUnitSystem.startsWith('NM')
  )
  const lengthUnit = usesMillimeterLength ? 'mm' : 'm'
  const forceUnit = usesNewton ? 'N' : 'kN'
  const displacementDisplayFactor = lengthUnit === 'm' ? 1000 : 1

  // StructureClaw's SI convention is coordinates in m and forces in kN.
  return {
    unitSystem,
    lengthUnit,
    displacementUnit: 'mm',
    displacementDisplayFactor,
    forceUnit,
    momentUnit: `${forceUnit}.${lengthUnit}`,
    nodalLoadUnit: forceUnit,
    distributedLoadUnit: `${forceUnit}/${lengthUnit}`,
  }
}

export function deriveMemberUtilizationMap(
  data: Record<string, unknown> | null,
  elementIds: Set<string>,
  providedMap?: Record<string, number> | null,
) {
  const steelCheck = asRecord(data?.steelCheck)
  const codeCheck = asRecord(data?.codeCheck)
  const source = providedMap && Object.keys(providedMap).length > 0
    ? providedMap
    : asRecord(steelCheck?.memberUtilization) || asRecord(codeCheck?.memberUtilization)
  if (!source) {
    return null
  }
  const normalized: Record<string, number> = {}
  for (const [elementId, value] of Object.entries(source)) {
    const ratio = asNumber(value)
    if (!elementIds.has(elementId) || ratio === null) {
      throw new Error(`Member utilization '${elementId}' must map a finite value to a model element`)
    }
    normalized[elementId] = ratio
  }
  return normalized
}

export function deriveBucklingModes(
  data: Record<string, unknown> | null,
  nodeIds: Set<string>,
  dimension: 2 | 3,
  providedModes?: BucklingMode[] | null,
) {
  const buckling = asRecord(data?.buckling)
  const modes = Array.isArray(providedModes) && providedModes.length > 0
    ? providedModes
    : Array.isArray(buckling?.modes) ? buckling.modes : []
  const normalized: BucklingMode[] = []
  modes.forEach((entry, index) => {
    const record = asRecord(entry)
    const lambda = asNumber(record?.lambda)
    const rawModeShape = asRecord(record?.modeShape)
    if (!record || lambda === null || !rawModeShape) {
      throw new Error(`Buckling mode ${index + 1} must have a finite lambda and node mode-shape map`)
    }
    const modeShape: Record<string, [number, number, number]> = {}
    for (const [nodeId, rawVector] of Object.entries(rawModeShape)) {
      const vector = parseVector3(rawVector)
      if (!nodeIds.has(nodeId) || !vector) {
        throw new Error(`Buckling mode ${index + 1} references an invalid model node '${nodeId}'`)
      }
      if (dimension === 2 && Math.abs(vector.y) > COORDINATE_TOLERANCE) {
        throw new Error(`Buckling mode ${index + 1} has an out-of-plane global Y component`)
      }
      modeShape[nodeId] = [vector.x, vector.y, vector.z]
    }
    normalized.push({ lambda, modeShape })
  })
  return normalized.length > 0 ? normalized : null
}
