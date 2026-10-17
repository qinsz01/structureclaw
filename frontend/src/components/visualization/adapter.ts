import type { BucklingMode, VisualizationCase, VisualizationLoad, VisualizationPlane, VisualizationSource, VisualizationSnapshot, VisualizationVector3, VisualizationViewMode } from './types'
import { normalizeVisualizationSnapshot } from './normalization'
import { asRecord, asNonEmptyString, asNumber } from './snapshot/values'
import { COORDINATE_TOLERANCE } from './snapshot/vectors'
import { buildCase } from './snapshot/result-cases'
import { getLoads } from './snapshot/loads'
import { deriveCoordinateSemantics, analysisCoordinateContractMatches } from './snapshot/coordinates'
import { validateAnalysisResultReferences } from './snapshot/result-validation'
import { buildAvailableViews, deriveUnits, deriveMemberUtilizationMap, deriveBucklingModes } from './snapshot/metadata'
import { normalizeSnapshotElements, normalizeSnapshotNodes } from './snapshot/geometry'
import { applyUtilizationToCases, buildResultCases, buildSnapshotExtensions } from './snapshot/assembly'

type VisualizationInput = {
  title: string
  model: Record<string, unknown> | null
  analysis?: Record<string, unknown> | null
  mode?: 'model-only' | 'analysis-result'
  statusMessage?: string
  /** memberUtilizationMap from backend VisualizationHints: elementId → ratio (0~1+) */
  memberUtilizationMap?: Record<string, number> | null
  /** bucklingModes from backend VisualizationHints, sorted by λ ascending */
  bucklingModes?: BucklingMode[] | null
}

/** Solver readback may repeat one nodal vector as six named components. Keep
 * source-model validation strict; remove only proven-equivalent redundancy in
 * this display projection, leaving conflicting or partial declarations intact. */
function projectEffectiveLoad(value: unknown): unknown {
  const load = asRecord(value)
  if (!load || !(load.node ?? load.nodeId ?? load.node_id) || !Array.isArray(load.forces) || load.forces.length !== 6) return value
  const forces = load.forces
  const components = ['fx', 'fy', 'fz', 'mx', 'my', 'mz']
  if (!components.every((key, index) => {
    const component = asNumber(load[key]); const vector = asNumber(forces[index])
    return component !== null && vector !== null && component === vector
  })) return value
  const { forces: _redundant, ...projected } = load
  return projected
}

/** Result collections are authoritative; never substitute the selected top-level copy for a missing child. */
function buildRunSnapshot(params: VisualizationInput, run: Record<string, unknown>): VisualizationSnapshot | null {
  const results = asRecord(run.results)
  const keys = Object.keys(results || {})
  const selectedKey = asNonEmptyString(run.selectedResultKey) || keys[0]
  if (!keys.length || !selectedKey || !Object.hasOwn(results!, selectedKey)) return null
  const model = params.model!
  // Each saved result supplies its own curves, forces and extensions. External aggregate hints
  // cannot be attributed safely to every case and are deliberately not copied into the children.
  const geometry = buildVisualizationSnapshot({ title: params.title, model, mode: 'model-only' })
  if (!geometry) return null
  const cases: VisualizationCase[] = []
  const loads: VisualizationLoad[] = []
  const availableViews = new Set<VisualizationViewMode>(['model'])
  for (const key of keys) {
    const result = asRecord(results![key])
    const selection = asRecord(result?.selection)
    const id = asNonEmptyString(selection?.id)
    const kind = selection?.kind
    const selectionMatches = selection?.key === key
      && ((kind === 'case' || kind === 'combination') ? key === `${kind}:${id}` : kind === 'analysis')
    const sameRun = run.runId === undefined || (asRecord(result?.meta)?.runId === run.runId
      && asNonEmptyString(asRecord(run.meta)?.modelHash)
      && asRecord(result?.meta)?.modelHash === asRecord(run.meta)?.modelHash
      && asRecord(result?.meta)?.settingsHash === asRecord(run.meta)?.settingsHash)
    const effectiveLoads = asRecord(result?.data)?.effectiveLoads
    const renderModel = Array.isArray(effectiveLoads) ? { ...model, load_cases: [{ id: key, loads: effectiveLoads.map(projectEffectiveLoad) }] } : model
    const snapshot = result?.success === true && selectionMatches && sameRun
      ? buildVisualizationSnapshot({ title: params.title, model: renderModel, analysis: result, mode: 'analysis-result' }) : null
    const ownCase = snapshot?.cases.find(item => item.id === snapshot.defaultCaseId)
    const current: VisualizationCase = ownCase
      ? { ...ownCase, id: key, label: id || key, kind: 'case', resultStatus: 'available',
        availableViews: snapshot!.availableViews, bucklingModes: snapshot!.bucklingModes || [] }
      : { id: key, label: id || key, kind: 'case', resultStatus: 'unavailable', nodeResults: {}, elementResults: {},
        availableViews: ['model'], bucklingModes: [] }
    cases.push(current)
    current.availableViews!.forEach(view => availableViews.add(view))
    if (!snapshot) continue
    if (Array.isArray(effectiveLoads)) {
      loads.push(...snapshot.loads.map(load => ({ ...load, caseId: key })))
      continue // Solver evidence already contains the selected combination factors and self weight.
    }
    let factors: Record<string, unknown> = {}
    if (kind === 'case' && id) factors = { [id]: 1 }
    if (kind === 'combination') {
      const combination = (Array.isArray(model.load_combinations) ? model.load_combinations : [])
        .map(asRecord).find(item => item?.id === id)
      factors = asRecord(combination?.factors) || {}
    }
    for (const load of snapshot.loads) {
      const factor = load.caseId ? asNumber(factors[load.caseId]) : null
      if (factor === null || factor === 0) continue
      const scale = (vector: VisualizationVector3) => ({ x: vector.x * factor, y: vector.y * factor, z: vector.z * factor })
      loads.push({ ...load, caseId: key, vector: scale(load.vector),
        ...(load.sourceVector ? { sourceVector: scale(load.sourceVector) } : {}),
        ...(load.endVector ? { endVector: scale(load.endVector) } : {}),
        ...(load.sourceEndVector ? { sourceEndVector: scale(load.sourceEndVector) } : {}),
        ...(load.intensity !== undefined ? { intensity: load.intensity * factor } : {}),
        ...(load.components ? { components: load.components.map(component => ({ ...component, value: component.value * factor })) } : {}) })
    }
  }
  const selectedData = cases.find(item => item.id === selectedKey)?.resultStatus === 'available'
    ? asRecord(asRecord(results![selectedKey])?.data) : null
  return normalizeVisualizationSnapshot({ ...geometry, source: 'result', cases, loads,
    defaultCaseId: selectedKey, availableViews: [...availableViews],
    analysisType: asNonEmptyString(run.analysis_type) || undefined,
    summary: asRecord(selectedData?.summary) || undefined, statusMessage: params.statusMessage })
}

export function buildVisualizationSnapshot(params: VisualizationInput): VisualizationSnapshot | null {
  const model = params.model
  if (!model) {
    return null
  }
  if (params.mode !== 'model-only' && asRecord(params.analysis?.results)) {
    return buildRunSnapshot(params, params.analysis!)
  }

  const source: VisualizationSource = params.mode === 'model-only' || !params.analysis ? 'model' : 'result'
  const analysis = asRecord(params.analysis)
  const data = asRecord(analysis?.data) || analysis
  const units = deriveUnits(model, analysis)
  const nodesInput = Array.isArray(model.nodes) ? model.nodes : []
  const elementsInput = Array.isArray(model.elements) ? model.elements : []
  const debugEnabled = process.env.NODE_ENV !== 'production'
  if (!nodesInput.length || !elementsInput.length) {
    if (debugEnabled) {
      console.warn('[Visualization] Snapshot skipped: model is missing nodes or elements array data.', {
        source,
        nodesInputCount: nodesInput.length,
        elementsInputCount: elementsInput.length,
      })
    }
    return null
  }

  const { nodes, invalidNodeRecord } = normalizeSnapshotNodes(nodesInput)

  if (invalidNodeRecord) {
    if (debugEnabled) {
      console.warn('[Visualization] Snapshot skipped: nodes require unique ids, finite X/Y/Z coordinates, and exactly six boolean restraints when present.')
    }
    return null
  }

  let semantics: ReturnType<typeof deriveCoordinateSemantics>
  try {
    semantics = deriveCoordinateSemantics(model)
  } catch (error) {
    if (debugEnabled) {
      console.warn('[Visualization] Snapshot skipped because its coordinate contract is invalid.', error)
    }
    return null
  }
  if (!semantics) {
    if (debugEnabled) {
      console.warn('[Visualization] Snapshot skipped: structural model has no explicit canonical coordinate contract.')
    }
    return null
  }
  const dimension = semantics.dimension
  const plane = semantics.plane as VisualizationPlane
  if (dimension === 2 && nodes.some((node) => Math.abs(node.position.y) > COORDINATE_TOLERANCE)) {
    if (debugEnabled) {
      console.warn('[Visualization] Snapshot skipped: canonical 2-D nodes must lie in the global X-Z plane.')
    }
    return null
  }
  if (source === 'result' && !analysisCoordinateContractMatches(analysis, data, dimension)) {
    if (debugEnabled) {
      console.warn('[Visualization] Snapshot skipped because analysis result axes do not match the model coordinate contract.')
    }
    return null
  }

  const { elements, elementIds, invalidElementCoordinates } = normalizeSnapshotElements(model, nodes, elementsInput, dimension)

  const nodeIdSet = new Set(nodes.map((node) => node.id))
  const elementsWithInvalidNodeRefs = elements.filter(
    (element) => element.nodeIds.some((nodeId) => !nodeIdSet.has(nodeId))
  ).length

  if (debugEnabled) {
    console.info('[Visualization] Snapshot normalization summary:', {
      source,
      nodesInputCount: nodesInput.length,
      nodesNormalizedCount: nodes.length,
      elementsInputCount: elementsInput.length,
      elementsNormalizedCount: elements.length,
      elementsWithInvalidNodeRefs,
    })
  }

  if (!nodes.length || !elements.length || invalidElementCoordinates || elementsWithInvalidNodeRefs > 0) {
    if (debugEnabled) {
      console.warn('[Visualization] Snapshot skipped after normalization because its element geometry or local axes are invalid.', {
        source,
        nodesNormalizedCount: nodes.length,
        elementsNormalizedCount: elements.length,
        invalidElementCoordinates,
        elementsWithInvalidNodeRefs,
      })
    }
    return null
  }

  if (source === 'result') {
    try {
      validateAnalysisResultReferences(data, nodeIdSet, new Map(elements.map((element) => [element.id, element])), dimension)
    } catch (error) {
      if (debugEnabled) {
        console.warn('[Visualization] Snapshot skipped because analysis results do not map exactly to model ids.', error)
      }
      return null
    }
  }

  const baseDisplacements = asRecord(data?.displacements)
  let loads: VisualizationLoad[]
  try {
    loads = getLoads(model, nodes, elements, dimension, source === 'model')
  } catch (error) {
    if (debugEnabled) {
      console.warn('[Visualization] Snapshot skipped because a load reference frame cannot be rendered safely.', error)
    }
    return null
  }
  const cases: VisualizationCase[] = source === 'result'
    ? buildResultCases(data, elements, dimension, baseDisplacements)
    : [buildCase('model', 'Model', 'case', null, null, null, null)]

  const unsupportedElementTypes = Array.from(
    new Set(elements.map((element) => element.type).filter((type) => !['beam', 'truss', 'column', 'brace', 'link'].includes(type)))
  )
  let utilizationMap: Record<string, number> | null
  let bucklingModes: BucklingMode[] | null
  try {
    utilizationMap = deriveMemberUtilizationMap(data, elementIds, params.memberUtilizationMap)
    bucklingModes = deriveBucklingModes(data, nodeIdSet, dimension, params.bucklingModes)
  } catch (error) {
    if (debugEnabled) {
      console.warn('[Visualization] Snapshot skipped because an extension result uses invalid model coordinates or ids.', error)
    }
    return null
  }

  applyUtilizationToCases(cases, utilizationMap)

  // Build availableViews — include 'utilization' when any element has the field
  const hasUtilization = cases.some((item) =>
    Object.values(item.elementResults).some((result) => typeof result.utilization === 'number')
  )
  const hasBuckling = Array.isArray(bucklingModes) && bucklingModes.length > 0
  const extensions = buildSnapshotExtensions(hasUtilization, utilizationMap, hasBuckling, bucklingModes)

  return normalizeVisualizationSnapshot({
    version: 1,
    title: params.title,
    source,
    dimension,
    plane,
    coordinateSemantics: semantics?.semantics,
    coordinateContractVersion: semantics?.version,
    analysisType: typeof analysis?.analysis_type === 'string' ? analysis.analysis_type : undefined,
    availableViews: buildAvailableViews(cases, source, hasUtilization, hasBuckling),
    defaultCaseId: cases.find((item) => item.kind === 'result')?.id || cases[0]?.id || (source === 'model' ? 'model' : 'result'),
    unitSystem: units.unitSystem,
    lengthUnit: units.lengthUnit,
    displacementUnit: units.displacementUnit,
    displacementDisplayFactor: units.displacementDisplayFactor,
    nodeLabelUnit: units.lengthUnit,
    resultUnit: units.forceUnit,
    momentUnit: units.momentUnit,
    nodalLoadUnit: units.nodalLoadUnit,
    distributedLoadUnit: units.distributedLoadUnit,
    floorLoadUnit: `${units.forceUnit}/${units.lengthUnit}^2`,
    nodes,
    elements,
    loads,
    unsupportedElementTypes,
    cases,
    summary: asRecord(data?.summary) || undefined,
    statusMessage: params.statusMessage,
    extensions: Object.keys(extensions).length > 0 ? extensions : undefined,
    bucklingModes: hasBuckling ? bucklingModes || undefined : undefined,
  })
}
