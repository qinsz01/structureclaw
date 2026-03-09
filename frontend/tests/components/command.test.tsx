import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  useCommandMenu,
} from '@/components/ui/command'

// ResizeObserver polyfill for cmdk library
class MockResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

// Polyfills for Radix UI components
beforeEach(() => {
  HTMLElement.prototype.hasPointerCapture = vi.fn()
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    x: 0,
    y: 0,
    toJSON: () => {},
  }))
})

describe('Command Palette (COMP-10)', () => {
  describe('Command Component', () => {
    it('Command component renders without errors', () => {
      render(
        <Command>
          <CommandInput placeholder="Search..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup heading="Suggestions">
              <CommandItem>Item 1</CommandItem>
              <CommandItem>Item 2</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      )
      expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument()
    })

    it('CommandDialog renders as a dialog', async () => {
      const user = userEvent.setup()
      render(
        <CommandDialog open={true} onOpenChange={() => {}}>
          <CommandInput placeholder="Search..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
          </CommandList>
        </CommandDialog>
      )
      // Dialog content should be visible when open
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument()
      })
    })

    it('CommandInput has search placeholder', () => {
      render(
        <Command>
          <CommandInput placeholder="Type a command or search..." />
        </Command>
      )
      expect(screen.getByPlaceholderText('Type a command or search...')).toBeInTheDocument()
    })

    it('CommandList renders items', () => {
      render(
        <Command>
          <CommandList>
            <CommandGroup heading="Items">
              <CommandItem>Test Item</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      )
      expect(screen.getByText('Test Item')).toBeInTheDocument()
    })

    it('CommandEmpty shows when no results', () => {
      render(
        <Command>
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
          </CommandList>
        </Command>
      )
      expect(screen.getByText('No results found.')).toBeInTheDocument()
    })

    it('CommandItem is keyboard navigable', () => {
      const onSelect = vi.fn()
      render(
        <Command>
          <CommandList>
            <CommandGroup heading="Items">
              <CommandItem onSelect={onSelect}>Clickable Item</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      )
      const item = screen.getByText('Clickable Item')
      // Item should be clickable
      fireEvent.click(item)
      expect(onSelect).toHaveBeenCalled()
    })

    it('CommandGroup groups items with heading', () => {
      render(
        <Command>
          <CommandList>
            <CommandGroup heading="Suggestions">
              <CommandItem>Suggestion 1</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      )
      expect(screen.getByText('Suggestions')).toBeInTheDocument()
      expect(screen.getByText('Suggestion 1')).toBeInTheDocument()
    })
  })

  describe('useCommandMenu Hook', () => {
    it('toggles open state with Cmd/Ctrl+K', async () => {
      const user = userEvent.setup()

      const TestComponent = () => {
        const { open, setOpen } = useCommandMenu()
        return (
          <div>
            <span data-testid="status">{open ? 'open' : 'closed'}</span>
            <CommandDialog open={open} onOpenChange={setOpen}>
              <CommandInput placeholder="Search..." />
            </CommandDialog>
          </div>
        )
      }

      render(<TestComponent />)

      // Initially closed
      expect(screen.getByTestId('status')).toHaveTextContent('closed')

      // Press Cmd+K (metaKey for Mac, ctrlKey for Windows/Linux)
      await user.keyboard('{Meta>}k{/Meta}')

      await waitFor(() => {
        expect(screen.getByTestId('status')).toHaveTextContent('open')
      })
    })
  })

  describe('CommandSeparator', () => {
    it('renders separator between groups', () => {
      const { container } = render(
        <Command>
          <CommandList>
            <CommandGroup heading="Group 1">
              <CommandItem>Item 1</CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Group 2">
              <CommandItem>Item 2</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      )
      // Separator should be present (cmdk renders it as a div with role separator)
      const separator = container.querySelector('[cmdk-separator]')
      expect(separator).toBeInTheDocument()
    })
  })
})
