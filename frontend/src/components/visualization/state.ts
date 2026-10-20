import type { VisualizationCase, VisualizationSnapshot, VisualizationViewMode } from './types'
import { FORCE_COMPONENTS, isLoadVisible, type ForceMetric } from './structural-scene-utils'

export type CameraPreset = 'front' | 'side' | 'top' | 'iso'
export type VizState = {
  figureKey: string
  view: VisualizationViewMode
  component: ForceMetric
  deformScale: number
  diagramScale: number
  showOriginal: boolean
  showLoads: boolean
  showNodeLabels: boolean
  showElementLabels: boolean
  showLegend: boolean
  selection: { kind: 'node' | 'member' | 'load'; id: string } | null
  mode: number
  camera: CameraPreset
  resetToken: number
}

export function createVizState(figureKey = '', initial: Partial<VizState> = {}): VizState {
  return { figureKey, view: 'model', component: 'M2', deformScale: 12, diagramScale: 1,
    showOriginal: true, showLoads: true, showNodeLabels: false, showElementLabels: false,
    showLegend: true, selection: null, mode: 0, camera: 'iso', resetToken: 0, ...initial }
}

export function vizReducer(state: VizState, action: { type: 'open'; key: string; initial: Partial<VizState> } | { type: 'patch'; patch: Partial<VizState> }): VizState {
  if (action.type === 'open') return action.key === state.figureKey ? state : createVizState(action.key, action.initial)
  return { ...state, ...action.patch }
}

export function viewControls(view: VisualizationViewMode, hasLoads: boolean) {
  return {
    loads: view === 'model' && hasLoads,
    labels: ['model', 'deformed', 'forces', 'reactions'].includes(view),
    deformation: view === 'deformed',
    diagram: view === 'forces',
    legend: view !== 'model',
  }
}

export function availableMetrics(snapshot: VisualizationSnapshot, activeCase: VisualizationCase): ForceMetric[] {
  const components = snapshot.dimension === 2 ? ['N', 'V3', 'M2'] as const : FORCE_COMPONENTS
  const samples = Object.values(activeCase.memberResponses ?? {}).flatMap(row => row.samples)
  const available = components.filter(key => samples.some(sample => typeof sample[key] === 'number'))
  return available.length ? [...available] : ['axial', 'shear', 'moment']
}

export function hasCaseLoads(snapshot: VisualizationSnapshot, activeCase: VisualizationCase) {
  return snapshot.loads.some(load => isLoadVisible(snapshot, activeCase, load))
}
