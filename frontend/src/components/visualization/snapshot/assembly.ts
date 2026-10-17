import type { BucklingMode, VisualizationCase, VisualizationElement, VisualizationExtensionMap } from '../types'
import { normalizeMemberResponses } from '../normalization'
import { asRecord } from './values'
import { applyEnvelopeTables, buildCase } from './result-cases'

/** Builds the base result case, per-load-case results and the optional envelope case. */
export function buildResultCases(
  data: Record<string, unknown> | null,
  elements: VisualizationElement[],
  dimension: 2 | 3,
  baseDisplacements: Record<string, unknown> | null,
): VisualizationCase[] {
  const baseReactions = asRecord(data?.reactions)
  const baseForces = asRecord(data?.forces)
  const baseEnvelope = asRecord(data?.envelope)
  const responseElements = new Map(elements.map((element) => [element.id, element]))
  const baseCase = buildCase('result', 'Result', 'result', baseDisplacements, baseReactions, baseForces, baseEnvelope,
    normalizeMemberResponses(data?.memberResponses, responseElements, dimension))
  const nextCases: VisualizationCase[] = [baseCase]

  const caseResults = asRecord(data?.caseResults)
  Object.entries(caseResults || {}).forEach(([caseId, value]) => {
    const entry = asRecord(value)
    if (!entry) {
      return
    }
    nextCases.push(
      buildCase(
        caseId,
        caseId,
        'case',
        asRecord(entry.displacements),
        asRecord(entry.reactions),
        asRecord(entry.forces),
        asRecord(entry.envelope),
        normalizeMemberResponses(entry.memberResponses, responseElements, dimension)
      )
    )
  })

  const envelopeTables = asRecord(data?.envelopeTables)
  if (envelopeTables) {
    const envelopeCase = buildCase('envelope', 'Envelope', 'envelope', null, null, null, null)
    applyEnvelopeTables(envelopeCase, envelopeTables)
    nextCases.push(envelopeCase)
  }

  return nextCases
}

/** Injects steel member utilization ratios into all cases' elementResults. */
export function applyUtilizationToCases(cases: VisualizationCase[], utilizationMap: Record<string, number> | null) {
  if (utilizationMap && Object.keys(utilizationMap).length > 0) {
    cases.forEach((vizCase) => {
      Object.entries(utilizationMap).forEach(([elementId, ratio]) => {
        if (typeof ratio === 'number' && Number.isFinite(ratio)) {
          vizCase.elementResults[elementId] = {
            ...(vizCase.elementResults[elementId] || {}),
            utilization: ratio,
          }
        }
      })
    })
  }
}

/** Builtin utilization / buckling extensions exposed to the viewer. */
export function buildSnapshotExtensions(
  hasUtilization: boolean,
  utilizationMap: Record<string, number> | null,
  hasBuckling: boolean,
  bucklingModes: BucklingMode[] | null,
) {
  const extensions: VisualizationExtensionMap = {
    ...(hasUtilization && utilizationMap
      ? {
          'builtin.utilization': {
            id: 'builtin.utilization',
            available: true,
            data: {
              memberUtilizationMap: utilizationMap,
            },
          },
        }
      : {}),
    ...(hasBuckling && bucklingModes
      ? {
          'builtin.buckling': {
            id: 'builtin.buckling',
            available: true,
            data: {
              bucklingModes,
            },
          },
        }
      : {}),
  }
  return extensions
}
