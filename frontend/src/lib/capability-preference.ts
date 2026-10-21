'use client'

import { migrateLegacySkillIds } from '../../../backend/src/shared/legacy-capabilities'

export type CapabilityPreferenceState = {
  skillIds: string[]
  toolIds: string[]
  explicit: boolean
  preferredProviderIds?: string[]
  emptyScope?: boolean
}

export const CAPABILITY_PREFERENCE_STORAGE_KEY = 'structureclaw.console.capabilities'

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

export function loadCapabilityPreferences(): CapabilityPreferenceState | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(CAPABILITY_PREFERENCE_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as { skillIds?: unknown; toolIds?: unknown; explicit?: unknown }
    const ids = normalizeStringArray(parsed?.skillIds)
    const migrated = migrateLegacySkillIds(ids)
    return {
      skillIds: migrated.skillIds,
      preferredProviderIds: migrated.preferredProviderIds,
      emptyScope: ids.length === 0,
      toolIds: normalizeStringArray(parsed?.toolIds),
      // Only an explicit user confirmation may restrict the default scope.
      explicit: parsed?.explicit === true,
    }
  } catch {
    return null
  }
}

