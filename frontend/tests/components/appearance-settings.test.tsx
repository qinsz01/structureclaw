import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppearanceSettingsPanel } from '@/components/settings/appearance-settings-panel'
import { AppStoreContext, createAppStore } from '@/lib/stores/context'
import { messages } from '@/lib/i18n'
import { loadConsoleUiPreferences } from '@/components/chat/console/archive-storage'

const setTheme = vi.hoisted(() => vi.fn())
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'light', setTheme }) }))
afterEach(() => { cleanup(); localStorage.clear(); setTheme.mockClear(); document.cookie = 'structureclaw.locale=; Max-Age=0; path=/' })

describe.each(['en', 'zh'] as const)('appearance settings (%s)', locale => {
  it('edits theme, persistent language and sidebar layout in the unified section', async () => {
    document.cookie = `structureclaw.locale=${locale}; path=/`
    const store = createAppStore({ locale })
    render(<AppStoreContext.Provider value={store}><AppearanceSettingsPanel /></AppStoreContext.Provider>)
    const t = messages[locale]
    fireEvent.change(screen.getByLabelText(t.appearanceTheme), { target: { value: 'dark' } })
    expect(setTheme).toHaveBeenCalledWith('dark')
    fireEvent.change(screen.getByLabelText(t.appearanceLayout), { target: { value: 'collapsed' } })
    expect(loadConsoleUiPreferences().historyCollapsed).toBe(true)
    const next = locale === 'en' ? 'zh' : 'en'
    fireEvent.change(screen.getByLabelText(t.appearanceLocale), { target: { value: next } })
    await waitFor(() => expect(localStorage.getItem('structureclaw.locale')).toBe(next))
    expect(store.getState().locale).toBe(next)
    expect(document.cookie).toContain(`structureclaw.locale=${next}`)
  })
})
