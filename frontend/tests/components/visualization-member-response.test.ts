import { describe, expect, it } from 'vitest'
import { buildVisualizationSnapshot } from '@/components/visualization/adapter'
import { isCanonicalVisualizationSnapshot } from '@/components/visualization/normalization'
import { getMemberDeformedPoints, getMemberDisplacementMagnitude, getElementMetric } from '@/components/visualization/structural-scene-utils'
import type { VisualizationMemberResponse } from '@/components/visualization/types'

function response(uy = 0): VisualizationMemberResponse {
  return { id: 'E1', length: 6, state: 'recovered', reason: 'equilibrium', samples: [
    { x: 0, position: [0, 0, 0], displacement: [0, 0, 0] },
    { x: 3, position: [3, 0, 0], displacement: [0.002, uy, -0.01] },
    { x: 6, position: [6, 0, 0], displacement: [0, 0, 0] },
  ] }
}

function build(memberResponses: unknown, dimension: '2d' | '3d' = '2d', cases?: Record<string, unknown>) {
  return buildVisualizationSnapshot({ title: 'Member samples', mode: 'analysis-result',
    model: { schema_version: '2.0.0', coordinate_system: { semantics: 'global-z-up', version: 1,
      dimension, plane: dimension === '2d' ? 'xz' : null, dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] },
    nodes: [{ id: '1', x: 0, y: 0, z: 0 }, { id: '2', x: 6, y: 0, z: 0 }],
    elements: [{ id: 'E1', type: 'beam', nodes: ['1', '2'] }] },
    analysis: { data: { meta: { coordinateSemantics: 'global-z-up', coordinateContractVersion: 1,
      dimension, plane: dimension === '2d' ? 'xz' : null, dofOrder: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'],
      activeDofs: dimension === '2d' ? ['ux', 'uz', 'ry'] : ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'],
      nodalResultFrame: 'global', elementForceFrame: 'element-local' },
    displacements: { '1': { ux: 0, uy: 0, uz: 0 }, '2': { ux: 0, uy: 0, uz: 0 } },
    memberResponses, ...(cases ? { caseResults: cases } : {}) } },
  })
}

describe('precomputed member-response visualization', () => {
  it('renders native force stations without inventing displacement samples', () => {
    const row: VisualizationMemberResponse = { id:'E1',length:6,state:'native-stations',reason:'verified-native-stations',
      samples:[0,3,6].map(x => ({x,position:[x,0,0],N:1,V2:2,V3:-3,T:.25,M2:-6+x,M3:1,
        provenance:'solver-direct',source:{kind:'native-station-coordinate-mapping'}})) }
    const snapshot=build([row])!
    expect(isCanonicalVisualizationSnapshot(snapshot)).toBe(true)
    expect(snapshot.availableViews).toContain('forces')
    expect(snapshot.availableViews).not.toContain('deformed')
    expect(getMemberDeformedPoints(snapshot.cases[0],'E1',20)).toBeUndefined()
    expect(getMemberDisplacementMagnitude(snapshot.cases[0],'E1')).toBe(0)
    expect(getElementMetric(snapshot.cases[0],'E1','moment')).toBe(-6)
    expect(getElementMetric(snapshot.cases[0],'E1','shear')).toBe(-3)
    expect(snapshot.cases[0].memberResponses!.E1.samples[1]).not.toHaveProperty('displacement')
    row.samples[1].displacement=[0,0,0]
    expect(build([row])).toBeNull()
  })

  it('keeps partial native station coverage explicit without nearest-location or full-curve claims', () => {
    const row: VisualizationMemberResponse = {id:'E1',length:6,state:'native-stations',reason:'verified-native-stations',
      samples:[{x:3,position:[3,0,0],N:0,V2:1,V3:2,T:3,M2:4,M3:5,provenance:'linear-combination',source:'linear-combination'}]}
    const snapshot=build([row])!
    expect(isCanonicalVisualizationSnapshot(snapshot)).toBe(true)
    expect(snapshot.cases[0].memberResponses!.E1.samples).toHaveLength(1)
    row.samples.push({...row.samples[0],side:'left'})
    expect(build([row])).toBeNull()
    row.samples.pop()
    delete row.samples[0].M2
    expect(build([row])).toBeNull()
  })

  it('shows simply supported interior deflection even when both end translations are zero', () => {
    const snapshot = build([response()])!
    expect(snapshot.availableViews).toContain('deformed')
    expect(isCanonicalVisualizationSnapshot(snapshot)).toBe(true)
    expect(getMemberDeformedPoints(snapshot.cases[0], 'E1', 20)?.map((point) => point.toArray()))
      .toEqual([[0, 0, 0], [3.04, 0, -0.2], [6, 0, 0]])
    expect(getMemberDisplacementMagnitude(snapshot.cases[0], 'E1')).toBeCloseTo(Math.hypot(0.002, -0.01))
  })

  it('uses full spatial displacement vectors without adding any mechanics interpolation', () => {
    const row = response(0.015)
    const before = JSON.stringify(row)
    const snapshot = build([row], '3d')!
    const points = getMemberDeformedPoints(snapshot.cases[0], 'E1', 10)!
    expect(points).toHaveLength(row.samples.length)
    expect(points[1].toArray()).toEqual([3.02, 0.15, -0.1])
    expect(JSON.stringify(row)).toBe(before)
  })

  it('keeps samples scoped to the result case and does not manufacture unavailable curves', () => {
    const unavailable = { ...response(), state: 'unavailable', reason: 'engine', samples: [] }
    const snapshot = build([response()], '2d', { OTHER: { memberResponses: [unavailable] } })!
    expect(getMemberDeformedPoints(snapshot.cases[0], 'E1', 1)).toHaveLength(3)
    expect(getMemberDeformedPoints(snapshot.cases[1], 'E1', 1)).toBeUndefined()
    expect(getMemberDeformedPoints(snapshot.cases[0], 'missing', 1)).toBeUndefined()
  })

  it.each([
    ['unknown element', () => [{ ...response(), id: 'absent' }]],
    ['duplicate member', () => [response(), response()]],
    ['nonfinite value', () => { const row = response(); row.samples[1].displacement[2] = NaN; return [row] }],
    ['out of plane response', () => [response(0.001)]],
    ['unsorted locations', () => { const row = response(); row.samples.reverse(); return [row] }],
    ['incomplete coverage', () => { const row = response(); row.samples.pop(); return [row] }],
    ['wrong container', () => ({ E1: response() })],
  ])('rejects %s before rendering', (_label, input) => {
    expect(build(input())).toBeNull()
  })

  it('rejects corrupted samples in a persisted canonical snapshot too', () => {
    const snapshot = build([response()])!
    snapshot.cases[0].memberResponses!.E1.samples[1].position[0] = Infinity
    expect(isCanonicalVisualizationSnapshot(snapshot)).toBe(false)
  })
})
