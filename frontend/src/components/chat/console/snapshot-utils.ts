import { buildVisualizationSnapshot } from '@/components/visualization/adapter'
import { isCanonicalVisualizationSnapshot } from '@/components/visualization/normalization'
import type { VisualizationSnapshot } from '@/components/visualization/types'
import type { AgentResult, PersistedConversation } from './types'
import { normalizePersistedMessage } from './persisted-messages'
import { normalizeAgentResultPayload, extractAnalysis, extractVisualizationHints, buildVisualizationTitle, asRecord } from './result-utils'

export function toModelText(model?: Record<string, unknown> | null) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return ''
  }
  return JSON.stringify(model, null, 2)
}

export function toModelFromVisualizationSnapshot(snapshot?: VisualizationSnapshot | null): Record<string, unknown> | null {
  if (!snapshot || isStaleVisualizationSnapshot(snapshot)) {
    return null
  }
  // Area-load polygons cannot be losslessly reconstructed from the compact
  // projection snapshot. Prefer no fallback model to a structurally different one.
  if (snapshot.loads.some((load) => load.kind === 'area')) {
    return null
  }

  const dimension = snapshot.dimension === 3 ? '3d' : '2d'
  const elementReferenceVectors = dimension === '3d'
    ? Object.fromEntries(snapshot.elements.flatMap((element) => (
        element.localAxes
          ? [[element.id, [element.localAxes.z.x, element.localAxes.z.y, element.localAxes.z.z]]]
          : []
      )))
    : {}
  const model: Record<string, unknown> = {
    schema_version: '2.0.0',
    coordinate_system: {
      semantics: CANONICAL_COORDINATE_SEMANTICS,
      version: 1,
      dimension,
      plane: dimension === '2d' ? 'xz' : null,
      dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'],
    },
    metadata: {
      coordinateSemantics: CANONICAL_COORDINATE_SEMANTICS,
      coordinateContractVersion: 1,
      frameDimension: dimension,
      source: 'visualization-projection',
      ...(Object.keys(elementReferenceVectors).length > 0 ? { elementReferenceVectors } : {}),
    },
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      z: node.position.z,
      ...(Array.isArray(node.restraints) ? { restraints: node.restraints } : {}),
    })),
    elements: snapshot.elements.map((element) => ({
      id: element.id,
      type: element.type,
      nodes: element.nodeIds,
      ...(typeof element.material === 'string' ? { material: element.material } : {}),
      ...(typeof element.section === 'string' ? { section: element.section } : {}),
    })),
  }

  if (Array.isArray(snapshot.loads) && snapshot.loads.length > 0) {
    const grouped = new Map<string, Array<Record<string, unknown>>>()
    snapshot.loads.forEach((load) => {
      const key = load.caseId || 'default'
      const bucket = grouped.get(key) || []
      if (load.kind === 'distributed' && load.elementId) {
        bucket.push({
          element: load.elementId,
          wx: load.vector.x,
          wy: load.vector.y,
          wz: load.vector.z,
          reference_frame: 'global',
        })
      } else if (load.kind === 'moment' && load.nodeId) {
        bucket.push({
          node: load.nodeId,
          mx: load.vector.x,
          my: load.vector.y,
          mz: load.vector.z,
          reference_frame: 'global',
        })
      } else if (load.nodeId) {
        bucket.push({
          node: load.nodeId,
          fx: load.vector.x,
          fy: load.vector.y,
          fz: load.vector.z,
          reference_frame: 'global',
        })
      }
      grouped.set(key, bucket)
    })

    const loadCases = Array.from(grouped.entries())
      .filter(([, loads]) => loads.length > 0)
      .map(([id, loads]) => ({ id, loads }))

    if (loadCases.length > 0) {
      model.load_cases = loadCases
    }
  }

  return model
}

export function toModelTextFromSnapshot(snapshot?: VisualizationSnapshot | null) {
  return toModelText(toModelFromVisualizationSnapshot(snapshot))
}

export const CANONICAL_COORDINATE_SEMANTICS = 'global-z-up'

export function isStaleVisualizationSnapshot(snapshot?: VisualizationSnapshot | null) {
  if (!snapshot) return false
  // Only flag as stale if the snapshot actually contains structural model data
  // (non-trivial nodes and elements). Snapshots without structural data (e.g. empty
  // or chat-only conversations) must not trigger the stale-data wipe.
  if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0) return false
  if (!Array.isArray(snapshot.elements) || snapshot.elements.length === 0) return false
  return !isCanonicalVisualizationSnapshot(snapshot)
}

export function isStaleStructuralResult(result: AgentResult | null | undefined) {
  const normalized = normalizeAgentResultPayload(result ?? null)
  const model = asRecord(normalized?.model)
  if (!model) {
    return false
  }
  if (
    !Array.isArray(model.nodes)
    || !Array.isArray(model.elements)
    || model.nodes.length === 0
    || model.elements.length === 0
  ) {
    return false
  }
  const modelSnapshot = buildVisualizationSnapshot({
    title: 'Stored structural model validation',
    model,
    mode: 'model-only',
  })
  if (!modelSnapshot || !isCanonicalVisualizationSnapshot(modelSnapshot)) {
    return true
  }

  const analysis = asRecord(extractAnalysis(normalized))
  const data = asRecord(analysis?.data) || analysis
  const resultMeta = asRecord(data?.meta) || asRecord(analysis?.meta)
  const hasCoordinateSensitiveResults = Boolean(data && [
    'displacements', 'reactions', 'forces', 'caseResults', 'envelopeTables', 'buckling',
  ].some((key) => data[key] !== undefined)) || resultMeta?.coordinateSemantics !== undefined
  if (!analysis || !hasCoordinateSensitiveResults) return false

  const resultSnapshot = buildVisualizationSnapshot({
    title: 'Stored structural result validation',
    model,
    analysis,
    mode: 'analysis-result',
  })
  return !resultSnapshot || !isCanonicalVisualizationSnapshot(resultSnapshot)
}

export function sanitizePersistedConversation(archived: PersistedConversation): PersistedConversation {
  const normalizedMessages = Array.isArray(archived.messages)
    ? archived.messages.map((message) => normalizePersistedMessage(message))
    : []
  const normalizedLatestResult = normalizeAgentResultPayload(archived.latestResult || null)
  const preferredStoredResultSnapshot = pickPreferredResultSnapshot(
    archived.resultVisualizationSnapshot,
    archived.visualizationSnapshot,
  )
  const synthesizedResultSnapshot = buildResultSnapshotFromResult(
    normalizedLatestResult,
    archived.title || 'Conversation',
    toModelFromVisualizationSnapshot(archived.modelVisualizationSnapshot || preferredStoredResultSnapshot),
  )
  const repairedResultSnapshot = pickPreferredResultSnapshot(preferredStoredResultSnapshot, synthesizedResultSnapshot)
  const staleStructuralData =
    isStaleVisualizationSnapshot(archived.modelVisualizationSnapshot)
    || isStaleVisualizationSnapshot(repairedResultSnapshot)
    || isStaleStructuralResult(normalizedLatestResult)

  if (staleStructuralData) {
    return {
      ...archived,
      messages: normalizedMessages,
      modelText: '',
      modelSyncMessage: '',
      activePanel: archived.activePanel === 'report' ? 'analysis' : archived.activePanel,
      latestResult: null,
      modelVisualizationSnapshot: null,
      resultVisualizationSnapshot: null,
      visualizationSnapshot: null,
      staleStructuralData: true,
    }
  }

  return {
    ...archived,
    messages: normalizedMessages,
    latestResult: normalizedLatestResult,
    resultVisualizationSnapshot: repairedResultSnapshot,
    visualizationSnapshot: repairedResultSnapshot || archived.visualizationSnapshot || null,
    staleStructuralData: false,
  }
}

export function snapshotHasResultData(snapshot?: VisualizationSnapshot | null) {
  if (!snapshot || !Array.isArray(snapshot.cases)) {
    return false
  }

  return snapshot.cases.some((item) => {
    const nodeResults = item && typeof item === 'object' && item.nodeResults && typeof item.nodeResults === 'object'
      ? Object.values(item.nodeResults)
      : []
    const elementResults = item && typeof item === 'object' && item.elementResults && typeof item.elementResults === 'object'
      ? Object.values(item.elementResults)
      : []

    const hasNodeResult = nodeResults.some((entry) => {
      const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
      const displacement = record?.displacement && typeof record.displacement === 'object'
        ? (record.displacement as Record<string, unknown>)
        : null
      const reaction = record?.reaction && typeof record.reaction === 'object'
        ? (record.reaction as Record<string, unknown>)
        : null
      const envelope = record?.envelope && typeof record.envelope === 'object'
        ? (record.envelope as Record<string, unknown>)
        : null
      return Boolean(displacement || reaction || envelope)
    })

    const hasElementResult = elementResults.some((entry) => {
      const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
      return Boolean(
        record
        && (
          typeof record.axial === 'number'
          || typeof record.shear === 'number'
          || typeof record.moment === 'number'
          || typeof record.torsion === 'number'
          || (record.envelope && typeof record.envelope === 'object')
        )
      )
    })

    return hasNodeResult || hasElementResult
  })
}

export function isResultVisualizationSnapshot(snapshot?: VisualizationSnapshot | null) {
  if (!snapshot) {
    return false
  }
  const hasResultViews = snapshot.availableViews.some((view) => view === 'deformed' || view === 'forces' || view === 'reactions')
  const hasResultData = snapshotHasResultData(snapshot)
  if (snapshot.source === 'result') {
    return true
  }
  // Legacy archives may carry model snapshots with unexpected case kinds.
  // For model-source snapshots, rely on actual result views/data only.
  if (snapshot.source === 'model') {
    return hasResultViews || hasResultData
  }
  return hasResultViews
    || snapshot.cases.some((item) => item.kind === 'result' || item.kind === 'envelope')
    || hasResultData
}

export function pickPreferredResultSnapshot(
  primary?: VisualizationSnapshot | null,
  secondary?: VisualizationSnapshot | null
): VisualizationSnapshot | null {
  const primaryIsResult = isResultVisualizationSnapshot(primary)
  const secondaryIsResult = isResultVisualizationSnapshot(secondary)

  if (primaryIsResult && secondaryIsResult) {
    return primary ?? null
  }
  if (primaryIsResult) {
    return primary ?? null
  }
  if (secondaryIsResult) {
    return secondary ?? null
  }
  return primary ?? secondary ?? null
}

export function buildResultSnapshotFromResult(
  result: AgentResult | null | undefined,
  title: string,
  fallbackModel?: Record<string, unknown> | null
): VisualizationSnapshot | null {
  const normalizedResult = normalizeAgentResultPayload(result ?? null)
  if (!normalizedResult) {
    return null
  }

  const modelFromResult =
    normalizedResult.model && typeof normalizedResult.model === 'object' && !Array.isArray(normalizedResult.model)
      ? normalizedResult.model
      : null
  const visualizationHints = extractVisualizationHints(normalizedResult)

  return buildVisualizationSnapshot({
    title: buildVisualizationTitle(normalizedResult, title),
    model: modelFromResult ?? fallbackModel ?? null,
    analysis: extractAnalysis(normalizedResult),
    mode: 'analysis-result',
    memberUtilizationMap: visualizationHints?.memberUtilizationMap,
    bucklingModes: visualizationHints?.bucklingModes,
  })
}
