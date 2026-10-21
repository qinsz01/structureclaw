import { type StateCreator } from 'zustand'
import { loadCapabilityPreferences } from '../../capability-preference'

export type AppLocale = 'en' | 'zh'
export type WorkspaceSettingsTab = 'engines' | 'capabilities' | 'llm' | 'run-policy' | 'appearance' | 'database'

/**
 * Preferences State Interface
 *
 * Note: Theme persistence is handled by next-themes (see src/app/providers.tsx).
 * next-themes provides:
 * - localStorage persistence
 * - Cross-tab sync via browser 'storage' event
 * - System preference detection
 *
 * Capability preferences (selectedSkillIds, selectedToolIds) are persisted to
 * localStorage via saveCapabilityPreferences and hydrated on store creation.
 */
export interface PreferencesState {
  locale: AppLocale
  workspaceSettingsOpen: boolean
  workspaceSettingsTab: WorkspaceSettingsTab
  capabilitySkillIds: string[]
  capabilityToolIds: string[]
  capabilityExplicit: boolean
}

interface PreferencesActions {
  setLocale: (locale: AppLocale) => void
  openWorkspaceSettings: (tab?: WorkspaceSettingsTab) => void
  closeWorkspaceSettings: () => void
  setCapabilityPreferences: (skillIds: string[], toolIds: string[], explicit: boolean) => void
}

export type PreferencesSlice = PreferencesState & PreferencesActions

function hydrateCapabilityPreferences(): { skillIds: string[]; toolIds: string[]; explicit: boolean } {
  const stored = loadCapabilityPreferences()
  if (stored) {
    return stored
  }
  return { skillIds: [], toolIds: [], explicit: false }
}

export function createInitialPreferencesState(): PreferencesState {
  const initialCapabilities = hydrateCapabilityPreferences()
  return {
    locale: 'en',
    workspaceSettingsOpen: false,
    workspaceSettingsTab: 'llm',
    capabilitySkillIds: initialCapabilities.skillIds,
    capabilityToolIds: initialCapabilities.toolIds,
    capabilityExplicit: initialCapabilities.explicit,
  }
}

export const initialPreferencesState: PreferencesState = createInitialPreferencesState()

export const createPreferencesSlice: StateCreator<
  PreferencesSlice,
  [],
  [],
  PreferencesSlice
> = (set) => ({
  ...createInitialPreferencesState(),
  setLocale: (locale) => set({ locale }),
  openWorkspaceSettings: (tab = 'llm') => set({
    workspaceSettingsOpen: true,
    workspaceSettingsTab: tab,
  }),
  closeWorkspaceSettings: () => set({ workspaceSettingsOpen: false }),
  setCapabilityPreferences: (skillIds, toolIds, explicit) => {
    set({ capabilitySkillIds: skillIds, capabilityToolIds: toolIds, capabilityExplicit: explicit })
  },
})
