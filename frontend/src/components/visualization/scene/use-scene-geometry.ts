import { useMemo } from 'react'
import * as THREE from 'three'
import { getBucklingModes } from '../extensions'
import type { CameraPreset } from '../state'
import type { BucklingMode, VisualizationCase, VisualizationPlane, VisualizationSnapshot, VisualizationViewMode } from '../types'
import {
  getAdaptiveGridConfig,
  getCaseNodeDisplacement,
  getLoadArrowLength,
  getMemberDeformedPoints,
  getMemberLoadInterval,
  getPlaneCameraFrame,
  getSnapshotCenter,
  projectPosition,
} from '../structural-scene-utils'

/** Camera frame, grid, node positions, buckling mode and selection focus derived for the scene. */
export function useSceneGeometry({
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
}: {
  cameraPreset?: CameraPreset
  snapshot: VisualizationSnapshot
  plane: VisualizationPlane
  view: VisualizationViewMode
  activeCase: VisualizationCase
  deformationScale: number
  bucklingModeIndex?: number
  selectedElementId: string | null
  selectedNodeId: string | null
  selectedLoadIndex?: number | null
}) {
  const gridConfig = useMemo(() => getAdaptiveGridConfig(snapshot, plane), [snapshot, plane])
  const cameraFrame = useMemo(
    () => getPlaneCameraFrame(plane, snapshot.dimension, getSnapshotCenter(snapshot, plane), 10, cameraPreset),
    [plane, snapshot, cameraPreset]
  )

  // Buckling mode shape for the active mode index
  const activeBucklingMode: BucklingMode | null = useMemo(() => {
    const bucklingModes = getBucklingModes(snapshot, activeCase)
    if (view !== 'buckling' || !bucklingModes.length) return null
    return bucklingModes[bucklingModeIndex ?? 0] ?? bucklingModes[0]
  }, [view, snapshot, activeCase, bucklingModeIndex])

  // Compute buckling scale: normalize mode shape so max displacement = 10% of model span
  const bucklingScale = useMemo(() => {
    if (!activeBucklingMode) return 1
    const modeShape = activeBucklingMode.modeShape
    const maxMag = Math.max(
      1e-12,
      ...Object.values(modeShape).map(([dx, dy, dz]) => Math.sqrt(dx * dx + dy * dy + dz * dz))
    )
    const xs = snapshot.nodes.map((n) => n.position.x)
    const ys = snapshot.nodes.map((n) => n.position.y)
    const zs = snapshot.nodes.map((n) => n.position.z)
    const span = Math.max(
      1,
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
      Math.max(...zs) - Math.min(...zs)
    )
    return (span * 0.1) / maxMag
  }, [activeBucklingMode, snapshot.nodes])

  const nodeMap = useMemo(
    () =>
      new Map(
        snapshot.nodes.map((node) => {
          const position = new THREE.Vector3(node.position.x, node.position.y, node.position.z)
          const displacement = getCaseNodeDisplacement(activeCase, node.id)
          const displacedPosition = position.clone().add(new THREE.Vector3(displacement.x, displacement.y, displacement.z).multiplyScalar(deformationScale))
          return [node.id, { node, position, displacedPosition }]
        })
      ),
    [activeCase, deformationScale, snapshot.nodes]
  )
  const loadArrowLength = useMemo(() => getLoadArrowLength(snapshot, plane), [snapshot, plane])
  const selectedFocusPoint = useMemo(() => {
    if (selectedElementId) {
      const element = snapshot.elements.find((entry) => entry.id === selectedElementId)
      if (element) {
        const curve = view === 'deformed' ? getMemberDeformedPoints(activeCase, element.id, deformationScale) : undefined
        if (curve?.length) return projectPosition(curve[Math.floor(curve.length / 2)], plane, snapshot.dimension)
        const startData = nodeMap.get(element.nodeIds[0])
        const endData = nodeMap.get(element.nodeIds[1])
        if (startData && endData) {
          const start = view === 'deformed' ? startData.displacedPosition : startData.position
          const end = view === 'deformed' ? endData.displacedPosition : endData.position
          return projectPosition(start.clone().add(end).multiplyScalar(0.5), plane, snapshot.dimension)
        }
      }
    }

    if (selectedNodeId) {
      const nodeData = nodeMap.get(selectedNodeId)
      if (nodeData) {
        const position = view === 'deformed' ? nodeData.displacedPosition : nodeData.position
        return projectPosition(position, plane, snapshot.dimension)
      }
    }

    if (selectedLoadIndex !== null && selectedLoadIndex !== undefined) {
      const selectedLoad = snapshot.loads[selectedLoadIndex]
      if (selectedLoad?.kind === 'area' && selectedLoad.polygon?.length) {
        const points = selectedLoad.polygon.map((point) => projectPosition(new THREE.Vector3(point.x, point.y, point.z), plane, snapshot.dimension))
        return points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / points.length)
      }
      if (selectedLoad?.elementId) {
        const element = snapshot.elements.find((entry) => entry.id === selectedLoad.elementId)
        if (element) {
          const startData = nodeMap.get(element.nodeIds[0])
          const endData = nodeMap.get(element.nodeIds[1])
          if (startData && endData) {
            const interval = getMemberLoadInterval(selectedLoad, startData.position, endData.position)
            return projectPosition(interval.start.add(interval.end).multiplyScalar(0.5), plane, snapshot.dimension)
          }
        }
      }
      if (selectedLoad?.nodeId) {
        const nodeData = nodeMap.get(selectedLoad.nodeId)
        if (nodeData) {
          return projectPosition(nodeData.position, plane, snapshot.dimension)
        }
      }
    }

    return null
  }, [selectedElementId, selectedNodeId, selectedLoadIndex, snapshot.loads, snapshot.elements, snapshot.dimension, nodeMap, plane, view, activeCase, deformationScale])

  return { gridConfig, cameraFrame, activeBucklingMode, bucklingScale, nodeMap, loadArrowLength, selectedFocusPoint }
}

export type SceneGeometry = ReturnType<typeof useSceneGeometry>
