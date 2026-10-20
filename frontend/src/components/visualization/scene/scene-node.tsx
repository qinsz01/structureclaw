import { formatResultNumber } from '@/lib/utils'
import { interactionColor, useScenePalette } from './palette'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { VisualizationNode } from '../types'
import {
  classifySupport,
  createColorScale,
  getNodeDisplacementMagnitude,
  getNodeLabelOffset,
  getNodeReactionMagnitude,
  isLoadVisible,
  isRenderableLoadVector,
  projectPosition,
} from '../structural-scene-utils'
import { SupportMarker, VectorArrow } from './primitives'
import { MomentLoadMarker } from './load-markers'
import type { SceneRenderContext } from './render-context'

/** One node: support marker, selectable sphere, label, reactions and nodal loads. */
export function SceneNode({ entry, ctx }: { entry: VisualizationNode; ctx: SceneRenderContext }) {
  const palette = useScenePalette()
  const { locale = 'en', snapshot, plane, view, activeCase, selectedLoadIndex, selectedNodeId, showLoads, showNodeLabels, onSelectElement, onSelectLoad, onSelectNode, maxReaction, maxReactionMoment, maxDisplacement, hoveredNodeId, setHoveredNodeId, nodeMap, loadArrowLength } = ctx
  const nodeData = nodeMap.get(entry.id)
  if (!nodeData) {
    return null
  }
  const magnitude =
    view === 'reactions'
      ? getNodeReactionMagnitude(activeCase, entry.id)
      : view === 'deformed'
        ? getNodeDisplacementMagnitude(activeCase, entry.id)
        : 0
  const baseColor = view === 'reactions' ? createColorScale(magnitude, maxReaction, palette)
    : view === 'deformed' ? createColorScale(magnitude, maxDisplacement, palette) : palette.node
  const color = interactionColor(baseColor, selectedNodeId === entry.id, hoveredNodeId === entry.id, palette)
  const position = view === 'deformed' ? nodeData.displacedPosition : nodeData.position
  const finalPosition = projectPosition(position, plane, snapshot.dimension)
  const supportPosition = projectPosition(nodeData.position, plane, snapshot.dimension)
  const supportKind = classifySupport(entry.restraints, snapshot.dimension)
  const reaction = activeCase.nodeResults[entry.id]?.reaction
  const reactionComponents = (['fx', 'fy', 'fz', 'mx', 'my', 'mz'] as const)
    .filter(key => Math.abs(reaction?.[key] || 0) > 1e-12)
  const arrowVector = reaction
    ? new THREE.Vector3(reaction.fx || 0, reaction.fy || 0, reaction.fz || 0)
        .multiplyScalar(loadArrowLength * 0.9 / Math.max(maxReaction, 1e-12))
    : null
  const reactionMomentVector = reaction
    ? new THREE.Vector3(reaction.mx || 0, reaction.my || 0, reaction.mz || 0)
    : null
  const reactionMomentMagnitude = reactionMomentVector?.length() || 0
  const projectedReactionMomentVector = reactionMomentVector
    ? projectPosition(reactionMomentVector, plane, snapshot.dimension)
    : null
  const loadVectors = showLoads
    ? snapshot.loads.reduce<THREE.Vector3[]>((vectors, load) => {
        if (load.nodeId !== entry.id || load.kind === 'moment') {
          return vectors
        }

        if (!isLoadVisible(snapshot, activeCase, load)) {
          return vectors
        }

        const raw = new THREE.Vector3(load.vector.x, load.vector.y, load.vector.z)
        if (!isRenderableLoadVector(raw)) {
          return vectors
        }

        vectors.push(projectPosition(raw.normalize().multiplyScalar(loadArrowLength), plane, snapshot.dimension))
        return vectors
      }, [])
    : []
  const momentLoads = showLoads
    ? snapshot.loads.reduce<Array<{ index: number; vector: THREE.Vector3 }>>((vectors, load, index) => {
        if (load.nodeId !== entry.id || load.kind !== 'moment') {
          return vectors
        }
        if (!isLoadVisible(snapshot, activeCase, load)) {
          return vectors
        }
        const raw = new THREE.Vector3(load.vector.x, load.vector.y, load.vector.z)
        if (!isRenderableLoadVector(raw)) {
          return vectors
        }
        vectors.push({
          index,
          vector: projectPosition(raw, plane, snapshot.dimension),
        })
        return vectors
      }, [])
    : []

  return (
    <group>
      <SupportMarker
        dimension={snapshot.dimension}
        kind={supportKind}
        origin={supportPosition}
        plane={plane}
      />
      {selectedNodeId === entry.id ? (
        <mesh position={finalPosition.toArray()}>
          <sphereGeometry args={[snapshot.dimension === 3 ? 0.34 : 0.28, 24, 24]} />
          <meshBasicMaterial color={palette.highlight} transparent opacity={0.26} />
        </mesh>
      ) : null}
      <mesh
        onClick={() => {
          onSelectNode(entry.id)
          onSelectElement(null)
          onSelectLoad(null)
        }}
        onPointerOut={() => setHoveredNodeId(null)}
        onPointerOver={() => setHoveredNodeId(entry.id)}
        position={finalPosition.toArray()}
      >
        <sphereGeometry args={[selectedNodeId === entry.id ? 0.23 : 0.14, 20, 20]} />
        <meshStandardMaterial color={color} emissive={selectedNodeId === entry.id ? palette.highlight : palette.node} emissiveIntensity={selectedNodeId === entry.id ? 0.45 : 0} />
      </mesh>
      <mesh
        onClick={() => {
          onSelectNode(entry.id)
          onSelectElement(null)
          onSelectLoad(null)
        }}
        onPointerOut={() => setHoveredNodeId(null)}
        onPointerOver={() => setHoveredNodeId(entry.id)}
        position={finalPosition.toArray()}
        visible={false}
      >
        <sphereGeometry args={[snapshot.dimension === 3 ? 0.36 : 0.3, 16, 16]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
      {showNodeLabels && (
        <Html center position={finalPosition.clone().add(getNodeLabelOffset(plane, snapshot.dimension)).toArray()}>
          <div data-viz-label className="w-max whitespace-nowrap rounded-full border border-border/70 bg-background/90 px-2 py-1 text-[10px] font-medium text-foreground shadow-lg">
            {entry.id}
          </div>
        </Html>
      )}
      {view === 'reactions' && arrowVector && arrowVector.length() > 0.0001 && (
        <VectorArrow color={palette.selected} origin={finalPosition} vector={projectPosition(arrowVector, plane, snapshot.dimension)} />
      )}
      {view === 'reactions' && projectedReactionMomentVector && reactionMomentMagnitude > 1e-12 && (
        <MomentLoadMarker
          color={palette.moment}
          origin={finalPosition}
          radius={loadArrowLength * (0.25 + 0.2 * reactionMomentMagnitude / Math.max(maxReactionMoment, 1e-12))}
          selected={selectedNodeId === entry.id}
          vector={projectedReactionMomentVector}
          onClick={() => {
            onSelectNode(entry.id)
            onSelectElement(null)
            onSelectLoad(null)
          }}
        />
      )}
      {view === 'reactions' && reaction && reactionComponents.length > 0 && <Html center
        position={finalPosition.clone().add(arrowVector ?? new THREE.Vector3()).add(getNodeLabelOffset(plane, snapshot.dimension).multiplyScalar(3)).toArray()} zIndexRange={[20, 0]}>
        <div data-viz-label className="w-max whitespace-nowrap rounded-md border border-border bg-background/95 px-2 py-1 text-[10px] text-foreground">
          {reactionComponents.map(key =>
            <div key={key}>{key}: {formatResultNumber(reaction[key]!, locale)} {key.startsWith('m') ? snapshot.momentUnit : snapshot.resultUnit}</div>)}
        </div>
      </Html>}
      {showLoads && loadVectors.map((vector, index) => (
        <VectorArrow
          color={typeof selectedLoadIndex === 'number' && snapshot.loads[selectedLoadIndex]?.nodeId === entry.id ? palette.selected : palette.load}
          key={`${entry.id}-load-${index}`}
          origin={finalPosition.clone().sub(vector)}
          selected={typeof selectedLoadIndex === 'number' && snapshot.loads[selectedLoadIndex]?.nodeId === entry.id}
          vector={vector}
        />
      ))}
      {momentLoads.map((load) => (
        <MomentLoadMarker
          color={selectedLoadIndex === load.index ? palette.selected : palette.load}
          key={`${entry.id}-moment-${load.index}`}
          onClick={() => {
            onSelectLoad(load.index)
            onSelectNode(null)
            onSelectElement(null)
          }}
          origin={finalPosition}
          radius={loadArrowLength * 0.45}
          selected={selectedLoadIndex === load.index}
          vector={load.vector}
        />
      ))}
    </group>
  )
}
