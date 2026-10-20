import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StructuralVisualizationModal } from '@/components/visualization/modal'
import { messages } from '@/lib/i18n'
import type { VisualizationSnapshot } from '@/components/visualization/types'

const t = (key: keyof typeof messages.en) => messages.en[key]

const modelSnapshot: VisualizationSnapshot = {
  version: 1,
  title: 'Model Preview',
  source: 'model',
  dimension: 2,
  plane: 'xz',
  availableViews: ['model'],
  defaultCaseId: 'model',
  statusMessage: 'Preview is using the last valid model because the current JSON could not be parsed.',
  nodes: [
    { id: '1', position: { x: 0, y: 0, z: 0 }, restraints: [true, true, true, true, true, true] },
    { id: '2', position: { x: 6, y: 0, z: 0 } },
  ],
  elements: [
    { id: 'E1', type: 'beam', nodeIds: ['1', '2'], material: 'M1', section: 'S1' },
  ],
  loads: [{ nodeId: '2', kind: 'nodal', caseId: 'L1', vector: { x: 0, y: 0, z: -10 } }],
  unsupportedElementTypes: [],
  cases: [
    {
      id: 'model',
      label: 'Model',
      kind: 'result',
      nodeResults: {},
      elementResults: {},
    },
  ],
}

describe('StructuralVisualizationModal', () => {
  it.each(['en', 'zh'] as const)('lets the workspace switch the read-only case without borrowing views or loads in %s', locale => {
    const localized = (key: keyof typeof messages.en) => messages[locale][key]
    const snapshot: VisualizationSnapshot = { ...modelSnapshot, source: 'result', defaultCaseId: 'case:D',
      availableViews: ['model', 'deformed'], loads: [{ kind: 'point', elementId: 'E1', position: 2, caseId: 'case:D', vector: { x: 0, y: 0, z: -3 } }],
      cases: [
        { id: 'case:D', label: 'D', kind: 'case', resultStatus: 'available', availableViews: ['model', 'deformed'], nodeResults: { '2': { displacement: { uz: -0.01 } } }, elementResults: {} },
        { id: 'case:L', label: 'L', kind: 'case', resultStatus: 'unavailable', availableViews: ['model'], nodeResults: {}, elementResults: {} },
      ] }
    const onChangeCase = vi.fn()
    const { rerender } = render(<StructuralVisualizationModal locale={locale} onClose={() => undefined} onChangeCase={onChangeCase} open snapshot={snapshot} t={localized} />)
    fireEvent.click(screen.getByRole('button', { name: 'E1 · P' }))
    expect(screen.getByText(`${localized('visualizationMemberLoadPosition')}: 2`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: localized('visualizationViewDeformed') }))
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: localized('visualizationChangeCase') }))
    expect(onChangeCase).toHaveBeenCalledOnce()
    rerender(<StructuralVisualizationModal locale={locale} onClose={() => undefined} open snapshot={{ ...snapshot, defaultCaseId: 'case:L' }} t={localized} />)
    expect(screen.queryByRole('button', { name: localized('visualizationViewDeformed') })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'E1 · P' })).not.toBeInTheDocument()
    expect(screen.getByText(localized('visualizationUnavailable'))).toBeInTheDocument()
  })
  it.each(['en', 'zh'] as const)('labels member interpolation in %s and scales from interior displacement', (locale) => {
    const localized = (key: keyof typeof messages.en) => messages[locale][key]
    const snapshot: VisualizationSnapshot = { ...modelSnapshot, source: 'result', availableViews: ['model', 'deformed'],
      cases: [{ ...modelSnapshot.cases[0], nodeResults: {}, memberResponses: { E1: {
        id: 'E1', state: 'interpolated', reason: 'stiffness', length: 6,
        samples: [
          { x: 0, position: [0, 0, 0], displacement: [0, 0, 0] },
          { x: 3, position: [3, 0, 0], displacement: [0, 0, -0.01] },
          { x: 6, position: [6, 0, 0], displacement: [0, 0, 0] },
        ],
      } } }],
    }
    render(<StructuralVisualizationModal locale={locale} onClose={() => undefined} open snapshot={snapshot} t={localized} />)
    fireEvent.click(screen.getByRole('button', { name: 'E1' }))
    expect(screen.getByText(localized('visualizationMemberInterpolated'))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: localized('visualizationViewDeformed') }))
    expect(Number((screen.getByRole('slider') as HTMLInputElement).value)).toBeGreaterThan(12)
  })

  it('renders model-only preview state with list-based selection', () => {
    render(
      <StructuralVisualizationModal
        locale="en"
        onClose={() => undefined}
        open
        snapshot={modelSnapshot}
        t={t}
      />
    )

    expect(screen.getByText('Current Source: Model Preview')).toBeInTheDocument()
    expect(screen.getAllByText(modelSnapshot.statusMessage as string)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Deformed' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load Markers' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '1' }))
    expect(screen.getByText('Selected Node')).toBeInTheDocument()
    expect(screen.getByText(/Restraints:/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'E1' }))
    expect(screen.getByText('Selected Element')).toBeInTheDocument()
    expect(screen.getByText(/Connected Nodes: 1 - 2/)).toBeInTheDocument()
  })

  it('opens a canonical 3D snapshot with the isometric camera selected by default', () => {
    render(
      <StructuralVisualizationModal
        locale="en"
        onClose={() => undefined}
        open
        snapshot={{ ...modelSnapshot, dimension: 3, plane: 'xy' }}
        t={t}
      />
    )

    expect(screen.getByRole('button', { name: 'Iso' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Front' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Side' })).toBeInTheDocument()
  })
})

it.each(['en', 'zh'] as const)('queries the inspected object without closing the viewer in %s', locale => {
  const onClose = vi.fn(), query = vi.fn(), t = (key: keyof typeof messages.en) => messages[locale][key]
  const { rerender } = render(<StructuralVisualizationModal locale={locale} onClose={onClose} onQueryObject={query} open snapshot={modelSnapshot} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '2', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: t('visualizationQueryObject') }))
  expect(query).toHaveBeenCalledWith({ kind: 'node', id: '2' })
  rerender(<StructuralVisualizationModal locale={locale} onClose={onClose} onQueryObject={query} queryResult="uz = -1.52 mm" open snapshot={modelSnapshot} t={t} />)
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.getByTestId('visualization-query-result')).toHaveTextContent('uz = -1.52 mm')
})
