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
  forceMetric,
  resetToken,
  selectedElementId,
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
  maxUtilization,
  bucklingModeIndex,
  bucklingAmplitudeRef,
}: StructuralSceneProps & {
  maxElementMetric: number
  rawMaxElementMetric: number
  maxReaction: number
  maxReactionMoment: number
  maxDisplacement: number
  maxUtilization: number
  bucklingAmplitudeRef: React.MutableRefObject<number>
}) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [hoveredElementId, setHoveredElementId] = useState<string | null>(null)
  const { gridConfig, cameraFrame, activeBucklingMode, bucklingScale, nodeMap, loadArrowLength, selectedFocusPoint } = useSceneGeometry({
    snapshot,
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
    snapshot,
    plane,
    view,
    activeCase,
    deformationScale,
    forceMetric,
    selectedElementId,
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
          key={`perspective-${plane}-${resetToken}`}
          makeDefault
          fov={42}
          position={cameraFrame.position}
          onUpdate={(camera) => {
            camera.up.set(...cameraFrame.up)
            camera.lookAt(...cameraFrame.target)
          }}
        />
      ) : (
        <OrthographicCamera
          key={`ortho-${plane}-${resetToken}`}
          makeDefault
          position={cameraFrame.position}
          zoom={48}
          onUpdate={(camera) => {
            camera.up.set(...cameraFrame.up)
            camera.lookAt(...cameraFrame.target)
          }}
        />
      )}
      <ambientLight intensity={0.9} />
      <directionalLight intensity={1.2} position={[10, 12, 8]} />
      <directionalLight intensity={0.45} position={[-8, -4, 10]} />
      <OrbitControls key={`controls-${plane}-${resetToken}`} makeDefault target={cameraFrame.target} />
      <FocusController focusTarget={selectedFocusPoint} resetToken={resetToken} />
      <gridHelper args={[gridConfig.size, gridConfig.divisions, '#1f9dc2', '#334155']} position={gridConfig.position} rotation={gridConfig.rotation} />

      <Bounds margin={1.2}>
        <group onDoubleClick={() => {
          onClearSelection()
        }}>
          {showLoads && view === 'model' && snapshot.loads.map((load, index) => {
            if (load.kind !== 'area' || !load.polygon?.length || !isLoadVisible(snapshot, activeCase, load)) {
              return null
            }
            return (
              <AreaLoadMarker
                color={selectedLoadIndex === index ? '#f59e0b' : '#14b8a6'}
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
        <PlaneBoundsController plane={plane} resetToken={resetToken} snapshot={snapshot} fitKey={`${view}:${activeCase.id}:${deformationScale}`} />
      </Bounds>
    </>
  )
}
