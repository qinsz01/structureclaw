'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { API_BASE } from '@/lib/api-base'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { GeneralSettingsPanel } from './general-settings-panel'
import { useRunPolicySettings } from './use-run-policy-settings'

type Provider = {
  id: string; kind: string; name: { en: string; zh: string }; description: { en: string; zh: string }
  enabled: boolean; availability: { installed: boolean; configured: boolean; licence: string; reason?: string }
}
const groups: Array<[string, MessageKey]> = [['solver', 'providerSolver'], ['design-code', 'providerDesignCode'], ['input-parser', 'providerInputParser'], ['report-exporter', 'providerReportExporter']]

export function ProviderSettingsPanel() {
  const { t, locale } = useI18n()
  const settings = useRunPolicySettings()
  const [providers, setProviders] = useState<Provider[]>([])
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void fetch(`${API_BASE}/api/v1/agent/providers`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(t('policySettingsLoadFailed'))
      const data = await response.json()
      setProviders(data.providers)
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t('policySettingsLoadFailed')) })
    return () => controller.abort()
  }, [t, refresh])
  return <div className="space-y-6">
    <h2 className="text-xl font-semibold">{t('settingsEngines')}</h2>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); void settings.save() }}>
      <p className="text-sm text-muted-foreground">{t('providerHelp')}</p>
      {groups.map(([kind, label]) => <fieldset key={kind} disabled={!settings.loaded || settings.saving} className="space-y-3 rounded-xl border border-border p-4">
        <legend className="px-2 font-medium">{t(label)}</legend>
        {providers.filter(provider => provider.kind === kind).map(provider => <label key={provider.id} className="flex items-start gap-3">
          <input className="mt-1" type="checkbox" aria-label={`${t('providerEnabled')}: ${provider.name[locale]}`}
            checked={!settings.value.providers?.disabledIds?.includes(provider.id)} onChange={event => settings.setValue(value => ({ ...value,
              providers: { ...value.providers, disabledIds: event.target.checked ? value.providers?.disabledIds?.filter(id => id !== provider.id) ?? []
                : [...(value.providers?.disabledIds ?? []), provider.id] } }))} />
          <span className="min-w-0 text-sm"><span className="font-medium">{provider.name[locale]}</span>
            <span className="ml-2 text-xs text-muted-foreground">{t(provider.availability.installed ? 'providerInstalled' : 'providerMissing')} · {t(provider.availability.configured ? 'providerConfigured' : 'providerNotConfigured')}
              {provider.availability.licence === 'unknown' && <> · {t('providerLicenceUnknown')}</>}</span>
            <span className="mt-1 block text-xs text-muted-foreground">{provider.description[locale]}</span>
          </span>
        </label>)}
      </fieldset>)}
      {(settings.error || error) && <p role="alert">{settings.error || error}</p>}
      {settings.saved && <p role="status">{t('policyDefaultsSaved')}</p>}
      <Button type="submit" disabled={!settings.loaded || settings.saving}>{settings.saving ? t('llmSettingsSaving') : t('providerSave')}</Button>
    </form>
    <GeneralSettingsPanel sections={['analysis', 'pkpm', 'yjk']} onSaved={() => setRefresh(value => value + 1)} />
  </div>
}
