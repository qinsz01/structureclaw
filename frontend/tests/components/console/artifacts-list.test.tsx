import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ArtifactsList } from '@/components/console/artifacts-list'
import type { Artifact } from '@/lib/api/contracts/agent'

describe('ArtifactsList (CONS-11)', () => {
  const sampleArtifacts: Artifact[] = [
    { format: 'markdown', path: '/output/report.md' },
    { format: 'json', path: '/output/data.json' },
  ]

  it('returns null when no artifacts (undefined)', () => {
    const { container } = render(<ArtifactsList artifacts={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('returns null when empty array', () => {
    const { container } = render(<ArtifactsList artifacts={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders all artifacts when provided', () => {
    render(<ArtifactsList artifacts={sampleArtifacts} />)

    expect(screen.getByText('Artifacts')).toBeInTheDocument()
    expect(screen.getByText(/markdown/)).toBeInTheDocument()
    expect(screen.getByText(/\/output\/report\.md/)).toBeInTheDocument()
    expect(screen.getByText(/json/)).toBeInTheDocument()
    expect(screen.getByText(/\/output\/data\.json/)).toBeInTheDocument()
  })

  it('displays format and path for each artifact', () => {
    render(<ArtifactsList artifacts={sampleArtifacts} />)

    // Check that format: path pattern is displayed
    expect(screen.getByText(/markdown.*\/output\/report\.md/)).toBeInTheDocument()
    expect(screen.getByText(/json.*\/output\/data\.json/)).toBeInTheDocument()
  })

  it('renders artifacts in a list structure', () => {
    const { container } = render(<ArtifactsList artifacts={sampleArtifacts} />)

    // Should have list items
    const listItems = container.querySelectorAll('li')
    expect(listItems.length).toBe(2)
  })
})
