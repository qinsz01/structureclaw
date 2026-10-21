'use client'

import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { useI18n } from '@/lib/i18n'
import { loadConsoleUiPreferences, saveConsoleUiPreferences } from '@/components/chat/console/archive-storage'

export function AppearanceSettingsPanel() {
  const { t, locale, setLocale } = useI18n()
  const { theme, setTheme } = useTheme()
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => { setCollapsed(loadConsoleUiPreferences().historyCollapsed) }, [])
  const selectClass = 'rounded-lg border border-border bg-background px-3 py-2'
  return <div className="grid gap-5 sm:grid-cols-2">
    <label className="grid gap-1">{t('appearanceTheme')}
      <select className={selectClass} aria-label={t('appearanceTheme')} value={theme ?? 'system'} onChange={event => setTheme(event.target.value)}>
        <option value="system">{t('appearanceSystem')}</option><option value="light">{t('appearanceLight')}</option><option value="dark">{t('appearanceDark')}</option>
      </select>
    </label>
    <label className="grid gap-1">{t('appearanceLocale')}
      <select className={selectClass} aria-label={t('appearanceLocale')} value={locale} onChange={event => setLocale(event.target.value as 'en' | 'zh')}>
        <option value="en">English</option><option value="zh">中文</option>
      </select>
    </label>
    <label className="grid gap-1">{t('appearanceLayout')}
      <select className={selectClass} aria-label={t('appearanceLayout')} value={collapsed ? 'collapsed' : 'expanded'} onChange={event => {
        const historyCollapsed = event.target.value === 'collapsed'
        setCollapsed(historyCollapsed); saveConsoleUiPreferences({ historyCollapsed })
        window.dispatchEvent(new Event('structureclaw:layout-changed'))
      }}>
        <option value="expanded">{t('appearanceExpanded')}</option><option value="collapsed">{t('appearanceCollapsed')}</option>
      </select>
    </label>
  </div>
}
