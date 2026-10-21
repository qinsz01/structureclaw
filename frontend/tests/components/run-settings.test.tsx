import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunSettings } from '@/components/chat/run-settings'
import { AppStoreContext, createAppStore } from '@/lib/stores/context'
import { messages } from '@/lib/i18n'
import type { ConversationRuntimeSnapshot } from '@/components/chat/use-conversation-runtime'

afterEach(() => { cleanup(); localStorage.clear(); document.cookie = 'structureclaw.locale=; Max-Age=0; path=/' })
const snapshot = { conversationId: 'a', modelRevision: 4, busy: false, waitingForReply: false, jobs: [],
  usage: { toolCalls: 7, llmCalls: 3, recoveries: 1 }, policy: { policyHash: 'hash-a', knowledge: 'disabled', builder: 'llm',
    skillIds: ['generic'], routing: { mode: 'auto' }, budgets: { maxToolCallsPerTurn: 20, maxLlmCallsPerTurn: 5 },
    repair: { enabled: false, maxRecoveriesPerTurn: 0 }, context: { history: 'full', memoryScopes: [] }, tools: { enabledIds: null, disabledIds: [] } },
} as ConversationRuntimeSnapshot

describe.each(['en', 'zh'] as const)('conversation settings (%s)', locale => {
  it('restores the saved conversation controls without writing global preferences', () => {
    document.cookie = 'structureclaw.locale=' + locale + '; path=/'
    const store = createAppStore({ locale, capabilitySkillIds: ['beam'], capabilityExplicit: true })
    const change = vi.fn()
    render(<AppStoreContext.Provider value={store}><RunSettings value={{}} onChange={change} locale={locale} disabled={false} runtime={snapshot}
      modelingSkills={[{id:'generic',label:'Generic'}]} /></AppStoreContext.Provider>)
    const t = messages[locale]
    expect(screen.getByLabelText(t.policyKnowledge)).toHaveValue('disabled')
    expect(screen.getByLabelText(t.policyBuilder)).toHaveValue('llm')
    expect(screen.getByLabelText(t.policyMemory)).toHaveValue('')
    expect(screen.getByText(/hash-a/)).toBeInTheDocument()
    expect(change).not.toHaveBeenCalled()
    expect(store.getState().capabilitySkillIds).toEqual(['beam'])
  })
  it('preserves excessive values so the error is visible, and sends no clamped value', () => {
    document.cookie = 'structureclaw.locale=' + locale + '; path=/'
    const change = vi.fn()
    const { rerender } = render(<AppStoreContext.Provider value={createAppStore({locale})}><RunSettings value={{}} onChange={change} locale={locale} disabled={false} /></AppStoreContext.Provider>)
    fireEvent.change(screen.getByLabelText(new RegExp('^'+messages[locale].policyToolLimit)), {target:{value:'201'}})
    expect(change.mock.calls.at(-1)?.[0].budgets.maxToolCallsPerTurn).toBe(201)
    rerender(<AppStoreContext.Provider value={createAppStore({locale})}><RunSettings value={{budgets:{maxToolCallsPerTurn:201}}} onChange={change} locale={locale} disabled={false} /></AppStoreContext.Provider>)
    expect(screen.getByRole('alert')).toHaveTextContent(messages[locale].policyLimitExceeded)
  })
  it('keeps active-run controls disabled and memory independently selectable', () => {
    document.cookie = 'structureclaw.locale=' + locale + '; path=/'
    render(<AppStoreContext.Provider value={createAppStore({locale})}><RunSettings value={{}} onChange={vi.fn()} locale={locale} disabled /></AppStoreContext.Provider>)
    expect(screen.getByLabelText(messages[locale].policyKnowledge)).toBeDisabled()
    expect(screen.getByText(messages[locale].policyConversation)).toBeInTheDocument()
  })
})
