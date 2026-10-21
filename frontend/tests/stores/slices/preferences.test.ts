import { afterEach, describe, expect, it } from 'vitest'

import { createAppStore } from '@/lib/stores/context'
import { CAPABILITY_PREFERENCE_STORAGE_KEY } from '@/lib/capability-preference'
import {
  createPreferencesSlice,
  initialPreferencesState,
  type PreferencesSlice,
} from '@/lib/stores/slices/preferences'

describe('Preferences Slice (STAT-04)', () => {
  afterEach(() => window.localStorage.clear())

  it('createPreferencesSlice returns initial state with locale', () => {
    const slice = createPreferencesSlice(() => {}, () => ({} as any), {} as any)

    expect(slice.locale).toBe('en')
    expect(typeof slice.setLocale).toBe('function')
  })

  it('setLocale updates locale value', () => {
    let state: PreferencesSlice = createPreferencesSlice(
      (partial) => {
        state = { ...state, ...(partial as Partial<PreferencesSlice>) }
      },
      () => state,
      {} as any
    )

    state.setLocale('zh')
    expect(state.locale).toBe('zh')
  })

  it('opens and closes the workspace settings dialog', () => {
    const store = createAppStore()

    store.getState().openWorkspaceSettings('llm')
    expect(store.getState().workspaceSettingsOpen).toBe(true)
    expect(store.getState().workspaceSettingsTab).toBe('llm')

    store.getState().openWorkspaceSettings('capabilities')
    expect(store.getState().workspaceSettingsTab).toBe('capabilities')

    store.getState().closeWorkspaceSettings()
    expect(store.getState().workspaceSettingsOpen).toBe(false)
  })

  it('distinguishes first use from an explicitly empty selection after reload', () => {
    const store = createAppStore()
    expect(store.getState().capabilityExplicit).toBe(false)
    store.getState().setCapabilityPreferences([], [], true)
    expect(createAppStore().getState()).toMatchObject({
      capabilityExplicit: true, capabilitySkillIds: [], capabilityToolIds: [],
    })
  })

  it.each([{ skillIds: [] }, { skillIds: ['generic', 'opensees-static'] }])('does not treat unconfirmed legacy selections as explicit: $skillIds', ({ skillIds }) => {
    window.localStorage.setItem(CAPABILITY_PREFERENCE_STORAGE_KEY, JSON.stringify({ skillIds, toolIds: [] }))
    expect(createAppStore().getState()).toMatchObject({
      capabilityExplicit: false, capabilitySkillIds: skillIds, capabilityToolIds: [],
    })
  })

  it('persists automatic default provenance separately from the selected capabilities', () => {
    createAppStore().getState().setCapabilityPreferences(['beam', 'generic'], ['build_model'], false)
    expect(createAppStore().getState()).toMatchObject({
      capabilityExplicit: false, capabilitySkillIds: ['beam', 'generic'], capabilityToolIds: ['build_model'],
    })
  })
})

describe('Preference defaults', () => {
  it('locale defaults to english', () => {
    expect(initialPreferencesState.locale).toBe('en')
  })
})
