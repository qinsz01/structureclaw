import type { VisualizationElement, VisualizationLocalAxes } from '../types'
import { hasUnavailableDisplacements, normalizeMemberResponses } from '../normalization'
import { asRecord, asNumber, parseVector3 } from './values'
import { COORDINATE_TOLERANCE } from './vectors'

function validateResultEntityMap(
  value: unknown,
  validIds: Set<string>,
  label: string,
  componentKeys: string[],
): void {
  if (value === undefined || value === null) return
  const record = asRecord(value)
  if (!record) throw new Error(`${label} must be an object keyed by canonical model ids`)
  for (const [id, rawEntry] of Object.entries(record)) {
    if (!validIds.has(id)) throw new Error(`${label} references unknown id '${id}'`)
    const entry = asRecord(rawEntry)
    if (!entry) throw new Error(`${label} entry '${id}' must be an object`)
    for (const key of componentKeys) {
      if (entry[key] !== undefined && asNumber(entry[key]) === null) {
        throw new Error(`${label} entry '${id}.${key}' must be finite`)
      }
    }
  }
}

function validateElementForceMap(
  value: unknown,
  elements: Map<string, VisualizationElement>,
  label: string,
): void {
  validateResultEntityMap(value, new Set(elements.keys()), label, [
    'axial', 'stress', 'N', 'V', 'Vy', 'Vz', 'T', 'M', 'My', 'Mz', 'torsion',
  ])
  const record = asRecord(value)
  if (!record) return
  const componentKeys = ['N', 'V', 'Vy', 'Vz', 'V2', 'V3', 'T', 'M', 'My', 'Mz', 'M2', 'M3']
  for (const [elementId, rawEntry] of Object.entries(record)) {
    const entry = asRecord(rawEntry) as Record<string, unknown>
    if (entry.referenceFrame !== undefined && entry.referenceFrame !== 'element-local') {
      throw new Error(`${label} entry '${elementId}' must use the element-local frame`)
    }
    for (const end of ['n1', 'n2']) {
      if (entry[end] === undefined) continue
      const endRecord = asRecord(entry[end])
      if (!endRecord) throw new Error(`${label} entry '${elementId}.${end}' must be an object`)
      for (const key of componentKeys) {
        if (endRecord[key] !== undefined && asNumber(endRecord[key]) === null) {
          throw new Error(`${label} entry '${elementId}.${end}.${key}' must be finite`)
        }
      }
    }
    if (entry.localAxes !== undefined) {
      const axesRecord = asRecord(entry.localAxes)
      const resultAxes = axesRecord && {
        x: parseVector3(axesRecord.x),
        y: parseVector3(axesRecord.y),
        z: parseVector3(axesRecord.z),
      }
      const modelAxes = elements.get(elementId)?.localAxes
      if (!resultAxes || !resultAxes.x || !resultAxes.y || !resultAxes.z || !modelAxes) {
        throw new Error(`${label} entry '${elementId}.localAxes' must contain finite X/Y/Z vectors`)
      }
      const validatedAxes: VisualizationLocalAxes = {
        x: resultAxes.x,
        y: resultAxes.y,
        z: resultAxes.z,
      }
      for (const axis of ['x', 'y', 'z'] as const) {
        for (const component of ['x', 'y', 'z'] as const) {
          if (Math.abs(validatedAxes[axis][component] - modelAxes[axis][component]) > 1e-6) {
            throw new Error(`${label} entry '${elementId}.localAxes' conflicts with the model`)
          }
        }
      }
    }
  }
}

export function validateAnalysisResultReferences(
  data: Record<string, unknown> | null,
  nodeIds: Set<string>,
  elements: Map<string, VisualizationElement>,
  dimension: 2 | 3,
): void {
  if (!data) throw new Error('Analysis result data must be an object')
  const rejectNonzeroComponents = (value: unknown, label: string, keys: string[]) => {
    if (dimension !== 2) return
    const record = asRecord(value)
    if (!record) return
    for (const [id, rawEntry] of Object.entries(record)) {
      const entry = asRecord(rawEntry)
      if (!entry) continue
      for (const key of keys) {
        const component = entry[key] === undefined ? 0 : asNumber(entry[key])
        if (component !== null && Math.abs(component) > COORDINATE_TOLERANCE) {
          throw new Error(`${label} entry '${id}.${key}' is out of plane for a canonical X-Z model`)
        }
      }
    }
  }
  const validateResultSet = (result: Record<string, unknown>) => {
    const displacementsUnavailable = hasUnavailableDisplacements(result)
    if (displacementsUnavailable && Object.keys(asRecord(result.displacements) || {}).length) {
      throw new Error('Displacements conflict with the declared unavailable response scope')
    }
    normalizeMemberResponses(result.memberResponses, elements, dimension, displacementsUnavailable)
    validateResultEntityMap(result.displacements, nodeIds, 'Displacements', ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'])
    validateResultEntityMap(result.reactions, nodeIds, 'Reactions', ['fx', 'fy', 'fz', 'mx', 'my', 'mz'])
    validateElementForceMap(result.forces, elements, 'Element forces')
    rejectNonzeroComponents(result.displacements, 'Displacements', ['uy', 'rx', 'rz'])
    rejectNonzeroComponents(result.reactions, 'Reactions', ['fy', 'mx', 'mz'])
  }
  validateResultSet(data)
  if (data.caseResults !== undefined && !asRecord(data.caseResults)) {
    throw new Error('caseResults must be an object')
  }
  for (const [caseId, rawCase] of Object.entries(asRecord(data.caseResults) || {})) {
    const caseResult = asRecord(rawCase)
    if (!caseResult) throw new Error(`caseResults.${caseId} must be an object`)
    validateResultSet(caseResult)
  }

  if (data.envelopeTables !== undefined && !asRecord(data.envelopeTables)) {
    throw new Error('envelopeTables must be an object')
  }
  const envelopeTables = asRecord(data.envelopeTables)
  validateResultEntityMap(
    envelopeTables?.nodeDisplacement,
    nodeIds,
    'Envelope node displacements',
    ['maxAbsDisplacement'],
  )
  validateResultEntityMap(
    envelopeTables?.nodeReaction,
    nodeIds,
    'Envelope node reactions',
    ['maxAbsReaction'],
  )
  validateResultEntityMap(
    envelopeTables?.elementForce,
    new Set(elements.keys()),
    'Envelope element forces',
    ['maxAbsAxialForce', 'maxAbsShearForce', 'maxAbsMoment'],
  )
}
