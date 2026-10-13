import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildVisualizationSnapshot } from '@/components/visualization/adapter'
import { isCanonicalVisualizationSnapshot } from '@/components/visualization/normalization'
import { getDistributedLoadArrows, getMemberLoadInterval } from '@/components/visualization/structural-scene-utils'

function build(loads: Record<string, unknown>[], dimension: '2d' | '3d' = '2d') {
  return buildVisualizationSnapshot({ title: 'Physical member loads', mode: 'model-only', model: {
    schema_version: '2.1.0', unit_system: 'SI', coordinate_system: { semantics: 'global-z-up', version: 1,
      dimension, plane: dimension === '2d' ? 'xz' : null, dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] },
    nodes: [{ id: 'i', x: 0, y: 0, z: 0 }, { id: 'j', x: 3, y: dimension === '3d' ? 4 : 0, z: dimension === '2d' ? 4 : 0 }],
    elements: [{ id: 'beam', type: 'beam', nodes: ['i', 'j'] }], load_cases: [{ id: 'D', loads }],
  } })
}

describe('member load drawing geometry', () => {
  it('places a 2-D member force and moment at the specified metre position', () => {
    const view = build([{ type: 'point', element: 'beam', position: 2, fz: -10, my: 7 }])!
    expect(isCanonicalVisualizationSnapshot(view)).toBe(true)
    expect(view.loads.map(load => [load.kind, load.position])).toEqual([['point', 2], ['moment', 2]])
    const point = getMemberLoadInterval(view.loads[0], new THREE.Vector3(), new THREE.Vector3(3, 0, 4))
    expect(point.start.distanceTo(new THREE.Vector3(1.2, 0, 1.6))).toBeCloseTo(0)
    expect(view.loads[1].vector).toEqual({ x: 0, y: 7, z: 0 })
    expect(view.lengthUnit).toBe('m')
  })

  it('transforms all three local force and moment components on a spatial member', () => {
    const view = build([{ type: 'point', element: 'beam', position: 2, fx: 10, fy: 5, mx: 1, my: 2, mz: 3,
      reference_frame: 'element-local' }], '3d')!
    expect(isCanonicalVisualizationSnapshot(view)).toBe(true)
    expect(view.loads[0].vector.x).toBeCloseTo(2)
    expect(view.loads[0].vector.y).toBeCloseTo(11)
    expect(view.loads[1].vector).toEqual({ x: -1, y: 2, z: 3 })
    expect(getMemberLoadInterval(view.loads[0], new THREE.Vector3(), new THREE.Vector3(3, 4, 0)).start
      .distanceTo(new THREE.Vector3(1.2, 1.6, 0))).toBeCloseTo(0)
  })

  it.each(['2d', '3d'] as const)('draws a partial uniform load only on its %s interval', dimension => {
    const view = build([{ type: 'distributed', element: 'beam', start: 1, end: 4, wz: -6 }], dimension)!
    expect(isCanonicalVisualizationSnapshot(view)).toBe(true)
    const end = dimension === '2d' ? new THREE.Vector3(3, 0, 4) : new THREE.Vector3(3, 4, 0)
    const interval = getMemberLoadInterval(view.loads[0], new THREE.Vector3(), end)
    expect(interval.start.distanceTo(new THREE.Vector3())).toBeCloseTo(1)
    expect(interval.end.distanceTo(new THREE.Vector3())).toBeCloseTo(4)
    expect(interval.start.distanceTo(interval.end)).toBeCloseTo(3)
    expect(view.loads[0].endVector).toEqual(view.loads[0].vector)
  })

  it('retains piecewise trapezoid breakpoints and linearly varies the drawn arrow lengths', () => {
    const view = build([{ type: 'distributed', element: 'beam', start: 1, end: 4, distribution: 'piecewise_linear', points: [
      { position: 0.2, wz: 0 }, { position: 0.4, wz: -8 }, { position: 0.6, wz: -8 }, { position: 0.8, wz: 0 },
    ] }])!
    expect(isCanonicalVisualizationSnapshot(view)).toBe(true)
    expect(view.loads.map(load => [load.start, load.end, load.vector.z, load.endVector?.z])).toEqual([
      [1, 2, 0, -8], [2, 3, -8, -8], [3, 4, -8, 0],
    ])
    const arrows = getDistributedLoadArrows(new THREE.Vector3(0, 0, 0), new THREE.Vector3(3, 0, 0),
      new THREE.Vector3(), new THREE.Vector3(0, 0, -6), 3)
    expect(arrows.map(arrow => arrow.vector.z)).toEqual([0, -3, -6])
    expect(arrows.map(arrow => arrow.origin.z)).toEqual([0, 3, 6])
    expect(arrows.map(arrow => arrow.origin.clone().add(arrow.vector).toArray())).toEqual([[0, 0, 0], [1.5, 0, 0], [3, 0, 0]])
  })

  it('keeps nodal concentrated moments separate from member point moments', () => {
    const view = build([{ type: 'nodal', node: 'j', my: -12 }])!
    expect(view.loads).toEqual([expect.objectContaining({ kind: 'moment', nodeId: 'j', vector: { x: 0, y: -12, z: 0 } })])
    expect(view.loads[0].elementId).toBeUndefined()
    expect(isCanonicalVisualizationSnapshot(view)).toBe(true)
  })

  it.each([
    { type: 'point', element: 'beam', position: 6, fz: -10 },
    { type: 'point', element: 'beam', fz: -10 },
    { type: 'distributed', element: 'beam', start: 4, end: 1, wz: -10 },
    { type: 'distributed', element: 'beam', distribution: 'piecewise_linear', points: [{ position: 0, wz: -2 }, { position: 0.5, wz: -3 }] },
  ])('rejects malformed input instead of drawing it as full-span uniform', load => {
    expect(build([load])).toBeNull()
  })

  it('rejects tampered persisted member-load positions and endpoint transforms', () => {
    const view = build([{ type: 'distributed', element: 'beam', start: 1, end: 4, wz: -2 }])!
    view.loads[0].end = 6
    expect(isCanonicalVisualizationSnapshot(view)).toBe(false)
    view.loads[0].end = 4
    view.loads[0].endVector!.z = -99
    expect(isCanonicalVisualizationSnapshot(view)).toBe(false)
  })
})
