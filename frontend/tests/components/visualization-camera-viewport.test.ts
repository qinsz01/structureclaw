import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { syncCameraViewport } from '@/components/visualization/scene/camera-viewport'

describe('camera viewport synchronization before Fit', () => {
  it('keeps a fit computed before a delayed resize identical to a later fit', () => {
    const width = 1046.390625, height = 421
    const camera = new THREE.OrthographicCamera(-451.1953125, 451.1953125, height / 2, -height / 2)
    camera.position.set(3, 0, 10)
    camera.lookAt(3, 0, 0)
    camera.updateMatrixWorld()
    syncCameraViewport(camera, { clientWidth: 902.390625, clientHeight: height,
      parentElement: { clientWidth: width, clientHeight: height } })
    // Independent horizontal fit: 6 m structure, 0.14 m end markers and margin 1.3.
    camera.zoom = width / (6.28 * 1.3)
    camera.updateProjectionMatrix()
    const first = new THREE.Vector3(0, 0, 0).project(camera)
    expect((first.x + 1) * width / 2).toBeCloseTo(width * (.5 - 3 / (6.28 * 1.3)), 8)
    // The observer later writes the same frustum; it must not change the fitted image.
    camera.left = -width / 2
    camera.right = width / 2
    camera.top = height / 2
    camera.bottom = -height / 2
    camera.updateProjectionMatrix()
    expect(new THREE.Vector3(0, 0, 0).project(camera).x).toBeCloseTo(first.x, 12)
  })

  it('updates perspective aspect without changing the chosen pose or zoom', () => {
    const camera = new THREE.PerspectiveCamera(42, 902 / 421)
    camera.position.set(4, 5, 6)
    camera.lookAt(3, 0, 0)
    camera.zoom = 1.7
    const pose = camera.quaternion.clone()
    syncCameraViewport(camera, { clientWidth: 902, clientHeight: 421,
      parentElement: { clientWidth: 1046, clientHeight: 421 } })
    expect(camera.aspect).toBe(1046 / 421)
    expect(camera.position.toArray()).toEqual([4, 5, 6])
    expect(camera.quaternion.equals(pose)).toBe(true)
    expect(camera.zoom).toBe(1.7)
  })

  it.each([[0, 421], [1046, 0], [NaN, 421], [1046, Infinity]])('ignores an unavailable viewport %s × %s', (width, height) => {
    const camera = new THREE.OrthographicCamera(-10, 10, 5, -5)
    const projection = camera.projectionMatrix.clone()
    syncCameraViewport(camera, { clientWidth: 902, clientHeight: 421,
      parentElement: { clientWidth: width, clientHeight: height } })
    expect(camera.projectionMatrix.equals(projection)).toBe(true)
  })

  it('can fit a standalone canvas without a layout parent', () => {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1)
    syncCameraViewport(camera, { clientWidth: 800, clientHeight: 400, parentElement: null })
    expect([camera.left, camera.right, camera.top, camera.bottom]).toEqual([-400, 400, 200, -200])
  })
})
