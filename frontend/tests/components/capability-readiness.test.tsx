import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityReadinessPanel } from '@/components/chat/capability-readiness-panel'
import { messages } from '@/lib/i18n'

const state = vi.hoisted(() => ({ locale: 'en' as 'en' | 'zh' }))
vi.mock('@/lib/i18n', async (original) => {
  const module = await original<typeof import('@/lib/i18n')>()
  return { ...module, useI18n: () => ({ locale: state.locale, t: (key: keyof typeof module.messages.en) => module.messages[state.locale][key] }) }
})
afterEach(cleanup)

describe.each(['en', 'zh'] as const)('capability readiness in %s', locale => {
  it('keeps implementation, environment and current task claims separate', () => {
    state.locale = locale
    const t = messages[locale]
    render(<CapabilityReadinessPanel matrix={{
      skills: [{ id: 'opensees-static', domain: 'analysis', name: { en: 'Static', zh: '静力' }, implementationScope: { en: 'Linear frames only', zh: '仅线弹性杆系' } }],
      engines: [{ id: 'unknown-engine' }, { id: 'available-engine', environment: { status: 'available', scope: 'environment-readiness-only' } }],
      currentAssessment: { status: 'not_assessed', issues: [] },
    }} conversations={[]} conversationId="" onConversationChange={() => {}} loading={false} failed={false} />)
    expect(screen.getByRole('heading', { name: t.readinessImplementation })).toBeVisible()
    expect(screen.getByRole('heading', { name: t.readinessEnvironment })).toBeVisible()
    expect(screen.getByText(t.readinessUnknown)).toBeVisible()
    expect(screen.getByText(t.readinessAvailable)).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(t.readinessNotAssessed)
    expect(screen.queryByText(t.readinessCurrentResult)).not.toBeInTheDocument()
  })
  it('shows explicit task issues and selects a conversation only on user action', () => {
    state.locale = locale
    const changed = vi.fn()
    render(<CapabilityReadinessPanel matrix={{currentAssessment:{status:'needs_attention',conversationId:'c',modelRevision:3,runId:'r',
      issues:[{kind:'input',field:'nodes.A.restraints',reason:'missing'}]}}}
      conversations={[{id:'c',title:'Frame'}]} conversationId="c" onConversationChange={changed} loading={false} failed={false} />)
    expect(changed).not.toHaveBeenCalled()
    expect(screen.getByText('nodes.A.restraints')).toBeVisible()
    expect(screen.getByText('missing')).toBeVisible()
    fireEvent.change(screen.getByRole('combobox'),{target:{value:''}})
    expect(changed).toHaveBeenCalledWith('')
  })
  it('a failed refresh cannot display stale current-task success', () => {
    state.locale = locale
    render(<CapabilityReadinessPanel matrix={{currentAssessment:{status:'current_result',conversationId:'c',runId:'old'}}}
      conversations={[]} conversationId="c" onConversationChange={() => {}} loading={false} failed />)
    expect(screen.getByRole('status')).toHaveTextContent(messages[locale].readinessLoadFailed)
    expect(screen.queryByText(messages[locale].readinessCurrentResult)).not.toBeInTheDocument()
    expect(screen.queryByText(/old/)).not.toBeInTheDocument()
  })
})
