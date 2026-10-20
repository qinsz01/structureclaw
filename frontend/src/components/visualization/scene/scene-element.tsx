import { MemberDiagram } from './member-diagram'
import { interactionColor, useScenePalette } from './palette'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { VisualizationElement } from '../types'
import {
  createColorScale,
  createUtilizationColor,
  getElementMetric,
  getMemberDeformedPoints,
  getMemberDisplacementMagnitude,
  getMemberLoadInterval,
  getNodeDisplacementMagnitude,
  isLoadVisible,
  isRenderableLoadVector,
  projectPosition,
} from '../structural-scene-utils'
import { ElementTube, VectorArrow } from './primitives'
import { DistributedLoadMarker, MomentLoadMarker } from './load-markers'
import { BucklingMember } from './buckling'
import type { SceneRenderContext } from './render-context'

/** One line member (tube, deformed curve or buckling member) with its label and member loads. */
export function SceneElement({ element, ctx }: { element: VisualizationElement; ctx: SceneRenderContext }) {
  const palette = useScenePalette()
  const { snapshot, plane, view, activeCase, deformationScale, forceMetric, selectedElementId, selectedLoadIndex, showElementLabels, showLoads, showUndeformed, onSelectElement, onSelectLoad, onSelectNode, maxElementMetric, maxDisplacement, bucklingAmplitudeRef, hoveredElementId, setHoveredElementId, nodeMap, loadArrowLength, activeBucklingMode, bucklingScale } = ctx
  if (!['beam', 'truss', 'column', 'brace', 'link'].includes(element.type)) {
    return null
  }
  const startData = nodeMap.get(element.nodeIds[0])
  const endData = nodeMap.get(element.nodeIds[1])
  if (!startData || !endData) {
    return null
  }
  // In deformed view, always render the main member geometry at deformed coordinates.
  // The "undeformed" toggle controls only the gray overlay reference line.
  // In buckling view, positions are animated via BucklingMember component.
  const start = view === 'deformed' ? startData.displacedPosition : startData.position
  const end = view === 'deformed' ? endData.displacedPosition : endData.position
  const curve = view === 'deformed' ? getMemberDeformedPoints(activeCase, element.id, deformationScale)
    ?.map((point) => projectPosition(point, plane, snapshot.dimension)) : undefined
  const componentValue = getElementMetric(activeCase, element.id, forceMetric)
  const forceColor = componentValue === null ? palette.neutral : createColorScale(componentValue, maxElementMetric, palette)
  const utilizationRatio = activeCase.elementResults[element.id]?.utilization
  const deformedMagnitude = Math.max(getNodeDisplacementMagnitude(activeCase, element.nodeIds[0]),
    getNodeDisplacementMagnitude(activeCase, element.nodeIds[1]), getMemberDisplacementMagnitude(activeCase, element.id))
  const baseColor = view === 'forces' ? forceColor : view === 'utilization'
    ? utilizationRatio === undefined ? palette.neutral : createUtilizationColor(utilizationRatio, palette)
    : view === 'deformed' ? createColorScale(deformedMagnitude, maxDisplacement, palette)
    : view === 'buckling' ? palette.buckling : palette.member
  const color = interactionColor(baseColor, selectedElementId === element.id, hoveredElementId === element.id, palette)
  const undeformedStart = projectPosition(startData.position, plane, snapshot.dimension)
  const undeformedEnd = projectPosition(endData.position, plane, snapshot.dimension)
  const currentStart = projectPosition(start, plane, snapshot.dimension)
  const currentEnd = projectPosition(end, plane, snapshot.dimension)
  const modeStart = activeBucklingMode?.modeShape[element.nodeIds[0]] ?? [0, 0, 0]
  const modeEnd = activeBucklingMode?.modeShape[element.nodeIds[1]] ?? [0, 0, 0]
  const projectedModeStart = projectPosition(new THREE.Vector3(...modeStart), plane, snapshot.dimension).toArray() as [number, number, number]
  const projectedModeEnd = projectPosition(new THREE.Vector3(...modeEnd), plane, snapshot.dimension).toArray() as [number, number, number]
  const memberLoads = showLoads ? snapshot.loads.map((load, index) => ({ load, index }))
    .filter(({ load }) => load.elementId === element.id && isLoadVisible(snapshot, activeCase, load)) : []
  const distributedMax = Math.max(1e-12, ...memberLoads.filter(({ load }) => load.kind === 'distributed')
    .flatMap(({ load }) => [Math.hypot(load.vector.x, load.vector.y, load.vector.z),
      Math.hypot((load.endVector || load.vector).x, (load.endVector || load.vector).y, (load.endVector || load.vector).z)]))
  return (
    <group>
      {(view === 'deformed' && showUndeformed) && (
        <Line color={palette.original} lineWidth={2.5} points={[undeformedStart.toArray(), undeformedEnd.toArray()]} dashed dashSize={0.18} gapSize={0.12} depthTest={false} renderOrder={5} />
      )}
      {view === 'buckling' && activeBucklingMode ? (
        <BucklingMember
          amplitudeRef={bucklingAmplitudeRef}
          baseStart={currentStart}
          baseEnd={currentEnd}
          modeStart={projectedModeStart}
          modeEnd={projectedModeEnd}
          scale={bucklingScale}
          color={color}
          selected={selectedElementId === element.id}
          onClick={() => {
            onSelectElement(element.id)
            onSelectNode(null)
            onSelectLoad(null)
          }}
          onHover={(hovered) => setHoveredElementId(hovered ? element.id : null)}
        />
      ) : curve ? (
        <Line
          color={color}
          lineWidth={selectedElementId === element.id ? 5 : 3}
          points={curve}
          onClick={(event) => {
            event.stopPropagation()
            onSelectElement(element.id)
            onSelectNode(null)
            onSelectLoad(null)
          }}
          onPointerOver={(event) => { event.stopPropagation(); setHoveredElementId(element.id) }}
          onPointerOut={() => setHoveredElementId(null)}
        />
      ) : (
        <ElementTube
          color={color}
          end={currentEnd}
          highlightColor={palette.highlight}
          onClick={() => {
            onSelectElement(element.id)
            onSelectNode(null)
            onSelectLoad(null)
          }}
          onHover={(hovered) => setHoveredElementId(hovered ? element.id : null)}
          selected={selectedElementId === element.id}
          start={currentStart}
        />
      )}
      {view === 'forces' && <MemberDiagram element={element} ctx={ctx} />}
      {showElementLabels && (
        <Html center position={(curve?.[Math.floor(curve.length / 2)] || currentStart.clone().add(currentEnd).multiplyScalar(0.5)).toArray()}>
          <div data-viz-label className="w-max whitespace-nowrap rounded-full border border-border/70 bg-background/90 px-2 py-1 text-[10px] font-medium text-foreground shadow-lg">
            {element.id}
          </div>
        </Html>
      )}
      {memberLoads.map(({ load, index }) => {
        const interval = getMemberLoadInterval(load, currentStart, currentEnd, startData.position.distanceTo(endData.position))
        const raw = new THREE.Vector3(load.vector.x, load.vector.y, load.vector.z)
        const projected = projectPosition(raw, plane, snapshot.dimension)
        const selected = selectedLoadIndex === index
        const loadColor = selected ? palette.selected : palette.load
        const select = () => { onSelectLoad(index); onSelectNode(null); onSelectElement(null) }
        const last = load.endVector || load.vector
        return <group key={`${element.id}-load-${index}`} onClick={event => { event.stopPropagation(); select() }}>
          {load.kind === 'distributed' ? <DistributedLoadMarker color={loadColor}
            start={interval.start} end={interval.end} vector={projected.multiplyScalar(loadArrowLength / distributedMax)}
            endVector={projectPosition(new THREE.Vector3(last.x, last.y, last.z), plane, snapshot.dimension).multiplyScalar(loadArrowLength / distributedMax)} />
            : load.kind === 'moment' ? <MomentLoadMarker color={loadColor} origin={interval.start}
              radius={loadArrowLength * 0.32} selected={selected} vector={projected} onClick={select} />
            : isRenderableLoadVector(raw) ? <VectorArrow color={loadColor} origin={interval.start.clone().sub(projected.clone().normalize().multiplyScalar(loadArrowLength))}
              selected={selected} vector={projected.normalize().multiplyScalar(loadArrowLength)} /> : null}
        </group>
      })}
    </group>
  )
}
