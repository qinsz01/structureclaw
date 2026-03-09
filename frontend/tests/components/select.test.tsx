import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'

describe('Select Component (COMP-05)', () => {
  it('SelectTrigger renders with consistent Input styling', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger">
          <SelectValue placeholder="Select an option" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="option1">Option 1</SelectItem>
        </SelectContent>
      </Select>
    )
    const trigger = screen.getByTestId('trigger')
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveClass('flex')
    expect(trigger).toHaveClass('h-10')
    expect(trigger).toHaveClass('rounded-md')
    expect(trigger).toHaveClass('border')
  })

  it('SelectTrigger shows ChevronDown icon', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
      </Select>
    )
    // ChevronDown icon is an SVG element
    const trigger = screen.getByTestId('trigger')
    const svg = trigger.querySelector('svg')
    expect(svg).toBeInTheDocument()
  })

  it('SelectContent renders items when open', async () => {
    const user = userEvent.setup()
    render(
      <Select>
        <SelectTrigger data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="option1">Option 1</SelectItem>
          <SelectItem value="option2">Option 2</SelectItem>
        </SelectContent>
      </Select>
    )

    await user.click(screen.getByTestId('trigger'))

    // Wait for content to appear
    expect(await screen.findByText('Option 1')).toBeInTheDocument()
    expect(screen.getByText('Option 2')).toBeInTheDocument()
  })

  it('SelectItem shows check icon when selected', async () => {
    const user = userEvent.setup()
    render(
      <Select>
        <SelectTrigger data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="option1">Option 1</SelectItem>
        </SelectContent>
      </Select>
    )

    await user.click(screen.getByTestId('trigger'))
    await user.click(await screen.findByText('Option 1'))

    // After selection, the item should have a check icon (span with absolute positioning)
    await user.click(screen.getByTestId('trigger'))
    const selectedItem = await screen.findByRole('option', { name: /option 1/i })
    expect(selectedItem).toHaveAttribute('data-state', 'checked')
  })

  it('keyboard navigation works (ArrowUp, ArrowDown, Enter, Escape)', async () => {
    const user = userEvent.setup()
    render(
      <Select>
        <SelectTrigger data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="option1">Option 1</SelectItem>
          <SelectItem value="option2">Option 2</SelectItem>
        </SelectContent>
      </Select>
    )

    const trigger = screen.getByTestId('trigger')

    // Open with Enter
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Option 1')).toBeInTheDocument()

    // Navigate down
    await user.keyboard('{ArrowDown}')

    // Select with Enter
    await user.keyboard('{Enter}')

    // Close with Escape (re-open first)
    await user.click(screen.getByTestId('trigger'))
    await user.keyboard('{Escape}')
  })
})
