import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleComposer } from '@/components/chat/console/console-composer'
import type { ConsoleState } from '@/components/chat/console/use-console-state'
import { runPolicyMessages } from '@/lib/i18n/messages/run-policy'

const skills = [{ id: 'generic', name: { en: 'Generic', zh: '通用结构类型' } }, { id: 'beam', name: { en: 'Beam', zh: '梁' } }]
const invoked = { routedSkillId: 'generic', usedSkillIds: ['generic'], builder: 'llm' }

function state(locale: 'en' | 'zh', modeling: unknown = invoked, overrides: Record<string, unknown> = {}) {
  const words = runPolicyMessages[locale]
  return {
    fileInputRef: { current: null }, composerTextareaRef: { current: null }, attachedFiles: [],
    t: (key: string) => words[key as keyof typeof words] ?? key,
    locale, runPolicy: {}, availableSkills: skills, selectedSkillIds: ['generic'], hasExplicitSkillSelection: true,
    sessionRuntime: { view: { usage: { runId: 'current' }, policy: { routing: { mode: 'auto' } }, modeling } },
    conversationId: 'current', input: '', allEngines: [], probeResults: {}, streamingSessions: new Map(),
    submittingRef: { current: false }, uploadingCount: 0, skillsLoaded: true, capabilityMatrixLoaded: true,
    ...overrides,
  } as unknown as ConsoleState
}

function composer(value: ConsoleState) {
  return <ConsoleComposer state={value} handleSubmit={vi.fn()} handleFileSelect={vi.fn()} />
}

afterEach(cleanup)

describe('skill scope and actual execution are distinct', () => {
  it.each(['en', 'zh'] as const)('shows the allowed scope and actual localized skill separately in %s', locale => {
    render(composer(state(locale)))
    const words = runPolicyMessages[locale], name = skills[0].name[locale]
    expect(screen.getByTestId('run-skill-summary')).toHaveTextContent(`${words.policyEffectiveScope}: ${name}`)
    expect(screen.getByTestId('run-used-skills')).toHaveTextContent(`${words.policyActualSkills}: ${name}`)
    expect(screen.getByTestId('run-used-skills')).not.toHaveTextContent(skills[1].name[locale])
  })

  it('does not describe a routing decision as an invoked skill', () => {
    render(composer(state('en', { ...invoked, usedSkillIds: [], builder: null })))
    expect(screen.getByTestId('run-used-skills')).toHaveTextContent('Routed to: Generic (Not invoked yet)')
  })

  it('does not infer usage from allowed skills when importing or analyzing an existing model', () => {
    render(composer(state('en', { routedSkillId: null, usedSkillIds: [], builder: 'explicit' })))
    expect(screen.getByTestId('run-skill-summary')).toHaveTextContent('Allowed skills: Generic')
    expect(screen.getByTestId('run-used-skills')).toHaveTextContent('No modelling skill invoked')
  })

  it('makes an explicitly empty scope clear without enabling generic', () => {
    render(composer(state('zh', { routedSkillId: null, usedSkillIds: [], builder: null }, { selectedSkillIds: [] })))
    expect(screen.getByTestId('run-skill-summary')).toHaveTextContent(runPolicyMessages.zh.policyScopeEmpty)
    expect(screen.getByTestId('run-used-skills')).toHaveTextContent('未调用建模技能')
  })

  it('keeps unavailable server records distinct from no skill invocation', () => {
    render(composer(state('en', null)))
    expect(screen.getByTestId('run-used-skills')).toHaveTextContent('Usage record unavailable')
    expect(screen.getByTestId('run-used-skills')).not.toHaveTextContent('No modelling skill invoked')
  })

  it('does not carry actual skill usage into another conversation', () => {
    const view = render(composer(state('en')))
    expect(screen.getByTestId('run-used-skills')).toHaveTextContent('Used this run: Generic')
    view.rerender(composer(state('en', null, { conversationId: 'new', sessionRuntime: { view: { usage: null } } })))
    expect(screen.getByTestId('run-used-skills')).toHaveTextContent('Not run yet')
    expect(screen.getByTestId('run-used-skills')).not.toHaveTextContent('Generic')
  })
})
