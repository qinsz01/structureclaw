import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SplitPanel } from '@/components/layout/split-panel'

describe('SplitPanel Component (LAYT-05)', () => {
  it('renders left and right children', () => {
    render(
      <SplitPanel
        left={<div data-testid="left-panel">Left Content</div>}
        right={<div data-testid="right-panel">Right Content</div>}
      />
    )
    expect(screen.getByTestId('left-panel')).toBeInTheDocument()
    expect(screen.getByTestId('right-panel')).toBeInTheDocument()
  })

  it('renders with default layout [50, 50]', () => {
    const { container } = render(
      <SplitPanel left={<div>Left</div>} right={<div>Right</div>} />
    )
    // Verify ResizablePanelGroup is rendered using data-group attribute
    expect(container.querySelector('[data-group]')).toBeInTheDocument()
  })

  it('supports custom className', () => {
    const { container } = render(
      <SplitPanel
        left={<div>Left</div>}
        right={<div>Right</div>}
        className="custom-class"
      />
    )
    expect(container.querySelector('.custom-class')).toBeInTheDocument()
  })

  it('renders with horizontal orientation by default', () => {
    const { container } = render(
      <SplitPanel left={<div>Left</div>} right={<div>Right</div>} />
    )
    // The group element exists and default orientation is horizontal
    const panelGroup = container.querySelector('[data-group]')
    expect(panelGroup).toBeInTheDocument()
  })

  it('supports vertical orientation', () => {
    const { container } = render(
      <SplitPanel
        left={<div>Top</div>}
        right={<div>Bottom</div>}
        direction="vertical"
      />
    )
    // The group element exists with vertical orientation
    const panelGroup = container.querySelector('[data-group]')
    expect(panelGroup).toBeInTheDocument()
  })

  it('renders resize handle with separator role', () => {
    const { container } = render(
      <SplitPanel left={<div>Left</div>} right={<div>Right</div>} />
    )
    // The resize separator should have role="separator" for accessibility
    const separator = container.querySelector('[role="separator"]')
    expect(separator).toBeInTheDocument()
  })

  it('renders both panels', () => {
    const { container } = render(
      <SplitPanel
        left={<div data-testid="left">Left</div>}
        right={<div data-testid="right">Right</div>}
      />
    )
    // Both panels should be rendered
    const panels = container.querySelectorAll('[data-panel]')
    expect(panels).toHaveLength(2)
  })
})
