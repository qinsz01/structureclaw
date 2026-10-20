import { useScenePalette } from './palette'
import { useEffect, useMemo, useRef } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { VisualizationPlane } from '../types'
import { type SupportKind, getProjectedRollerAxis } from '../structural-scene-utils'

export function ElementTube({
  color,
  end,
  highlightColor,
  onClick,
  onHover,
  selected,
  start,
}: {
  color: string
  end: THREE.Vector3
  highlightColor?: string
  onClick: () => void
  onHover: (hovered: boolean) => void
  selected: boolean
  start: THREE.Vector3
}) {
  const palette = useScenePalette()
  const group = useRef<THREE.Group | null>(null)
  const diff = useMemo(() => end.clone().sub(start), [end, start])
  const midpoint = useMemo(() => start.clone().add(end).multiplyScalar(0.5), [end, start])
  const length = diff.length()
  const quaternion = useMemo(() => {
    const normalized = diff.clone().normalize()
    const base = new THREE.Vector3(0, 1, 0)
    const next = new THREE.Quaternion()
    next.setFromUnitVectors(base, normalized.lengthSq() > 0 ? normalized : base)
    return next
  }, [diff])

  useEffect(() => {
    if (!group.current) {
      return
    }
    group.current.quaternion.copy(quaternion)
  }, [quaternion])

  return (
    <group position={midpoint} ref={group}>
      {selected ? (
        <mesh>
          <cylinderGeometry args={[0.16, 0.16, Math.max(length, 0.001), 18]} />
          <meshBasicMaterial color={highlightColor} transparent opacity={0.28} />
        </mesh>
      ) : null}
      <mesh onClick={onClick} onPointerOut={() => onHover(false)} onPointerOver={() => onHover(true)}>
        <cylinderGeometry args={[selected ? 0.1 : 0.075, selected ? 0.1 : 0.075, Math.max(length, 0.001), 12]} />
        <meshStandardMaterial color={color} emissive={selected ? highlightColor : palette.foreground} emissiveIntensity={selected ? 0.4 : 0} metalness={0.15} roughness={0.32} />
      </mesh>
      <mesh onClick={onClick} onPointerOut={() => onHover(false)} onPointerOver={() => onHover(true)} visible={false}>
        <cylinderGeometry args={[0.22, 0.22, Math.max(length, 0.001), 10]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  )
}

export function VectorArrow({
  color,
  origin,
  selected = false,
  vector,
}: {
  color: string
  origin: THREE.Vector3
  selected?: boolean
  vector: THREE.Vector3
}) {
  const palette = useScenePalette()
  const direction = useMemo(() => vector.clone().normalize(), [vector])
  const length = Math.max(vector.length(), 0.01)
  const headLength = Math.min(length * 0.35, Math.max(length * 0.26, 0.08))
  const quaternion = useMemo(() => {
    const base = new THREE.Vector3(0, 1, 0)
    const next = new THREE.Quaternion()
    next.setFromUnitVectors(base, direction.lengthSq() > 0 ? direction : base)
    return next
  }, [direction])
  const shaftPosition = useMemo(() => origin.clone().add(vector.clone().multiplyScalar(0.4)), [origin, vector])
  const headPosition = useMemo(() => origin.clone().addScaledVector(direction, length - headLength / 2), [origin, direction, length, headLength])

  return (
    <>
      <group position={shaftPosition} quaternion={quaternion}>
        <mesh renderOrder={6}>
          <cylinderGeometry args={[selected ? 0.05 : 0.035, selected ? 0.05 : 0.035, Math.max(length * 0.8, 0.001), 12]} />
          <meshStandardMaterial depthTest={false} depthWrite={false} color={color} emissive={selected ? palette.highlight : palette.foreground} emissiveIntensity={selected ? 0.45 : 0} />
        </mesh>
      </group>
      <group position={headPosition} quaternion={quaternion}>
        <mesh renderOrder={6}>
          <coneGeometry args={[selected ? 0.14 : 0.1, headLength, 12]} />
          <meshStandardMaterial depthTest={false} depthWrite={false} color={color} emissive={selected ? palette.highlight : palette.foreground} emissiveIntensity={selected ? 0.45 : 0} />
        </mesh>
      </group>
    </>
  )
}

export function SupportMarker({
  dimension,
  kind,
  origin,
  plane,
}: {
  dimension: 2 | 3
  kind: SupportKind
  origin: THREE.Vector3
  plane: VisualizationPlane
}) {
  const palette = useScenePalette()
  if (kind === 'none') {
    return null
  }
  const color = palette.neutral
  const rollerAxis = getProjectedRollerAxis(kind, plane, dimension)
  const isRoller = rollerAxis !== null
  const rollerOffsets: Array<[number, number, number]> = rollerAxis
    ? [-0.13, 0.13].map((offset) => [
        rollerAxis.x * offset,
        rollerAxis.y * offset,
        -0.42 + rollerAxis.z * offset,
      ])
    : []

  if (kind === 'fixed') {
    return (
      <group position={origin.toArray()}>
        <mesh position={[0, 0, -0.12]}>
          <boxGeometry args={[0.5, 0.5, 0.16]} />
          <meshStandardMaterial color={color} metalness={0.15} roughness={0.65} />
        </mesh>
        <Line color={color} lineWidth={1.5} points={[[-0.32, 0, -0.22], [0.32, 0, -0.22]]} />
      </group>
    )
  }

  if (kind === 'pinned' || isRoller) {
    return (
      <group position={origin.toArray()}>
        <mesh position={[0, 0, -0.19]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.25, 0.36, 4]} />
          <meshStandardMaterial color={color} metalness={0.1} roughness={0.7} />
        </mesh>
        {isRoller && rollerOffsets.map((offset, index) => (
          <mesh key={`${kind}-${index}`} position={offset as [number, number, number]}>
            <sphereGeometry args={[0.075, 14, 14]} />
            <meshStandardMaterial color={color} metalness={0.2} roughness={0.55} />
          </mesh>
        ))}
      </group>
    )
  }

  return (
    <group position={origin.toArray()}>
      <mesh position={[0, 0, -0.2]}>
        <octahedronGeometry args={[0.22, 0]} />
        <meshStandardMaterial color={palette.buckling} wireframe />
      </mesh>
    </group>
  )
}
