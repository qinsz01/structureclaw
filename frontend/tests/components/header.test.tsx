import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Header } from '@/components/layout/header'
import { SidebarProvider } from '@/components/ui/sidebar'

// Mock next/navigation
const mockUsePathname = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}))

// Polyfills for Radix UI
beforeAll(() => {
  // @ts-expect-error - polyfill for Radix UI
  window.HTMLElement.prototype.hasPointerCapture = vi.fn()
  // @ts-expect-error - polyfill for Radix UI
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  // @ts-expect-error - polyfill for Radix UI
  window.HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON: () => {},
  }))

  // Mock matchMedia for use-mobile hook
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe('Header Component (LAYT-02)', () => {
  it('renders SidebarTrigger for sidebar toggle', () => {
    mockUsePathname.mockReturnValue('/console')
    render(
      <SidebarProvider>
        <Header />
      </SidebarProvider>
    )

    // SidebarTrigger has an accessible name "Toggle Sidebar"
    const trigger = screen.getByRole('button', { name: /toggle sidebar/i })
    expect(trigger).toBeInTheDocument()
  })

  it('displays current page context based on pathname', () => {
    mockUsePathname.mockReturnValue('/console')
    render(
      <SidebarProvider>
        <Header />
      </SidebarProvider>
    )

    expect(screen.getByText('Agent Console')).toBeInTheDocument()
  })

  it('displays default context for non-console pages', () => {
    mockUsePathname.mockReturnValue('/')
    render(
      <SidebarProvider>
        <Header />
      </SidebarProvider>
    )

    expect(screen.getByText('StructureClaw')).toBeInTheDocument()
  })

  it('includes ThemeToggle component', () => {
    mockUsePathname.mockReturnValue('/console')
    render(
      <SidebarProvider>
        <Header />
      </SidebarProvider>
    )

    // ThemeToggle has a button with sr-only text
    const themeButton = screen.getByRole('button', { name: /toggle theme/i })
    expect(themeButton).toBeInTheDocument()
  })

  it('has sticky positioning and border styling', () => {
    mockUsePathname.mockReturnValue('/console')
    const { container } = render(
      <SidebarProvider>
        <Header />
      </SidebarProvider>
    )

    const header = container.querySelector('header')
    expect(header).toBeInTheDocument()
    expect(header).toHaveClass('sticky')
    expect(header).toHaveClass('border-b')
  })
})
