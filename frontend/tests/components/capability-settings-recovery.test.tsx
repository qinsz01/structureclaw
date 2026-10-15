import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilitySettingsPanel } from '@/components/chat/capability-settings-panel'
import { AppStoreContext, createAppStore } from '@/lib/stores/context'
import { CAPABILITY_PREFERENCE_STORAGE_KEY } from '@/lib/capability-preference'

const skills = [
  ['beam', 'structure-type', 'Beam', '梁'],
  ['opensees-static', 'analysis', 'OpenSees static', 'OpenSees 静力'],
  ['code-check-gb50017', 'code-check', 'Steel checks', '钢结构校核'],
  ['code-check-gb50010', 'code-check', 'Concrete checks', '混凝土校核'],
].map(([id, domain, en, zh]) => ({ id, domain, name: { en, zh }, description: { en, zh } }))
const matrix = {
  skills,
  tools: [{ id: 'run_analysis', category: 'analysis', enabledByDefault: true,
    displayName: { en: 'Run analysis', zh: '执行分析' }, description: { en: 'Analyze', zh: '分析' } }],
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); document.cookie = 'structureclaw.locale=; Max-Age=0; path=/' })

// Transport faults are intentionally mocked here; the browser/live-provider suite
// separately verifies that selected controls reach the real server policy.
describe('capability catalog failure and selection persistence', () => {
  for (const locale of ['en', 'zh'] as const) {
    it.each(['skills', 'matrix'] as const)(`preserves explicit selections after %s fails, then retries (${locale})`, async failedCatalog => {
      document.cookie = `structureclaw.locale=${locale}; path=/`
      const saved = { skillIds: ['beam', 'code-check-gb50017'], toolIds: ['run_analysis'], explicit: true }
      window.localStorage.setItem(CAPABILITY_PREFERENCE_STORAGE_KEY, JSON.stringify(saved))
      const store = createAppStore({ locale })
      let fail = true
      vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        const url = String(input)
        if ((failedCatalog === 'skills' && url.endsWith('/agent/skills')
          || failedCatalog === 'matrix' && url.includes('/agent/capability-matrix')) && fail) {
          return new Response('{}', { status: 503 })
        }
        return Response.json(url.endsWith('/agent/skills') ? { skills } : url.includes('/agent/capability-matrix') ? matrix : [])
      })
      const view = render(<AppStoreContext.Provider value={store}><CapabilitySettingsPanel /></AppStoreContext.Provider>)
      const retry = await screen.findByRole('button', { name: locale === 'en' ? 'Retry capability loading' : '重试加载能力' })
      expect(JSON.parse(window.localStorage.getItem(CAPABILITY_PREFERENCE_STORAGE_KEY)!)).toEqual(saved)
      for (const reset of screen.getAllByRole('button', { name: locale === 'en' ? 'Reset to Defaults' : '恢复默认勾选' })) expect(reset).toBeDisabled()
      fail = false
      fireEvent.click(retry)
      const steel = await screen.findByRole('button', { name: locale === 'en' ? 'Steel checks' : '钢结构校核' })
      await waitFor(() => expect(steel).toBeEnabled())
      expect(steel).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('button', { name: locale === 'en' ? 'Concrete checks' : '混凝土校核' })).toHaveAttribute('aria-pressed', 'false')
      expect(JSON.parse(window.localStorage.getItem(CAPABILITY_PREFERENCE_STORAGE_KEY)!)).toEqual(saved)
      fireEvent.click(steel)
      view.unmount()
      render(<AppStoreContext.Provider value={createAppStore({ locale })}><CapabilitySettingsPanel /></AppStoreContext.Provider>)
      await waitFor(() => expect(screen.getByRole('button', { name: locale === 'en' ? 'Steel checks' : '钢结构校核' })).toHaveAttribute('aria-pressed', 'false'))
      expect(JSON.parse(window.localStorage.getItem(CAPABILITY_PREFERENCE_STORAGE_KEY)!)).toEqual({ ...saved, skillIds: ['beam'] })
    })
  }

  it.each([false, true])('updates implicit defaults while preserving explicit empty capability sets (explicit=%s)', async explicit => {
    window.localStorage.setItem(CAPABILITY_PREFERENCE_STORAGE_KEY, JSON.stringify({ skillIds: [], toolIds: [], explicit }))
    const store = createAppStore()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => Response.json(String(input).endsWith('/agent/skills') ? { skills }
      : String(input).includes('/agent/capability-matrix') ? matrix : []))
    render(<AppStoreContext.Provider value={store}><CapabilitySettingsPanel /></AppStoreContext.Provider>)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Steel checks' })).toBeEnabled())
    const current = store.getState()
    expect(current.capabilitySkillIds).toEqual(explicit ? [] : ['opensees-static', 'beam', 'code-check-gb50017', 'code-check-gb50010'])
    expect(current.capabilityToolIds).toEqual(explicit ? [] : ['run_analysis'])
    expect(current.capabilityExplicit).toBe(explicit)
  })

  it('upgrades an older implicit selection to include both beam design standards', async () => {
    window.localStorage.setItem(CAPABILITY_PREFERENCE_STORAGE_KEY, JSON.stringify({ skillIds: ['beam', 'opensees-static'], toolIds: ['run_analysis'], explicit: false }))
    const store = createAppStore()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => Response.json(String(input).endsWith('/agent/skills') ? skills
      : String(input).includes('/agent/capability-matrix') ? matrix : []))
    render(<AppStoreContext.Provider value={store}><CapabilitySettingsPanel /></AppStoreContext.Provider>)
    await waitFor(() => expect(store.getState().capabilitySkillIds).toContain('code-check-gb50017'))
    expect(store.getState().capabilitySkillIds).toContain('code-check-gb50010')
  })
})
