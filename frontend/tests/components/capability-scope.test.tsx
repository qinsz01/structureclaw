import type { ReactNode } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCapabilityCatalog } from '@/components/chat/console/use-capability-catalog'
import { AppStoreContext, createAppStore } from '@/lib/stores/context'
import { CAPABILITY_PREFERENCE_STORAGE_KEY } from '@/lib/capability-preference'
import type { ConversationRuntimeSnapshot } from '@/components/chat/use-conversation-runtime'

const skills = ['beam', 'generic'].map(id => ({ id, domain: 'structure-type', name: { en: id, zh: id }, description: { en: id, zh: id } }))
const session = (id: string, skill: string) => ({ conversationId: id,
  policy: { skillIds: [skill], activeSkillIds: [skill], activeToolIds: ['run_analysis'], tools: { enabledIds: null } },
}) as ConversationRuntimeSnapshot
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

function mockSettings(initial: Record<string, unknown> = {}) {
  let policy = initial
  const updates: unknown[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    if (String(input).endsWith('/skills')) return Response.json({ skills })
    if (String(input).endsWith('/capability-matrix')) return Response.json({ tools: [{ id: 'run_analysis', enabledByDefault: true }] })
    if (options?.method === 'PUT') { policy = JSON.parse(String(options.body)).agent.runPolicy; updates.push(policy) }
    return Response.json({ agent: { runPolicy: { value: policy } } })
  })
  return updates
}

describe('global defaults and conversation scope', () => {
  it('opening and switching conversations only changes the effective scope', async () => {
    const updates = mockSettings({ skillIds: ['beam'] })
    const store = createAppStore()
    const wrapper = ({ children }: { children: ReactNode }) => <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>
    const hook = renderHook(({ view }) => useCapabilityCatalog('en', view), { wrapper, initialProps: { view: session('a', 'generic') } })
    await waitFor(() => expect(store.getState().capabilitySkillIds).toEqual(['beam']))
    expect(hook.result.current.selectedSkillIds).toEqual(['generic'])
    hook.rerender({ view: session('b', 'beam') })
    await waitFor(() => expect(hook.result.current.selectedSkillIds).toEqual(['beam']))
    expect(store.getState().capabilitySkillIds).toEqual(['beam'])
    expect(updates).toEqual([])
  })
  it('migrates explicit legacy provider and text ids into server settings exactly once', async () => {
    localStorage.setItem(CAPABILITY_PREFERENCE_STORAGE_KEY, JSON.stringify({ explicit: true,
      skillIds: ['beam', 'pkpm-static', 'dead-load'], toolIds: [] }))
    const updates = mockSettings()
    const wrapper = ({ children }: { children: ReactNode }) => <AppStoreContext.Provider value={createAppStore()}>{children}</AppStoreContext.Provider>
    const hook = renderHook(() => useCapabilityCatalog('en', null), { wrapper })
    await waitFor(() => expect(updates).toEqual([{ skillIds: ['beam'], providers: { preferredIds: ['pkpm-static'] } }]))
    expect(localStorage.getItem(CAPABILITY_PREFERENCE_STORAGE_KEY)).toBeNull()
    hook.rerender()
    expect(updates).toHaveLength(1)
  })
  it('ignores implicit legacy preferences', async () => {
    localStorage.setItem(CAPABILITY_PREFERENCE_STORAGE_KEY, JSON.stringify({ explicit: false, skillIds: ['beam'] }))
    const updates = mockSettings()
    const store = createAppStore()
    const wrapper = ({ children }: { children: ReactNode }) => <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>
    renderHook(() => useCapabilityCatalog('en', null), { wrapper })
    await waitFor(() => expect(store.getState().capabilitySkillIds.slice().sort()).toEqual(['beam', 'generic']))
    expect(updates).toEqual([])
    expect(store.getState().capabilityExplicit).toBe(false)
  })
})
