'use client'

import type { RunPolicyInput } from '../../../../backend/src/runtime/run-policy'
import { DEFAULT_MAX_TOOL_CALLS_PER_TURN, MAX_TOOL_CALLS_PER_TURN_LIMIT } from '../../../../backend/src/runtime/limits'
import { useI18n } from '@/lib/i18n'

export type ModelingSkillOption = { id: string; label: string }
const inputClass = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm'

export function SkillScopeFields({ value, onChange, skills, disabled }: {
  value: RunPolicyInput; onChange: (value: RunPolicyInput) => void; skills: ModelingSkillOption[]; disabled?: boolean
}) {
  const { t } = useI18n()
  const mode = value.routing?.mode === 'fixed' ? 'fixed' : value.skillIds == null ? 'auto' : 'restricted'
  return <fieldset disabled={disabled} className="space-y-3">
    <label className="grid gap-1">{t('policySkillScope')}
      <select className={inputClass} aria-label={t('policySkillScope')} value={mode} onChange={event => {
        const next = event.target.value
        onChange({ ...value, skillIds: next === 'restricted' ? skills.map(skill => skill.id) : null,
          routing: next === 'fixed' && skills[0] ? { mode: 'fixed', skillId: skills[0].id } : { mode: 'auto' } })
      }}>
        <option value="auto">{t('policyAutomatic')}</option>
        <option value="restricted">{t('policyRestricted')}</option>
        <option value="fixed">{t('policyPinned')}</option>
      </select>
    </label>
    <p className="text-sm text-muted-foreground">{t('policySkillsHelp')}</p>
    {mode === 'fixed' && <label className="grid gap-1">{t('policyPinnedSkill')}
      <select className={inputClass} aria-label={t('policyPinnedSkill')} value={value.routing?.mode === 'fixed' ? value.routing.skillId : ''}
        onChange={event => onChange({ ...value, routing: { mode: 'fixed', skillId: event.target.value } })}>
        {skills.map(skill => <option key={skill.id} value={skill.id}>{skill.label}</option>)}
      </select>
    </label>}
    {mode === 'restricted' && <div className="grid gap-2 sm:grid-cols-2">
      {skills.map(skill => <label key={skill.id} className="flex items-center gap-2">
        <input type="checkbox" checked={value.skillIds?.includes(skill.id) ?? false} onChange={event => onChange({ ...value,
          skillIds: event.target.checked ? [...(value.skillIds ?? []), skill.id] : value.skillIds?.filter(id => id !== skill.id) })} />
        {skill.label}
      </label>)}
    </div>}
  </fieldset>
}

export function RunPolicyFields({ value, onChange, disabled, toolCallCeiling = MAX_TOOL_CALLS_PER_TURN_LIMIT }: {
  value: RunPolicyInput; onChange: (value: RunPolicyInput) => void; disabled?: boolean; toolCallCeiling?: number
}) {
  const { t } = useI18n()
  const toolLimit = value.budgets?.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN
  return <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
    <label className="grid gap-1">{t('policyKnowledge')}
      <select className={inputClass} aria-label={t('policyKnowledge')} value={value.knowledge ?? 'enabled'} onChange={event => onChange({ ...value, knowledge: event.target.value as RunPolicyInput['knowledge'] })}>
        <option value="enabled">{t('policyEnabled')}</option><option value="disabled">{t('policyDisabled')}</option>
      </select>
    </label>
    <label className="grid gap-1">{t('policyBuilder')}
      <select className={inputClass} aria-label={t('policyBuilder')} value={value.builder ?? 'auto'} onChange={event => onChange({ ...value, builder: event.target.value as RunPolicyInput['builder'] })}>
        <option value="auto">{t('policyBuilderAuto')}</option><option value="llm">{t('policyBuilderLlm')}</option>
      </select>
    </label>
    <label className="grid gap-1">{t('policyRepair')}
      <input className={inputClass} type="number" min={0} step={1} value={value.repair?.maxRecoveriesPerTurn ?? (value.repair?.enabled === false ? 0 : 2)}
        onChange={event => { const count = Number(event.target.value); onChange({ ...value, repair: { enabled: count > 0, maxRecoveriesPerTurn: count } }) }} />
    </label>
    <label className="grid gap-1">{t('policyHistory')}
      <select className={inputClass} aria-label={t('policyHistory')} value={value.context?.history ?? 'full'} onChange={event => onChange({ ...value,
        context: { ...value.context, history: event.target.value as 'full' | 'current-turn' } })}>
        <option value="full">{t('policyFullHistory')}</option><option value="current-turn">{t('policyCurrentTurn')}</option>
      </select>
    </label>
    <label className="grid gap-1">{t('policyMemory')}
      <select className={inputClass} aria-label={t('policyMemory')} value={[...(value.context?.memoryScopes ?? ['conversation', 'workspace'])].sort().join(',')}
        onChange={event => onChange({ ...value, context: { ...value.context,
          memoryScopes: event.target.value ? event.target.value.split(',') as Array<'conversation' | 'workspace'> : [] } })}>
        <option value="">{t('policyDisabled')}</option><option value="conversation">{t('policyConversationMemory')}</option>
        <option value="workspace">{t('policyWorkspaceMemory')}</option><option value="conversation,workspace">{t('policyBothMemory')}</option>
      </select>
    </label>
    <label className="grid gap-1">{t('policyToolLimit')}
      <input className={inputClass} aria-label={t('policyToolLimit')} type="number" min={1} max={toolCallCeiling} step={1} value={toolLimit}
        onChange={event => onChange({ ...value, budgets: { ...value.budgets, maxToolCallsPerTurn: event.target.valueAsNumber } })} />
      <span className="text-xs text-muted-foreground">{t('policyServerCeiling')}: {toolCallCeiling}</span>
      {(!Number.isInteger(toolLimit) || toolLimit < 1 || toolLimit > toolCallCeiling) && <span role="alert" className="text-sm text-destructive">{t('policyLimitExceeded')}</span>}
    </label>
    <label className="grid gap-1">{t('policyLlmLimit')}
      <input className={inputClass} type="number" min={1} step={1} placeholder={t('policyUnlimited')} value={value.budgets?.maxLlmCallsPerTurn ?? ''}
        onChange={event => onChange({ ...value, budgets: { ...value.budgets, maxLlmCallsPerTurn: event.target.value === '' ? null : event.target.valueAsNumber } })} />
    </label>
  </fieldset>
}
