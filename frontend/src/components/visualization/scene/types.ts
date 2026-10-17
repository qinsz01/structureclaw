import React from 'react'
import type { MessageKey } from '@/lib/i18n'
import type { VisualizationCase, VisualizationPlane, VisualizationSnapshot, VisualizationViewMode } from '../types'
import type { ForceMetric } from '../structural-scene-utils'

export type SceneExportHandle = {
  /** Capture current frame and trigger PNG download. scale = pixel density multiplier (1 | 2 | 4). onDone is called after the download link is triggered. */
  exportPng: (filename?: string, scale?: 1 | 2 | 4, onDone?: () => void) => void
}

export type StructuralSceneProps = {
  snapshot: VisualizationSnapshot
  plane: VisualizationPlane
  activeCase: VisualizationCase
  deformationScale: number
  forceMetric: ForceMetric
  resetToken: number
  selectedElementId: string | null
  selectedLoadIndex?: number | null
  selectedNodeId: string | null
  showElementLabels: boolean
  showLegend: boolean
  showLoads: boolean
  showNodeLabels: boolean
  showUndeformed: boolean
  view: VisualizationViewMode
  onSelectElement: (id: string | null) => void
  onSelectLoad: (index: number | null) => void
  onSelectNode: (id: string | null) => void
  onClearSelection: () => void
  /** Optional ref to expose exportPng() to parent. */
  exportRef?: React.MutableRefObject<SceneExportHandle | null>
  /** Active buckling mode index (0-based) when view === 'buckling'. */
  bucklingModeIndex?: number
  t: (key: MessageKey) => string
}
