type VisualizationBaseViewMode = 'model' | 'deformed' | 'forces' | 'reactions'
type VisualizationExtensionViewMode = 'utilization' | 'buckling' | `extension:${string}`
export type VisualizationViewMode = VisualizationBaseViewMode | VisualizationExtensionViewMode

export type VisualizationExtensionId = 'builtin.utilization' | 'builtin.buckling' | `builtin.${string}` | `skillhub.${string}`

export type BucklingMode = {
  /** Buckling load factor (λ) */
  lambda: number
  /** Node id → [dx, dy, dz] normalized mode shape displacement */
  modeShape: Record<string, [number, number, number]>
}
export type VisualizationExtensionEntry<TData = unknown> = {
  id: VisualizationExtensionId
  available: boolean
  sourceSkillId?: string
  data: TData
}

export type VisualizationExtensionMap = Partial<Record<VisualizationExtensionId, VisualizationExtensionEntry>>

export type VisualizationSource = 'model' | 'result'
export type VisualizationPlane = 'xy' | 'xz' | 'yz'

export type VisualizationVector3 = {
  x: number
  y: number
  z: number
}

export type VisualizationLocalAxes = {
  x: VisualizationVector3
  y: VisualizationVector3
  z: VisualizationVector3
}

export type VisualizationFloorLoadComponent = {
  type: string
  value: number
}

export type VisualizationNodeResults = {
  displacement?: Partial<Record<'ux' | 'uy' | 'uz' | 'rx' | 'ry' | 'rz', number>>
  reaction?: Partial<Record<'fx' | 'fy' | 'fz' | 'mx' | 'my' | 'mz', number>>
  envelope?: Partial<Record<'maxAbsDisplacement' | 'maxAbsReaction' | 'controlCase' | 'controlCaseReaction', number | string>>
}

export type VisualizationElementResults = {
  axial?: number
  shear?: number
  moment?: number
  torsion?: number
  endForces?: Record<string, number>
  envelope?: Partial<Record<'maxAbsAxialForce' | 'maxAbsShearForce' | 'maxAbsMoment', number | string>>
  controlCases?: Partial<Record<'axial' | 'shear' | 'moment', string>>
  /** Steel member utilization ratio (0 = 0%, 1.0 = 100%, >1 = overstressed). */
  utilization?: number
}

export type VisualizationNode = {
  id: string
  position: VisualizationVector3
  restraints?: boolean[]
}

export type VisualizationElement = {
  id: string
  type: string
  nodeIds: string[]
  material?: string
  section?: string
  localAxes?: VisualizationLocalAxes
}

export type VisualizationLoad = {
  nodeId?: string
  vector: VisualizationVector3
  caseId?: string
  elementId?: string
  kind?: 'nodal' | 'point' | 'moment' | 'distributed' | 'area'
  /** Physical distance from the member i end; metres for canonical SI models. */
  position?: number
  start?: number
  end?: number
  /** Linear distribution at the end of this load interval; vector is its start. */
  endVector?: VisualizationVector3
  sourceEndVector?: VisualizationVector3
  storyId?: string
  label?: string
  intensity?: number
  area?: number
  polygon?: VisualizationVector3[]
  components?: VisualizationFloorLoadComponent[]
  /** Reference frame of the source model load; vector is always global for rendering. */
  referenceFrame?: 'global' | 'element-local'
  sourceVector?: VisualizationVector3
}

export type VisualizationCase = {
  id: string
  label: string
  kind: 'result' | 'case' | 'envelope'
  nodeResults: Record<string, VisualizationNodeResults>
  elementResults: Record<string, VisualizationElementResults>
  /** Precomputed physical-member samples in model length units; never recovered in the UI. */
  memberResponses?: Record<string, VisualizationMemberResponse>
  /** Present for independently saved run results; an unavailable case has no fallback data. */
  resultStatus?: 'available' | 'unavailable'
  availableViews?: VisualizationViewMode[]
  bucklingModes?: BucklingMode[]
}

export type VisualizationMemberResponse = {
  id: string
  length: number
  state: 'recovered' | 'interpolated' | 'truss' | 'unavailable' | 'native-stations'
  reason: string
  samples: {
    x: number
    position: [number, number, number]
    /** Absent for native force-only stations; never filled with a zero vector. */
    displacement?: [number, number, number]
    N?: number
    V2?: number
    V3?: number
    T?: number
    M2?: number
    M3?: number
    provenance?: 'solver-direct' | 'linear-combination'
    source?: unknown
    segmentId?: string
    side?: 'left' | 'right'
  }[]
}

export type VisualizationSnapshot = {
  version: 1
  title: string
  source: VisualizationSource
  dimension: 2 | 3
  plane: VisualizationPlane
  coordinateSemantics?: string
  coordinateContractVersion?: number
  analysisType?: string
  availableViews: VisualizationViewMode[]
  defaultCaseId: string
  unitSystem?: string
  lengthUnit?: string
  displacementUnit?: string
  displacementDisplayFactor?: number
  nodeLabelUnit?: string
  resultUnit?: string
  momentUnit?: string
  nodalLoadUnit?: string
  distributedLoadUnit?: string
  floorLoadUnit?: string
  nodes: VisualizationNode[]
  elements: VisualizationElement[]
  loads: VisualizationLoad[]
  unsupportedElementTypes: string[]
  cases: VisualizationCase[]
  summary?: Record<string, unknown>
  statusMessage?: string
  extensions?: VisualizationExtensionMap
  /** Buckling modes from linear buckling analysis, sorted by λ ascending. */
  bucklingModes?: BucklingMode[]
}
