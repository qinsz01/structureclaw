import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { buildDiagram } from '@/components/visualization/diagram'
import { classifySupport, getNodeReactionMagnitude, getPlaneCameraFrame } from '@/components/visualization/structural-scene-utils'
import { ColorBar } from '@/components/visualization/scene/color-bar'
import { formatResultNumber } from '@/lib/utils'
import type { VisualizationElement, VisualizationMemberResponse } from '@/components/visualization/types'

const element: VisualizationElement = { id: 'beam', type: 'beam', nodeIds: ['A', 'B'],
  localAxes: { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } } }
const response = (values: number[]): VisualizationMemberResponse => ({ id: 'beam', length: 10, state: 'recovered', reason: '',
  samples: values.map((M2, index) => ({ x: index * 10 / (values.length - 1), position: [index * 10 / (values.length - 1), 0, 0], M2 })) })

describe('diagram display geometry', () => {
  it.each([[0, -1.25, -2.5, -1.25, 0], [0, -1.875, -2.5, -1.875, 0]])('preserves the signed triangular or parabolic beam samples %j', (...values) => {
    const diagram = buildDiagram(response(values), element, 'M2', 2.5, 10)!
    expect(diagram.peak.value).toBe(-2.5)
    expect(diagram.peak.tip.toArray()).toEqual([5, 0, -1.5])
    expect(diagram.samples[0].tip.toArray()).toEqual([0, 0, 0])
    expect(diagram.samples[4].tip.toArray()).toEqual([10, 0, 0])
    expect(diagram.triangles.every(triangle => !triangle.positive)).toBe(true)
    expect(buildDiagram(response(values), element, 'M2', 2.5, 10, 2)!.peak.tip.z).toBe(-3)
  })
  it('retains cantilever end values and splits fill exactly at sign changes', () => {
    const cantilever = buildDiagram(response([-6, -3, 0]), element, 'M2', 6, 10)!
    expect(cantilever.peak.tip.z).toBe(-1.5)
    expect(cantilever.samples[2].tip.z).toBe(0)
    const reversing = buildDiagram(response([-2, 2]), element, 'M2', 2, 10)!
    expect(reversing.triangles.map(triangle => triangle.positive)).toEqual([false, true])
    expect(reversing.triangles[0].vertices.slice(6, 9)).toEqual([5, 0, 0])
  })
  it('does not invent samples or local axes for legacy data', () => {
    expect(buildDiagram(undefined, element, 'M2', 1, 10)).toBeNull()
    expect(buildDiagram(response([0, 1]), { ...element, localAxes: undefined }, 'M2', 1, 10)).toBeNull()
  })
  it('does not mistake out-of-plane 2D restraints or 3D rotational restraints for supports', () => {
    expect(classifySupport([false, true, false, true, false, true], 2)).toBe('none')
    expect(classifySupport([false, false, false, true, true, true], 3)).toBe('none')
    expect(classifySupport([false, true, false, true, true, true], 2)).toBe('partial')
  })
  it('keeps a sub-unit reaction colour range at its true maximum', () => {
    const activeCase = { id: 'D', label: 'D', kind: 'case' as const, nodeResults: { A: { reaction: { fz: 0.5 } } }, elementResults: {} }
    const max = Math.max(0, ...Object.keys(activeCase.nodeResults).map(id => getNodeReactionMagnitude(activeCase, id)))
    render(<ColorBar maxValue={max} label="Reaction" unit="kN" show />)
    expect(screen.getByTestId('visualization-legend')).toHaveTextContent('0.500')
    expect(screen.getByTestId('visualization-legend')).not.toHaveTextContent('1.00')
  })
  it('formats noise and small values with significant digits in both locales', () => {
    for (const locale of ['en', 'zh'] as const) {
      expect(formatResultNumber(-2.500000000000001, locale)).toBe('-2.50')
      expect(formatResultNumber(0.00000123456, locale)).toBe('0.000001235')
      expect(formatResultNumber(-0, locale)).toBe('0.00')
    }
  })
  it('moves the camera to front, side and top without changing its target', () => {
    const target: [number, number, number] = [3, 4, 5]
    expect(getPlaneCameraFrame('xy', 3, target, 10, 'front').position).toEqual([3, -6, 5])
    expect(getPlaneCameraFrame('xy', 3, target, 10, 'side').position).toEqual([13, 4, 5])
    expect(getPlaneCameraFrame('xy', 3, target, 10, 'top').position).toEqual([3, 4, 15])
  })
})
