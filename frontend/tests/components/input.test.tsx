import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Input } from '@/components/ui/input'

describe('Input Component (COMP-03)', () => {
  it('renders input element with default styling', () => {
    render(<Input data-testid="input" />)
    const input = screen.getByTestId('input')
    expect(input).toBeInTheDocument()
    expect(input).toHaveClass('flex')
    expect(input).toHaveClass('h-10')
    expect(input).toHaveClass('rounded-md')
    expect(input).toHaveClass('border')
  })

  it('has focus-visible ring state using ring-ring color', async () => {
    const user = userEvent.setup()
    render(<Input data-testid="input" />)
    const input = screen.getByTestId('input')

    await user.click(input)
    expect(input).toHaveClass('focus-visible:ring-2')
    expect(input).toHaveClass('focus-visible:ring-ring')
  })

  it('applies disabled:cursor-not-allowed and disabled:opacity-50 when disabled', () => {
    render(<Input data-testid="input" disabled />)
    const input = screen.getByTestId('input')
    expect(input).toBeDisabled()
    expect(input).toHaveClass('disabled:cursor-not-allowed')
    expect(input).toHaveClass('disabled:opacity-50')
  })

  it('accepts custom className prop', () => {
    render(<Input data-testid="input" className="custom-class" />)
    const input = screen.getByTestId('input')
    expect(input).toHaveClass('custom-class')
  })

  it('forwards ref to input element', () => {
    const ref = { current: null as HTMLInputElement | null }
    render(<Input ref={ref} data-testid="input" />)
    expect(ref.current).toBeInstanceOf(HTMLInputElement)
  })
})
