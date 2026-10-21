'use client'

import { useCallback, useEffect, useState } from 'react'
import type { RunPolicyInput } from '../../../../backend/src/runtime/run-policy'
import { MAX_TOOL_CALLS_PER_TURN_LIMIT } from '../../../../backend/src/runtime/limits'
import { API_BASE } from '@/lib/api-base'
import { useI18n } from '@/lib/i18n'

export const SETTINGS_CHANGED_EVENT = 'structureclaw:settings-changed'
type PolicySettings = { agent: { runPolicy: { value: RunPolicyInput }; toolCallCeiling?: number } }

export function useRunPolicySettings() {
  const { t } = useI18n()
  const [value, setValue] = useState<RunPolicyInput>({})
  const [toolCallCeiling, setToolCallCeiling] = useState(MAX_TOOL_CALLS_PER_TURN_LIMIT)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void fetch(`${API_BASE}/api/v1/admin/settings`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error(t('policySettingsLoadFailed'))
      const data = await response.json() as PolicySettings
      setValue(data.agent.runPolicy.value)
      setToolCallCeiling(data.agent.toolCallCeiling ?? MAX_TOOL_CALLS_PER_TURN_LIMIT)
      setLoaded(true)
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t('policySettingsLoadFailed')) })
    return () => controller.abort()
  }, [t])
  const save = useCallback(async () => {
    setSaving(true); setError(''); setSaved(false)
    try {
      const response = await fetch(`${API_BASE}/api/v1/admin/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: { runPolicy: value } }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || data.error || t('policySettingsSaveFailed'))
      setValue((data as PolicySettings).agent.runPolicy.value)
      setSaved(true)
      window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT))
    } catch (error) { setError(error instanceof Error ? error.message : t('policySettingsSaveFailed')) }
    finally { setSaving(false) }
  }, [t, value])
  return { value, setValue, loaded, saving, saved, error, save, toolCallCeiling }
}
