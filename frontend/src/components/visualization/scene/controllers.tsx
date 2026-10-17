import React, { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { useBounds } from '@react-three/drei'
import * as THREE from 'three'
import type { VisualizationPlane, VisualizationSnapshot } from '../types'
import { getPlaneCameraFrame } from '../structural-scene-utils'

export function PlaneBoundsController({
  plane,
  resetToken,
  snapshot,
  fitKey,
}: {
  plane: VisualizationPlane
  resetToken: number
  snapshot: VisualizationSnapshot
  fitKey: string
}) {
  const bounds = useBounds()
  const camera = useThree((state) => state.camera)
  const height = useThree((state) => state.size.height)
  const width = useThree((state) => state.size.width)

  useEffect(() => {
    const { center, distance } = bounds.refresh().getSize()
    const frame = getPlaneCameraFrame(
      plane,
      snapshot.dimension,
      center.toArray() as [number, number, number],
      distance
    )

    bounds
      .moveTo(frame.position)
      .lookAt({ target: frame.target, up: frame.up })
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      bounds.fit()
    }
    bounds.clip()
  }, [bounds, camera, height, plane, resetToken, snapshot, width, fitKey])

  return null
}

/** Internal R3F component that captures gl and invalidate into parent refs. */

export function PngExporter({
  glRef,
  invalidateRef,
}: {
  glRef: React.MutableRefObject<THREE.WebGLRenderer | null>
  invalidateRef: React.MutableRefObject<(() => void) | null>
}) {
  const { gl, invalidate } = useThree()
  useEffect(() => {
    glRef.current = gl
    invalidateRef.current = invalidate
  }, [gl, glRef, invalidate, invalidateRef])
  return null
}

export function FocusController({
  focusTarget,
  resetToken,
}: {
  focusTarget: THREE.Vector3 | null
  resetToken: number
}) {
  const { camera, controls } = useThree()

  useEffect(() => {
    if (!focusTarget || !controls) {
      return
    }

    const orbitControls = controls as unknown as {
      target: THREE.Vector3
      update: () => void
    }
    const direction = camera.position.clone().sub(orbitControls.target)
    if (direction.lengthSq() <= 1e-8) {
      direction.set(1, 1, 1)
    }
    const nextPosition = focusTarget.clone().add(direction)
    camera.position.copy(nextPosition)
    orbitControls.target.copy(focusTarget)
    orbitControls.update()
  }, [camera, controls, focusTarget, resetToken])

  return null
}
