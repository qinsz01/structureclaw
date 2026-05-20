import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ToolCallCard } from '@/components/chat/tool-call-card'
import type { TimelineStepItem } from '@/components/chat/message-presentation'
import { messages } from '@/lib/i18n'

const t = (key: keyof typeof messages.en) => messages.en[key]

describe('detached-house tool card plan viewer', () => {
  it('shows an inline plan viewer for detached-house tool snapshots', () => {
    const step: TimelineStepItem = {
      id: 'step-1',
      phase: 'modeling',
      status: 'done',
      tool: 'detached_house_generate_floor_rooms',
      title: 'detached_house_generate_floor_rooms',
      output: '{"success":true}',
      designSnapshot: {
        design: {
          version: '0.1',
          floors: [
            {
              id: 'F1',
              outline: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]],
              rooms: [
                { id: 'R1', type: 'living', polygon: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]] },
              ],
            },
          ],
        },
      },
    }

    render(<ToolCallCard step={step} t={t} attached />)

    fireEvent.click(screen.getByRole('button', { name: /view plan/i }))

    expect(screen.getByText('F1')).toBeInTheDocument()
    expect(screen.getByLabelText('Detached house plan preview')).toBeInTheDocument()
  })

  it('draws door and window openings using API offset values', () => {
    const step: TimelineStepItem = {
      id: 'step-1',
      phase: 'modeling',
      status: 'done',
      tool: 'detached_house_place_doors_windows',
      title: 'detached_house_place_doors_windows',
      output: '{"success":true}',
      designSnapshot: {
        design: {
          version: '0.1',
          floors: [
            {
              id: 'F1',
              outline: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]],
              walls: [
                { id: 'W1', line: [0, 0, 6000, 0], kind: 'exterior' },
              ],
              openings: [
                { id: 'WIN1', type: 'window', wall_id: 'W1', offset: 3000, width: 1000 },
              ],
            },
          ],
        },
      },
    }

    const { container } = render(<ToolCallCard step={step} t={t} attached />)

    fireEvent.click(screen.getByRole('button', { name: /view plan/i }))

    const opening = container.querySelector('[data-opening-id="WIN1"]')
    expect(opening).toBeInTheDocument()
    expect(Number(opening?.getAttribute('x1'))).toBeGreaterThan(400)
  })

  it('shows a diagnostic when openings cannot be drawn because walls are missing', () => {
    const step: TimelineStepItem = {
      id: 'step-1',
      phase: 'modeling',
      status: 'done',
      tool: 'detached_house_place_doors_windows',
      title: 'detached_house_place_doors_windows',
      output: '{"success":true}',
      designSnapshot: {
        design: {
          version: '0.1',
          floors: [
            {
              id: 'F1',
              outline: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]],
              rooms: [
                { id: 'R1', type: 'living', polygon: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]] },
              ],
              walls: [],
              openings: [
                { id: 'D1', type: 'door', wall_id: 'W1', offset: 1000, width: 900 },
              ],
            },
          ],
        },
      },
    }

    render(<ToolCallCard step={step} t={t} attached />)

    fireEvent.click(screen.getByRole('button', { name: /view plan/i }))

    expect(screen.getByText(/Openings exist but this floor has no walls/i)).toBeInTheDocument()
  })

  it('shows diagnostics for invalid wall and opening schema', () => {
    const step: TimelineStepItem = {
      id: 'step-1',
      phase: 'modeling',
      status: 'done',
      tool: 'detached_house_place_doors_windows',
      title: 'detached_house_place_doors_windows',
      output: '{"success":true}',
      designSnapshot: {
        design: {
          version: '0.1',
          floors: [
            {
              id: 'F1',
              outline: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]],
              walls: [
                { wall_id: 'W1', line: [0, 0, 6000, 0], kind: 'exterior' },
              ],
              openings: [
                { opening_id: 'D1', type: 'door', wall_id: 'W1' },
              ],
            },
          ],
        },
      },
    }

    render(<ToolCallCard step={step} t={t} attached />)

    fireEvent.click(screen.getByRole('button', { name: /view plan/i }))

    expect(screen.getByText(/1 wall\(s\) have invalid id\/line\/kind schema/i)).toBeInTheDocument()
    expect(screen.getByText(/1 opening\(s\) have invalid id\/type\/wall_id schema/i)).toBeInTheDocument()
  })
})
