import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { VisualizationToolbar } from '@/components/visualization/toolbar'
import { createVizState, viewControls, vizReducer } from '@/components/visualization/state'
import type { VisualizationSnapshot, VisualizationViewMode } from '@/components/visualization/types'
import { messages } from '@/lib/i18n'

const snapshot: VisualizationSnapshot = { version: 1, title: 'Test', source: 'result', dimension: 2, plane: 'xz',
  availableViews: ['model', 'deformed', 'forces', 'reactions'], defaultCaseId: 'D', nodes: [], elements: [], unsupportedElementTypes: [],
  loads: [{ nodeId: 'B', caseId: 'D', vector: { x: 0, y: 0, z: -1 } }], cases: [{ id: 'D', label: 'D', kind: 'case', nodeResults: {}, elementResults: {},
    memberResponses: { E: { id: 'E', state: 'recovered', length: 1, reason: '', samples: [{ x: 0, position: [0, 0, 0], N: 0, V2: 0, V3: 1, T: 0, M2: 2, M3: 0 }] } } }] }
const range = { min: 1, max: 40, step: 0.1 }

describe('viewer controls and session state', () => {
  it.each(['en', 'zh'] as const)('shows exactly the applicable controls in %s', locale => {
    const t = (key: keyof typeof messages.en) => messages[locale][key]
    const { rerender } = render(<VisualizationToolbar snapshot={snapshot} state={createVizState()} scaleRange={range} onChange={vi.fn()} t={t} />)
    for (const view of ['model', 'deformed', 'forces', 'reactions'] as VisualizationViewMode[]) {
      rerender(<VisualizationToolbar snapshot={snapshot} state={createVizState('', { view })} scaleRange={range} onChange={vi.fn()} t={t} />)
      const controls = viewControls(view, true)
      expect(screen.queryByRole('button', { name: t('visualizationUndeformedOverlay') }) !== null).toBe(controls.deformation)
      expect(screen.queryByRole('button', { name: t('visualizationShowLoads') }) !== null).toBe(controls.loads)
      expect(screen.queryByRole('button', { name: t('visualizationLegend') }) !== null).toBe(controls.legend)
      expect(screen.queryByRole('slider') !== null).toBe(controls.deformation || controls.diagram)
      expect(screen.queryByRole('button', { name: /M2 ·/ }) !== null).toBe(controls.diagram)
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    }
  })
  it('unlocks all supplied 3D components and only exposes in-plane 2D components', () => {
    const onChange = vi.fn(), t = (key: keyof typeof messages.en) => messages.en[key]
    const props = { state: createVizState('', { view: 'forces' }), scaleRange: range, onChange, t }
    const { rerender } = render(<VisualizationToolbar {...props} snapshot={snapshot} />)
    expect(screen.queryByRole('button', { name: /M3 ·/ })).not.toBeInTheDocument()
    rerender(<VisualizationToolbar {...props} snapshot={{ ...snapshot, dimension: 3 }} />)
    for (const component of ['N', 'V2', 'V3', 'T', 'M2', 'M3']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${component} ·`) }))
      expect(onChange).toHaveBeenLastCalledWith({ component })
    }
  })
  it('does not show deformation controls for a force-only placeholder or loads without data', () => {
    const t = (key: keyof typeof messages.en) => messages.en[key]
    render(<VisualizationToolbar snapshot={{ ...snapshot, loads: [], availableViews: ['model', 'forces'] }} state={createVizState()} scaleRange={range} onChange={vi.fn()} t={t} />)
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(screen.queryByText('Original shape')).not.toBeInTheDocument()
    expect(screen.queryByText('Load Markers')).not.toBeInTheDocument()
  })
  it('persists within a figure and resets every display setting for a different figure', () => {
    const changed = createVizState('run1:D', { view: 'forces', diagramScale: 2, deformScale: 100, showOriginal: false, showLoads: false, showLegend: false, showNodeLabels: true, selection: { kind: 'member', id: 'E' } })
    expect(vizReducer(changed, { type: 'open', key: 'run1:D', initial: {} })).toBe(changed)
    expect(vizReducer(changed, { type: 'open', key: 'run2:L', initial: { deformScale: 7 } })).toEqual(createVizState('run2:L', { deformScale: 7 }))
  })
})
