import { useScenePalette } from './palette'
import React, { useState } from 'react'
import { Bounds, OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import { isLoadVisible } from '../structural-scene-utils'
import type { StructuralSceneProps } from './types'
import { AreaLoadMarker } from './load-markers'
import { PlaneBoundsController, FocusController } from './controllers'
import { useSceneGeometry } from './use-scene-geometry'
import type { SceneRenderContext } from './render-context'
import { SceneElement } from './scene-element'
import { SceneNode } from './scene-node'

export function SceneContent({
  activeCase,
  deformationScale,
  diagramScale,
  cameraPreset,
  preserveCameraOnResize,
  focusOnSelection = true,
  locale,
  t,
  forceMetric,
  resetToken,
  selectedElementId,
  selectedPositionM,
  selectedLoadIndex,
  selectedNodeId,
  showElementLabels,
  showLoads,
  showNodeLabels,
  showUndeformed,
  plane,
  snapshot,
  view,
  onSelectElement,
  onSelectLoad,
  onSelectNode,
  onClearSelection,
  maxElementMetric,
  rawMaxElementMetric,
  maxReaction,
  maxReactionMoment,
  maxDisplacement,
  bucklingModeIndex,
  bucklingAmplitudeRef,
}: StructuralSceneProps & {
  maxElementMetric: number
  rawMaxElementMetric: number
  maxReaction: number
  maxReactionMoment: number
  maxDisplacement: number
  bucklingAmplitudeRef: React.MutableRefObject<number>
}) {
  const palette = useScenePalette()
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [hoveredElementId, setHoveredElementId] = useState<string | null>(null)
  const { gridConfig, cameraFrame, activeBucklingMode, bucklingScale, nodeMap, loadArrowLength, selectedFocusPoint } = useSceneGeometry({
    snapshot,
    cameraPreset,
    plane,
    view,
    activeCase,
    deformationScale,
    bucklingModeIndex,
    selectedElementId,
    selectedNodeId,
    selectedLoadIndex,
  })
  const ctx: SceneRenderContext = {
    diagramScale, locale, t,
    snapshot,
    plane,
    view,
    activeCase,
    deformationScale,
    forceMetric,
    selectedElementId,
    selectedPositionM,
    selectedLoadIndex,
    selectedNodeId,
    showElementLabels,
    showLoads,
    showNodeLabels,
    showUndeformed,
    onSelectElement,
    onSelectLoad,
    onSelectNode,
    maxElementMetric,
    rawMaxElementMetric,
    maxReaction,
    maxReactionMoment,
    maxDisplacement,
    bucklingAmplitudeRef,
    hoveredNodeId,
    setHoveredNodeId,
    hoveredElementId,
    setHoveredElementId,
    nodeMap,
    loadArrowLength,
    activeBucklingMode,
    bucklingScale,
  }

  return (
    <>
      {snapshot.dimension === 3 ? (
        <PerspectiveCamera
          key="perspective"
          makeDefault
          fov={42}
          position={cameraFrame.position}
          up={cameraFrame.up}
        />
      ) : (
        <OrthographicCamera
          key="ortho"
          makeDefault
          position={cameraFrame.position}
          zoom={48}
          up={cameraFrame.up}
        />
      )}
      <ambientLight intensity={0.9} />
      <directionalLight intensity={1.2} position={[10, 12, 8]} />
      <directionalLight intensity={0.45} position={[-8, -4, 10]} />
      <OrbitControls enableRotate={snapshot.dimension === 3} makeDefault target={cameraFrame.target} zoomToCursor />
      {focusOnSelection && <FocusController focusTarget={selectedFocusPoint} focusKey={`${selectedNodeId}:${selectedElementId}:${selectedLoadIndex}`} />}
      <gridHelper args={[gridConfig.size, gridConfig.divisions, palette.gridAxis, palette.grid]} position={gridConfig.position} rotation={gridConfig.rotation} />

      <Bounds margin={1.3} maxDuration={0.2}>
        <group onDoubleClick={() => {
          onClearSelection()
        }}>
          {showLoads && view === 'model' && snapshot.loads.map((load, index) => {
            if (load.kind !== 'area' || !load.polygon?.length || !isLoadVisible(snapshot, activeCase, load)) {
              return null
            }
            return (
              <AreaLoadMarker
                color={selectedLoadIndex === index ? palette.selected : palette.area}
                dimension={snapshot.dimension}
                key={`area-load-${load.storyId || index}-${index}`}
                arrowLength={loadArrowLength}
                load={load}
                onClick={() => {
                  onSelectLoad(index)
                  onSelectElement(null)
                  onSelectNode(null)
                }}
                plane={plane}
                selected={selectedLoadIndex === index}
              />
            )
          })}
          {snapshot.elements.map((element) => <SceneElement key={element.id} element={element} ctx={ctx} />)}

          {snapshot.nodes.map((entry) => <SceneNode key={entry.id} entry={entry} ctx={ctx} />)}
        </group>
        <PlaneBoundsController plane={plane} resetToken={resetToken} snapshot={snapshot} cameraPreset={cameraPreset} preserveCameraOnResize={preserveCameraOnResize} fitKey={`${view}:${activeCase.id}`} />
      </Bounds>
    </>
  )
}
