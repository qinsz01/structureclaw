import { useScenePalette } from './palette'
import { useEffect, useMemo } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { VisualizationLoad, VisualizationPlane } from '../types'
import { getDistributedLoadArrows, isRenderableLoadVector, projectPosition } from '../structural-scene-utils'
import { VectorArrow } from './primitives'

export function MomentLoadMarker({
  color,
  origin,
  radius,
  selected,
  vector,
  onClick,
}: {
  color: string
  origin: THREE.Vector3
  radius: number
  selected: boolean
  vector: THREE.Vector3
  onClick: () => void
}) {
  const palette = useScenePalette()
  const direction = useMemo(() => vector.clone().normalize(), [vector])
  const quaternion = useMemo(() => {
    const base = new THREE.Vector3(0, 0, 1)
    const next = new THREE.Quaternion()
    next.setFromUnitVectors(base, direction.lengthSq() > 0 ? direction : base)
    return next
  }, [direction])
  const arrowOrigin = useMemo(() => new THREE.Vector3(radius, -radius * 0.3, 0), [radius])
  const arrowVector = useMemo(() => new THREE.Vector3(0, radius * 0.6, 0), [radius])

  return (
    <group position={origin} quaternion={quaternion}>
      <mesh
        onClick={(event) => {
          event.stopPropagation()
          onClick()
        }}
      >
        <torusGeometry args={[radius, selected ? 0.045 : 0.032, 10, 48]} />
        <meshStandardMaterial
          color={color}
          emissive={selected ? palette.highlight : palette.foreground}
          emissiveIntensity={selected ? 0.45 : 0}
        />
      </mesh>
      <VectorArrow color={color} origin={arrowOrigin} selected={selected} vector={arrowVector} />
    </group>
  )
}

export function DistributedLoadMarker({
  color,
  start,
  end,
  vector,
  endVector = vector,
  arrowCount = 8,
}: {
  color: string
  start: THREE.Vector3
  end: THREE.Vector3
  vector: THREE.Vector3
  endVector?: THREE.Vector3
  arrowCount?: number
}) {
  const palette = useScenePalette()
  const arrows = useMemo(() => getDistributedLoadArrows(start, end, vector, endVector, arrowCount), [start, end, vector, endVector, arrowCount])

  return (
    <>
      <Line color={color} lineWidth={1.5} points={arrows.map(arrow => arrow.origin.toArray())} />
      {arrows.map((arrow, index) => arrow.vector.lengthSq() > 1e-20 ? (
          <VectorArrow
            color={color}
            key={`distributed-arrow-${index}`}
            origin={arrow.origin}
            selected={color === palette.selected}
            vector={arrow.vector}
          />
        ) : null)}
    </>
  )
}

export function AreaLoadMarker({
  arrowLength,
  color,
  load,
  onClick,
  plane,
  dimension,
  selected,
}: {
  arrowLength: number
  color: string
  load: VisualizationLoad
  onClick: () => void
  plane: VisualizationPlane
  dimension: 2 | 3
  selected: boolean
}) {
  const palette = useScenePalette()
  const panelPoints = useMemo(() => {
    return (load.polygon || []).map((point) =>
      projectPosition(new THREE.Vector3(point.x, point.y, point.z), plane, dimension)
    )
  }, [dimension, load.polygon, plane])

  const geometry = useMemo(() => {
    if (panelPoints.length < 3) {
      return null
    }
    const indices = panelPoints.length === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2]
    const vertices = new Float32Array(indices.flatMap((index) => panelPoints[index].toArray()))
    const next = new THREE.BufferGeometry()
    next.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
    next.computeVertexNormals()
    return next
  }, [panelPoints])

  useEffect(() => {
    return () => {
      geometry?.dispose()
    }
  }, [geometry])

  const arrowData = useMemo(() => {
    if (panelPoints.length < 3) {
      return []
    }
    const raw = new THREE.Vector3(load.vector.x, load.vector.y, load.vector.z)
    if (!isRenderableLoadVector(raw)) {
      return []
    }
    const vector = projectPosition(raw.normalize().multiplyScalar(arrowLength), plane, dimension)
    const direction = vector.clone().normalize()
    const ratios = [0.25, 0.5, 0.75]
    const samplePoints = panelPoints.length === 4
      ? ratios.flatMap((u) => ratios.map((v) => {
          const nearEdge = panelPoints[0].clone().lerp(panelPoints[1], u)
          const farEdge = panelPoints[3].clone().lerp(panelPoints[2], u)
          return nearEdge.lerp(farEdge, v)
        }))
      : [panelPoints.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / panelPoints.length)]

    return samplePoints.map((point) => ({
      origin: point.clone().sub(direction.clone().multiplyScalar(vector.length())),
      vector,
    }))
  }, [arrowLength, dimension, load.vector.x, load.vector.y, load.vector.z, panelPoints, plane])

  if (!geometry || panelPoints.length < 3) {
    return null
  }

  const outline = [...panelPoints, panelPoints[0]].map((point) => point.toArray())

  return (
    <group>
      <mesh
        geometry={geometry}
        onClick={(event) => {
          event.stopPropagation()
          onClick()
        }}
        renderOrder={selected ? 2 : 1}
      >
        <meshStandardMaterial
          color={color}
          depthWrite={false}
          opacity={selected ? 0.42 : 0.26}
          roughness={0.74}
          side={THREE.DoubleSide}
          transparent
        />
      </mesh>
      <Line color={selected ? palette.selected : color} lineWidth={selected ? 2.4 : 1.6} points={outline} />
      {arrowData.map((entry, index) => (
        <VectorArrow
          color={selected ? palette.selected : palette.area}
          key={`area-load-arrow-${index}`}
          origin={entry.origin}
          selected={selected}
          vector={entry.vector}
        />
      ))}
    </group>
  )
}

/** Animated tube for buckling view — updates position/orientation each frame from amplitudeRef. */
