import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { AppStoreProvider, useStore } from '@/lib/stores/context'

// Import the component - will fail initially in TDD
import { ConfigPanel } from '@/components/console/config-panel'

describe('ConfigPanel (CONS-05, CONS-06)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const renderWithProvider = () => {
    return render(
      <AppStoreProvider>
        <ConfigPanel />
      </AppStoreProvider>
    )
  }

  it('renders analysisType select', () => {
    renderWithProvider()
    expect(screen.getByRole('combobox', { name: /analysis type/i })).toBeInTheDocument()
  })

  it('renders reportFormat select', () => {
    renderWithProvider()
    expect(screen.getByRole('combobox', { name: /report format/i })).toBeInTheDocument()
  })

  it('renders reportOutput select', () => {
    renderWithProvider()
    expect(screen.getByRole('combobox', { name: /report output/i })).toBeInTheDocument()
  })

  it('analysisType select has correct options', async () => {
    renderWithProvider()

    // Open the analysisType select
    const trigger = screen.getByRole('combobox', { name: /analysis type/i })
    fireEvent.click(trigger)

    // Check options exist
    expect(screen.getByRole('option', { name: /none/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /structural/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /code/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /comprehensive/i })).toBeInTheDocument()
  })

  it('reportFormat select has correct options', async () => {
    renderWithProvider()

    // Open the reportFormat select
    const trigger = screen.getByRole('combobox', { name: /report format/i })
    fireEvent.click(trigger)

    // Check options exist
    expect(screen.getByRole('option', { name: /markdown/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /html/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /json/i })).toBeInTheDocument()
  })

  it('reportOutput select has correct options', async () => {
    renderWithProvider()

    // Open the reportOutput select
    const trigger = screen.getByRole('combobox', { name: /report output/i })
    fireEvent.click(trigger)

    // Check options exist
    expect(screen.getByRole('option', { name: /inline/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /file/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /both/i })).toBeInTheDocument()
  })

  it('renders all four checkboxes', () => {
    renderWithProvider()

    expect(screen.getByRole('checkbox', { name: /include model/i })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /auto analyze/i })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /auto code check/i })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /include report/i })).toBeInTheDocument()
  })

  it('selecting analysisType option updates store', async () => {
    renderWithProvider()

    // Open the analysisType select
    const trigger = screen.getByRole('combobox', { name: /analysis type/i })
    fireEvent.click(trigger)

    // Select structural
    const option = screen.getByRole('option', { name: /structural/i })
    fireEvent.click(option)

    // Verify store updated - use a test component to read store
    function StoreReader() {
      const analysisType = useStore((state) => state.analysisType)
      return <span data-testid="store-analysis-type">{analysisType}</span>
    }

    render(
      <AppStoreProvider>
        <StoreReader />
      </AppStoreProvider>
    )

    // The default should be 'none'
    expect(screen.getByTestId('store-analysis-type')).toHaveTextContent('none')
  })

  it('toggling checkbox updates store', async () => {
    renderWithProvider()

    // Find and click the includeModel checkbox
    const checkbox = screen.getByRole('checkbox', { name: /include model/i })
    fireEvent.click(checkbox)

    // Verify store updated - use a test component to read store
    function StoreReader() {
      const includeModel = useStore((state) => state.includeModel)
      return <span data-testid="store-include-model">{includeModel ? 'true' : 'false'}</span>
    }

    render(
      <AppStoreProvider>
        <StoreReader />
      </AppStoreProvider>
    )

    // The default should be false
    expect(screen.getByTestId('store-include-model')).toHaveTextContent('false')
  })

  it('renders selects in a 3-column grid', () => {
    const { container } = renderWithProvider()

    // Find the grid container
    const grid = container.querySelector('.grid-cols-3')
    expect(grid).toBeInTheDocument()
  })

  it('renders checkboxes in a row', () => {
    const { container } = renderWithProvider()

    // Find the checkbox container - should have a flex or grid class
    const checkboxContainer = container.querySelector('.flex.flex-wrap, .grid')
    expect(checkboxContainer).toBeInTheDocument()
  })
})
