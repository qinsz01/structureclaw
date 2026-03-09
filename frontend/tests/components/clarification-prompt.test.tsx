import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ClarificationPrompt } from '@/components/console/clarification-prompt'
import type { Clarification } from '@/lib/api/contracts/agent'

/**
 * ClarificationPrompt Component Tests
 *
 * Tests for clarification prompt component with accessibility features:
 * - aria-live="polite" for screen reader announcement
 * - role="region" for semantic structure
 * - Proper aria-label for identification
 */
describe('ClarificationPrompt', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('rendering', () => {
    it('returns null when no clarification is provided', () => {
      render(<ClarificationPrompt clarification={undefined} />)
      expect(screen.queryByLabelText(/clarification needed/i)).not.toBeInTheDocument()
    })

    it('returns null when clarification has no question', () => {
      const clarification: Clarification = { question: undefined }
      render(<ClarificationPrompt clarification={clarification} />)
      expect(screen.queryByLabelText(/clarification needed/i)).not.toBeInTheDocument()
    })

    it('renders question when clarification is provided', () => {
      const clarification: Clarification = { question: 'Missing parameter?' }
      render(<ClarificationPrompt clarification={clarification} />)
      expect(screen.getByText('Missing parameter?')).toBeInTheDocument()
    })

    it('renders missing fields when provided', () => {
      const clarification: Clarification = {
        question: 'Missing info?',
        missingFields: ['field1', 'field2'],
      }
      render(<ClarificationPrompt clarification={clarification} />)
      expect(screen.getByText('field1')).toBeInTheDocument()
      expect(screen.getByText('field2')).toBeInTheDocument()
    })

    it('does not render missing fields section when empty', () => {
      const clarification: Clarification = {
        question: 'Question?',
        missingFields: [],
      }
      render(<ClarificationPrompt clarification={clarification} />)
      expect(screen.queryByText(/missing fields/i)).not.toBeInTheDocument()
    })
  })

  describe('accessibility', () => {
    it('has aria-live="polite"', () => {
      const clarification: Clarification = { question: 'Missing parameter?' }
      render(<ClarificationPrompt clarification={clarification} />)
      const prompt = screen.getByLabelText(/clarification needed/i)
      expect(prompt).toHaveAttribute('aria-live', 'polite')
    })

    it('has role="region"', () => {
      const clarification: Clarification = { question: 'Missing parameter?' }
      render(<ClarificationPrompt clarification={clarification} />)
      const prompt = screen.getByLabelText(/clarification needed/i)
      expect(prompt).toHaveAttribute('role', 'region')
    })

    it('has aria-label for identification', () => {
      const clarification: Clarification = { question: 'Missing parameter?' }
      render(<ClarificationPrompt clarification={clarification} />)
      const prompt = screen.getByLabelText(/clarification needed/i)
      expect(prompt).toBeInTheDocument()
    })

    it('has aria-hidden="true" on the icon (decorative)', () => {
      const clarification: Clarification = { question: 'Missing parameter?' }
      render(<ClarificationPrompt clarification={clarification} />)
      const prompt = screen.getByLabelText(/clarification needed/i)
      const icon = prompt.querySelector('svg')
      expect(icon).toHaveAttribute('aria-hidden', 'true')
    })
  })

  describe('styling', () => {
    it('uses amber warning styling', () => {
      const clarification: Clarification = { question: 'Warning?' }
      render(<ClarificationPrompt clarification={clarification} />)
      const prompt = screen.getByLabelText(/clarification needed/i)
      expect(prompt.className).toContain('amber')
    })

    it('accepts custom className', () => {
      const clarification: Clarification = { question: 'Warning?' }
      render(<ClarificationPrompt clarification={clarification} className="custom-class" />)
      const prompt = screen.getByLabelText(/clarification needed/i)
      expect(prompt.className).toContain('custom-class')
    })
  })
})
