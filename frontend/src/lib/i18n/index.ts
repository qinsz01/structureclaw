'use client'

import { useCallback, useContext, useEffect, useLayoutEffect } from 'react'
import { createStore } from 'zustand/vanilla'
import { useStore as useZustandStore } from 'zustand'
import { AppStoreContext } from '@/lib/stores/context'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import {
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  readLocaleCookieFromDocument,
  writeLocaleCookie,
} from '@/lib/locale-preference'
import { shellMessages } from './messages/shell'
import { settingsMessages } from './messages/settings'
import { databaseAdminMessages } from './messages/database-admin'
import { consoleMessages } from './messages/console'
import { resultsMessages } from './messages/results'
import { engineReportMessages } from './messages/engine-report'
import { seismicReportMessages } from './messages/seismic-report'
import { visualizationMessages } from './messages/visualization'

// Dictionaries live in ./messages/<area>.ts; merged here into the flat per-locale map.
export const messages = {
  en: {
    ...shellMessages.en,
    ...settingsMessages.en,
    ...databaseAdminMessages.en,
    ...consoleMessages.en,
    ...resultsMessages.en,
    ...engineReportMessages.en,
    ...seismicReportMessages.en,
    ...visualizationMessages.en,
  },
  zh: {
    ...shellMessages.zh,
    ...settingsMessages.zh,
    ...databaseAdminMessages.zh,
    ...consoleMessages.zh,
    ...resultsMessages.zh,
    ...engineReportMessages.zh,
    ...seismicReportMessages.zh,
    ...visualizationMessages.zh,
  },
} as const

export type MessageKey = keyof typeof messages.en

type LocaleOnlyStore = {
  locale: AppLocale
  setLocale: (locale: AppLocale) => void
}

const fallbackLocaleStore = createStore<LocaleOnlyStore>()((set) => ({
  locale: 'en',
  setLocale: (locale) => set({ locale }),
}))

export function useI18n() {
  const appStoreContext = useContext(AppStoreContext)
  const localeStore = (appStoreContext ?? fallbackLocaleStore) as unknown as typeof fallbackLocaleStore
  const locale = useZustandStore(localeStore, (state) => state.locale)
  const setLocale = useZustandStore(localeStore, (state) => state.setLocale)

  // Align client storage/cookie with SSR on first paint; restore from localStorage when no cookie yet.
  useLayoutEffect(() => {
    const cookieLocale = readLocaleCookieFromDocument()
    const storedLocale = normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY))

    if (cookieLocale) {
      if (storedLocale !== cookieLocale) {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, cookieLocale)
      }
      if (cookieLocale !== locale) {
        setLocale(cookieLocale)
      }
      return
    }

    if (storedLocale && storedLocale !== locale) {
      setLocale(storedLocale)
      writeLocaleCookie(storedLocale)
      return
    }

    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
    writeLocaleCookie(locale)
    // Intentionally only the initial SSR snapshot; avoids re-running when locale changes from user input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
    writeLocaleCookie(locale)
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  }, [locale])

  const t = useCallback((key: MessageKey): string => messages[locale][key], [locale])

  return { locale, setLocale, t }
}
