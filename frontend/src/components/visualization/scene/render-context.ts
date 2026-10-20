import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { StructuralSceneProps } from './types'
import type { SceneGeometry } from './use-scene-geometry'

/** Everything a per-element / per-node scene renderer reads from SceneContent. */
export type SceneRenderContext = Pick<StructuralSceneProps,
  | 'diagramScale' | 'locale' | 't' | 'snapshot' | 'plane' | 'view' | 'activeCase' | 'deformationScale' | 'forceMetric'
  | 'selectedElementId' | 'selectedPositionM' | 'selectedLoadIndex' | 'selectedNodeId'
  | 'showElementLabels' | 'showLoads' | 'showNodeLabels' | 'showUndeformed'
  | 'onSelectElement' | 'onSelectLoad' | 'onSelectNode'
> & Pick<SceneGeometry, 'nodeMap' | 'loadArrowLength' | 'activeBucklingMode' | 'bucklingScale'> & {
  maxElementMetric: number
  rawMaxElementMetric: number
  maxReaction: number
  maxReactionMoment: number
  maxDisplacement: number
  bucklingAmplitudeRef: MutableRefObject<number>
  hoveredNodeId: string | null
  setHoveredNodeId: Dispatch<SetStateAction<string | null>>
  hoveredElementId: string | null
  setHoveredElementId: Dispatch<SetStateAction<string | null>>
}
