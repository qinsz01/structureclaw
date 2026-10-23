import React, { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { useBounds } from '@react-three/drei'
import * as THREE from 'three'
import type { CameraPreset } from '../state'
import type { VisualizationPlane, VisualizationSnapshot } from '../types'
import { getPlaneCameraFrame, getSnapshotCenter } from '../structural-scene-utils'
import { syncCameraViewport } from './camera-viewport'

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
  const gl = useThree((state) => state.gl)
  const height = useThree((state) => state.size.height)
  const width = useThree((state) => state.size.width)
  const fitHeight = preserveCameraOnResize ? 0 : height
  const fitWidth = preserveCameraOnResize ? 0 : width

  useEffect(() => {
    // A view switch can remove a legend and widen the canvas before R3F receives
    // its resize notification. Fit must use the visible viewport immediately.
    syncCameraViewport(camera, gl.domElement)
    const { box } = bounds.refresh().getSize()
    const center = new THREE.Vector3(...getSnapshotCenter(snapshot, plane))
    // Keep the structure centered while leaving room for asymmetric load/result markers.
    const size = box.max.clone().sub(center).max(center.clone().sub(box.min)).multiplyScalar(2)
    bounds.refresh(new THREE.Box3().setFromCenterAndSize(center, size))
    const { distance } = bounds.getSize()
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
  }, [bounds, camera, gl, cameraPreset, fitHeight, plane, resetToken, snapshot, fitWidth, fitKey])

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
  const previousFocusKey = useRef(focusKey)
  targetRef.current = focusTarget
  useEffect(() => {
    const selectionChanged = previousFocusKey.current !== focusKey
    previousFocusKey.current = focusKey
    // The initial selection identifies the query; only later picks request a camera focus.
    if (!selectionChanged || !targetRef.current || !controls) return
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
