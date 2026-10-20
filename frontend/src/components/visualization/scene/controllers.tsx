import React, { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { useBounds } from '@react-three/drei'
import * as THREE from 'three'
import type { CameraPreset } from '../state'
import type { VisualizationPlane, VisualizationSnapshot } from '../types'
import { getPlaneCameraFrame } from '../structural-scene-utils'

export function PlaneBoundsController({
  plane,
  resetToken,
  snapshot,
  fitKey,
  cameraPreset,
  preserveCameraOnResize = false,
}: {
  plane: VisualizationPlane
  resetToken: number
  snapshot: VisualizationSnapshot
  fitKey: string
  cameraPreset?: CameraPreset
  preserveCameraOnResize?: boolean
}) {
  const bounds = useBounds()
  const camera = useThree((state) => state.camera)
  const height = useThree((state) => state.size.height)
  const width = useThree((state) => state.size.width)
  const fitHeight = preserveCameraOnResize ? 0 : height
  const fitWidth = preserveCameraOnResize ? 0 : width

  useEffect(() => {
    const { center, distance } = bounds.refresh().getSize()
    const frame = getPlaneCameraFrame(
      plane,
      snapshot.dimension,
      center.toArray() as [number, number, number],
      distance,
      cameraPreset
    )

    bounds
      .moveTo(frame.position)
      .lookAt({ target: frame.target, up: frame.up })
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      bounds.fit()
    }
    bounds.clip()
  }, [bounds, camera, cameraPreset, fitHeight, plane, resetToken, snapshot, fitWidth, fitKey])

  return null
}

/** Internal R3F component that captures gl and invalidate into parent refs. */

export function PngExporter({
  glRef,
  invalidateRef,
  renderRef,
  measureRef,
}: {
  glRef: React.MutableRefObject<THREE.WebGLRenderer | null>
  invalidateRef: React.MutableRefObject<(() => void) | null>
  renderRef: React.MutableRefObject<(() => void) | null>
  measureRef: React.MutableRefObject<(() => number) | null>
}) {
  const { gl, invalidate, scene, camera, controls, size } = useThree()
  useEffect(() => {
    glRef.current = gl
    invalidateRef.current = invalidate
    renderRef.current = () => gl.render(scene, camera)
    measureRef.current = () => {
      if (camera instanceof THREE.OrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / size.height
      const target = (controls as unknown as { target?: THREE.Vector3 })?.target ?? new THREE.Vector3()
      return 2 * camera.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov / 2)) / size.height
    }
  }, [gl, glRef, invalidate, invalidateRef, renderRef, measureRef, scene, camera, controls, size])
  return null
}

export function FocusController({
  focusTarget,
  focusKey,
}: {
  focusTarget: THREE.Vector3 | null
  focusKey: string
}) {
  const { camera, controls, invalidate } = useThree()

  const targetRef = useRef(focusTarget)
  targetRef.current = focusTarget
  useEffect(() => {
    if (!targetRef.current || !controls) return
    // Bounds animates for 0.2 s. Focus only after it has finished and only on a
    // new selection, never in response to display-scale slider ticks.
    const timer = window.setTimeout(() => {
      const target = targetRef.current
      if (!target) return
      const orbit = controls as unknown as { target: THREE.Vector3; update: () => void }
      const direction = camera.position.clone().sub(orbit.target)
      camera.position.copy(target.clone().add(direction))
      orbit.target.copy(target)
      orbit.update()
      invalidate()
    }, 300)
    return () => window.clearTimeout(timer)
  }, [camera, controls, focusKey, invalidate])
  return null
}
