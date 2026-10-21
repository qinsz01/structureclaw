'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { API_BASE } from '@/lib/api-base'
import { RunPolicyFields, SkillScopeFields, type ModelingSkillOption } from './run-policy-fields'
import { useRunPolicySettings } from './use-run-policy-settings'

export function PolicySettingsPanel({ section }: { section: 'skills' | 'run-policy' }) {
  const { t, locale } = useI18n()
  const settings = useRunPolicySettings()
  const [skills, setSkills] = useState<Array<{ id: string; domain?: string; name: Record<string, string> }>>([])
  const [catalogError, setCatalogError] = useState('')
  useEffect(() => {
    if (section !== 'skills') return
    const controller = new AbortController()
    void fetch(`${API_BASE}/api/v1/agent/skills`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(t('policySettingsLoadFailed'))
      const data = await response.json()
      setSkills((Array.isArray(data) ? data : data.skills).filter((skill: { domain: string }) => skill.domain === 'structure-type'))
    }).catch(error => { if (!controller.signal.aborted) setCatalogError(error instanceof Error ? error.message : t('policySettingsLoadFailed')) })
    return () => controller.abort()
  }, [section, t])
  const options: ModelingSkillOption[] = skills.map(skill => ({ id: skill.id, label: skill.name[locale] || skill.id }))
  return <form className="space-y-5" onSubmit={event => { event.preventDefault(); void settings.save() }}>
    <h2 className="text-xl font-semibold">{t(section === 'skills' ? 'settingsSkills' : 'settingsRunPolicy')}</h2>
    <p className="text-sm text-muted-foreground">{t('policyDefaultsHelp')}</p>
    {section === 'skills'
      ? <SkillScopeFields value={settings.value} onChange={settings.setValue} skills={options} disabled={!settings.loaded || settings.saving} />
      : <RunPolicyFields value={settings.value} onChange={settings.setValue} toolCallCeiling={settings.toolCallCeiling} disabled={!settings.loaded || settings.saving} />}
    {(settings.error || catalogError) && <p role="alert">{settings.error || catalogError}</p>}
    {settings.saved && <p role="status">{t('policyDefaultsSaved')}</p>}
    <Button type="submit" disabled={!settings.loaded || settings.saving}>{settings.saving ? t('llmSettingsSaving') : t('llmSettingsSave')}</Button>
  </form>
}
