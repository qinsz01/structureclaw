import { useEffect, useState } from 'react'
import type { ConsoleUiPreferences } from './types'
import { DEFAULT_CONSOLE_UI_PREFERENCES, loadConsoleUiPreferences, saveConsoleUiPreferences } from './archive-storage'

const SIDEBAR_LAYOUT_MIN_WIDTH = 1280

function getIsSidebarLayout() {
  if (typeof window === 'undefined') {
    return false
  }

  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(`(min-width: ${SIDEBAR_LAYOUT_MIN_WIDTH}px)`).matches
  }

  return window.innerWidth >= SIDEBAR_LAYOUT_MIN_WIDTH
}

/** Persisted console UI preferences plus the responsive sidebar breakpoint. */
export function useConsoleLayout() {
  const [uiPreferences, setUiPreferences] = useState<ConsoleUiPreferences>(DEFAULT_CONSOLE_UI_PREFERENCES)
  const [uiPreferencesHydrated, setUiPreferencesHydrated] = useState(false)
  const [isSidebarLayout, setIsSidebarLayout] = useState(getIsSidebarLayout)

  useEffect(() => {
    setUiPreferences(loadConsoleUiPreferences())
    setUiPreferencesHydrated(true)
    const restoreLayout = () => setUiPreferences(loadConsoleUiPreferences())
    window.addEventListener('structureclaw:layout-changed', restoreLayout)
    return () => window.removeEventListener('structureclaw:layout-changed', restoreLayout)
  }, [])

  useEffect(() => {
    if (!uiPreferencesHydrated) {
      return
    }

    saveConsoleUiPreferences(uiPreferences)
  }, [uiPreferences, uiPreferencesHydrated])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const media = typeof window.matchMedia === 'function'
      ? window.matchMedia(`(min-width: ${SIDEBAR_LAYOUT_MIN_WIDTH}px)`)
      : null
    const updateSidebarLayout = () => {
      setIsSidebarLayout(media ? media.matches : window.innerWidth >= SIDEBAR_LAYOUT_MIN_WIDTH)
    }

    updateSidebarLayout()

    if (media) {
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', updateSidebarLayout)
        return () => media.removeEventListener('change', updateSidebarLayout)
      }

      media.addListener(updateSidebarLayout)
      return () => media.removeListener(updateSidebarLayout)
    }

    window.addEventListener('resize', updateSidebarLayout)
    return () => window.removeEventListener('resize', updateSidebarLayout)
  }, [])

  return { uiPreferences, setUiPreferences, isSidebarLayout }
}
