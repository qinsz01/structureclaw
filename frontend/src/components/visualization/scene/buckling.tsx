import React, { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

export function BucklingMember({
  baseStart,
  baseEnd,
  modeStart,
  modeEnd,
  scale,
  amplitudeRef,
  color,
  selected,
  onClick,
  onHover,
}: {
  baseStart: THREE.Vector3
  baseEnd: THREE.Vector3
  modeStart: [number, number, number]
  modeEnd: [number, number, number]
  scale: number
  amplitudeRef: React.MutableRefObject<number>
  color: string
  selected: boolean
  onClick: () => void
  onHover: (hovered: boolean) => void
}) {
  const groupRef = useRef<THREE.Group | null>(null)
  const length = useMemo(() => baseStart.distanceTo(baseEnd), [baseStart, baseEnd])
  const modeStartVec = useMemo(() => new THREE.Vector3(modeStart[0], modeStart[1], modeStart[2]), [modeStart])
  const modeEndVec = useMemo(() => new THREE.Vector3(modeEnd[0], modeEnd[1], modeEnd[2]), [modeEnd])

  // Pre-allocate scratch objects to avoid per-frame GC pressure
  const _s = useRef(new THREE.Vector3())
  const _e = useRef(new THREE.Vector3())
  const _diff = useRef(new THREE.Vector3())
  const _norm = useRef(new THREE.Vector3())
  const _mid = useRef(new THREE.Vector3())
  const _q = useRef(new THREE.Quaternion())
  const _up = useRef(new THREE.Vector3(0, 1, 0))

  useFrame(() => {
    if (!groupRef.current) return
    const amp = amplitudeRef.current
    _s.current.copy(baseStart).addScaledVector(modeStartVec, scale * amp)
    _e.current.copy(baseEnd).addScaledVector(modeEndVec, scale * amp)
    _diff.current.subVectors(_e.current, _s.current)
    _mid.current.addVectors(_s.current, _e.current).multiplyScalar(0.5)
    groupRef.current.position.copy(_mid.current)
    // Copy into scratch _norm then normalize in-place — avoids a per-frame clone() allocation
    _norm.current.copy(_diff.current).normalize()
    _q.current.setFromUnitVectors(_up.current, _norm.current.lengthSq() > 0 ? _norm.current : _up.current)
    groupRef.current.quaternion.copy(_q.current)
  })

  return (
    <group ref={groupRef} position={baseStart.clone().add(baseEnd).multiplyScalar(0.5).toArray()}>
      <mesh onClick={onClick} onPointerOut={() => onHover(false)} onPointerOver={() => onHover(true)}>
        <cylinderGeometry args={[selected ? 0.1 : 0.075, selected ? 0.1 : 0.075, Math.max(length, 0.001), 12]} />
        <meshStandardMaterial color={color} metalness={0.15} roughness={0.32} />
      </mesh>
    </group>
  )
}

/** R3F component that drives sinusoidal buckling animation via useFrame. */

export function BucklingAnimator({ amplitudeRef }: { amplitudeRef: React.MutableRefObject<number> }) {
  useFrame(({ clock }) => {
    amplitudeRef.current = Math.sin(clock.getElapsedTime() * 2.2)
  })
  return null
}
