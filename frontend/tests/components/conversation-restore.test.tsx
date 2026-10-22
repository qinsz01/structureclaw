import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mapBackendConversationMessages } from '@/components/chat/console/conversation-restore'
import { ToolCallCard } from '@/components/chat/tool-call-card'
import { messages } from '@/lib/i18n'

const recordedAt = '2026-10-22T13:03:52.729Z'
const failedBuild = { id: 'failed-build', role: 'tool', name: 'build_model', toolCallId: 'build-1',
  content: JSON.stringify({ success: false, errorCode: 'LLM_MODEL_VALIDATION_FAILED', error: "Load component 'fx' must be a finite number" }),
  createdAt: recordedAt }
const successfulBuild = { ...failedBuild, id: 'successful-build', toolCallId: 'build-2',
  content: JSON.stringify({ success: true, nodeCount: 2, elementCount: 1, skillId: 'generic' }) }

afterEach(cleanup)

describe('restored tool outcomes', () => {
  it.each(['zh', 'en'] as const)('keeps a failed attempt visibly failed after a later successful rebuild (%s)', locale => {
    const restored = mapBackendConversationMessages([failedBuild, successfulBuild])
    expect(restored.map(message => message.status)).toEqual(['error', 'done'])
    render(<>{restored.map(message => <ToolCallCard key={message.id} step={message.toolStep!} t={key => messages[locale][key]} />)}</>)
    expect(screen.getAllByText(messages[locale].toolError)).toHaveLength(1)
    expect(screen.getAllByText(messages[locale].toolCompleted)).toHaveLength(1)
    expect(screen.getByText(/LLM_MODEL_VALIDATION_FAILED/)).toBeInTheDocument()
    expect(restored[1].toolStep?.skillId).toBe('generic')
  })

  it.each([
    { valid: false, message: 'Missing units' },
    { status: 'failed', error_code: 'ENGINE_UNAVAILABLE', message: 'Engine unavailable' },
    { error: 'RUN_NOT_FOUND' },
  ])('restores structured tool failures without relying on prose: %j', output => {
    const restored = mapBackendConversationMessages([{ ...failedBuild, content: JSON.stringify(output) }])[0]
    expect(restored.status).toBe('error')
    expect(restored.toolStep?.status).toBe('error')
    expect(restored.toolStep?.errorMessage).toBeTruthy()
  })

  it('uses recorded error steps when the persisted output is plain text', () => {
    const step = { id: 'step-build-1', phase: 'modeling', status: 'error', tool: 'build_model',
      errorMessage: 'Candidate rejected', completedAt: '2026-10-22T13:01:46.819Z' }
    const restored = mapBackendConversationMessages([
      { ...failedBuild, content: 'Candidate rejected' },
      { id: 'final', role: 'assistant', content: 'Complete', createdAt: recordedAt, metadata: {
        presentation: { version: 3, mode: 'execution', status: 'done', summaryText: 'Complete',
          phases: [{ phaseId: 'phase-modeling', phase: 'modeling', status: 'error', steps: [step] }], artifacts: [] },
      } },
    ])
    expect(restored[0].toolStep).toMatchObject({ status: 'error', errorMessage: 'Candidate rejected', completedAt: step.completedAt })
  })

  it('keeps successful plain text and informational text completed', () => {
    const restored = mapBackendConversationMessages([{ ...successfulBuild, content: 'No error occurred.' }])[0]
    expect(restored.status).toBe('done')
    expect(restored.toolStep?.errorMessage).toBeUndefined()
  })
})
