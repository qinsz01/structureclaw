import type { VisualizationCase, VisualizationElementResults, VisualizationMemberResponse, VisualizationNodeResults } from '../types'
import { asRecord, asNumber, pickNumber, compactNumberRecord } from './values'

function flattenEndForces(source: Record<string, unknown> | null) {
  if (!source) {
    return {}
  }
  const flattened: Record<string, number> = {}
  Object.entries(source).forEach(([key, value]) => {
    const direct = asNumber(value)
    if (direct !== null) {
      flattened[key] = direct
      return
    }
    const nested = asRecord(value)
    if (!nested) {
      return
    }
    Object.entries(nested).forEach(([nestedKey, nestedValue]) => {
      const numeric = asNumber(nestedValue)
      if (numeric !== null) {
        flattened[`${key}.${nestedKey}`] = numeric
      }
    })
  })
  return flattened
}

function extractElementMetrics(entry: Record<string, unknown> | null): VisualizationElementResults {
  const flat = flattenEndForces(entry)
  const flatValues = Object.values(flat)
  const shearCandidates = [
    flat.V,
    flat.Vy,
    flat.Vz,
    flat['n1.V'],
    flat['n2.V'],
    flat['n1.Vy'],
    flat['n2.Vy'],
    flat['n1.Vz'],
    flat['n2.Vz'],
    flat['n1.Fy'],
    flat['n2.Fy'],
    flat['n1.Fz'],
    flat['n2.Fz'],
  ].filter((value): value is number => typeof value === 'number')
  const momentCandidates = [
    flat.M,
    flat.My,
    flat.Mz,
    flat['n1.M'],
    flat['n2.M'],
    flat['n1.My'],
    flat['n2.My'],
    flat['n1.Mz'],
    flat['n2.Mz'],
  ].filter((value): value is number => typeof value === 'number')

  return {
    axial: pickNumber(entry, ['axial', 'N']) ?? undefined,
    shear: shearCandidates.length ? Math.max(...shearCandidates.map((value) => Math.abs(value))) : undefined,
    moment: momentCandidates.length ? Math.max(...momentCandidates.map((value) => Math.abs(value))) : undefined,
    torsion: pickNumber(entry, ['torsion', 'T', 'Mx']) ?? undefined,
    endForces: flatValues.length ? flat : undefined,
  }
}

function extractNodeResults(entry: Record<string, unknown> | null): VisualizationNodeResults {
  return {
    displacement: entry
      ? compactNumberRecord([
          ['ux', pickNumber(entry, ['ux'])],
          ['uy', pickNumber(entry, ['uy'])],
          ['uz', pickNumber(entry, ['uz'])],
          ['rx', pickNumber(entry, ['rx'])],
          ['ry', pickNumber(entry, ['ry'])],
          ['rz', pickNumber(entry, ['rz'])],
        ])
      : undefined,
    reaction: entry
      ? compactNumberRecord([
          ['fx', pickNumber(entry, ['fx'])],
          ['fy', pickNumber(entry, ['fy'])],
          ['fz', pickNumber(entry, ['fz'])],
          ['mx', pickNumber(entry, ['mx'])],
          ['my', pickNumber(entry, ['my'])],
          ['mz', pickNumber(entry, ['mz'])],
        ])
      : undefined,
  }
}

export function buildCase(
  id: string,
  label: string,
  kind: VisualizationCase['kind'],
  displacementsInput: Record<string, unknown> | null,
  reactionsInput: Record<string, unknown> | null,
  forcesInput: Record<string, unknown> | null,
  envelopeInput?: Record<string, unknown> | null,
  memberResponses?: Record<string, VisualizationMemberResponse>,
): VisualizationCase {
  const nodeResults: Record<string, VisualizationNodeResults> = {}
  const elementResults: Record<string, VisualizationElementResults> = {}

  Object.entries(displacementsInput || {}).forEach(([nodeId, value]) => {
    nodeResults[nodeId] = {
      ...(nodeResults[nodeId] || {}),
      ...extractNodeResults(asRecord(value)),
    }
  })

  Object.entries(reactionsInput || {}).forEach(([nodeId, value]) => {
    nodeResults[nodeId] = {
      ...(nodeResults[nodeId] || {}),
      reaction: extractNodeResults(asRecord(value)).reaction,
    }
  })

  Object.entries(forcesInput || {}).forEach(([elementId, value]) => {
    elementResults[elementId] = {
      ...(elementResults[elementId] || {}),
      ...extractElementMetrics(asRecord(value)),
    }
  })

  const envelope = asRecord(envelopeInput)
  if (envelope) {
    Object.entries(nodeResults).forEach(([nodeId, entry]) => {
      const maxAbsDisplacement = asNumber(envelope[`node:${nodeId}:maxAbsDisplacement`])
      const maxAbsReaction = asNumber(envelope[`node:${nodeId}:maxAbsReaction`])
      if (maxAbsDisplacement !== null || maxAbsReaction !== null) {
        entry.envelope = {
          ...(entry.envelope || {}),
          ...(maxAbsDisplacement !== null ? { maxAbsDisplacement } : {}),
          ...(maxAbsReaction !== null ? { maxAbsReaction } : {}),
        }
      }
    })
  }

  return { id, label, kind, nodeResults, elementResults, ...(memberResponses ? { memberResponses } : {}) }
}

export function applyEnvelopeTables(target: VisualizationCase, envelopeTables: Record<string, unknown> | null) {
  if (!envelopeTables) {
    return
  }

  const nodeDisplacement = asRecord(envelopeTables.nodeDisplacement)
  Object.entries(nodeDisplacement || {}).forEach(([nodeId, value]) => {
    const entry = asRecord(value)
    if (!entry) {
      return
    }
    target.nodeResults[nodeId] = {
      ...(target.nodeResults[nodeId] || {}),
      envelope: {
        ...(target.nodeResults[nodeId]?.envelope || {}),
        ...(pickNumber(entry, ['maxAbsDisplacement']) !== null ? { maxAbsDisplacement: pickNumber(entry, ['maxAbsDisplacement']) as number } : {}),
        ...(typeof entry.controlCase === 'string' ? { controlCase: entry.controlCase } : {}),
      },
    }
  })

  const nodeReaction = asRecord(envelopeTables.nodeReaction)
  Object.entries(nodeReaction || {}).forEach(([nodeId, value]) => {
    const entry = asRecord(value)
    if (!entry) {
      return
    }
    target.nodeResults[nodeId] = {
      ...(target.nodeResults[nodeId] || {}),
      envelope: {
        ...(target.nodeResults[nodeId]?.envelope || {}),
        ...(pickNumber(entry, ['maxAbsReaction']) !== null ? { maxAbsReaction: pickNumber(entry, ['maxAbsReaction']) as number } : {}),
        ...(typeof entry.controlCase === 'string' ? { controlCaseReaction: entry.controlCase } : {}),
      },
    }
  })

  const elementForce = asRecord(envelopeTables.elementForce)
  Object.entries(elementForce || {}).forEach(([elementId, value]) => {
    const entry = asRecord(value)
    if (!entry) {
      return
    }
    target.elementResults[elementId] = {
      ...(target.elementResults[elementId] || {}),
      envelope: {
        ...(target.elementResults[elementId]?.envelope || {}),
        ...(pickNumber(entry, ['maxAbsAxialForce']) !== null ? { maxAbsAxialForce: pickNumber(entry, ['maxAbsAxialForce']) as number } : {}),
        ...(pickNumber(entry, ['maxAbsShearForce']) !== null ? { maxAbsShearForce: pickNumber(entry, ['maxAbsShearForce']) as number } : {}),
        ...(pickNumber(entry, ['maxAbsMoment']) !== null ? { maxAbsMoment: pickNumber(entry, ['maxAbsMoment']) as number } : {}),
      },
      controlCases: {
        ...(target.elementResults[elementId]?.controlCases || {}),
        ...(typeof entry.controlCaseAxial === 'string' ? { axial: entry.controlCaseAxial } : {}),
        ...(typeof entry.controlCaseShear === 'string' ? { shear: entry.controlCaseShear } : {}),
        ...(typeof entry.controlCaseMoment === 'string' ? { moment: entry.controlCaseMoment } : {}),
      },
    }
  })
}
