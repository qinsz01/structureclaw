import * as THREE from 'three'

type ViewportSize = { clientWidth: number; clientHeight: number }

/** The renderer caches pixel dimensions on the canvas; its parent owns the live layout. */
export function syncCameraViewport(camera: THREE.Camera, canvas: ViewportSize & { parentElement: ViewportSize | null }) {
  const viewport = canvas.parentElement ?? canvas
  const width = viewport.clientWidth, height = viewport.clientHeight
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
  if (camera instanceof THREE.OrthographicCamera) {
    camera.left = -width / 2
    camera.right = width / 2
    camera.top = height / 2
    camera.bottom = -height / 2
    camera.updateProjectionMatrix()
  } else if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
}
