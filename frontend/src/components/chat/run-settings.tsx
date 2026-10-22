'use client'

import type { RunPolicyInput } from '../../../../backend/src/runtime/run-policy'
import type { ConversationRuntimeSnapshot } from './use-conversation-runtime'
import { ConversationJobs } from './conversation-jobs'
import { RunPolicyFields, SkillScopeFields, type ModelingSkillOption } from '@/components/settings/run-policy-fields'
import { useI18n } from '@/lib/i18n'
import { mergeRunPolicyInputs } from '@/lib/run-policy'

export type { RunPolicyInput }

export function RunSettings({ value, onChange, locale, disabled, runtime, statusError, onRefresh, modelingSkills = [], defaults }: {
  value: RunPolicyInput; onChange: (value: RunPolicyInput) => void; locale: 'zh' | 'en'; disabled: boolean
  runtime?: ConversationRuntimeSnapshot | null; statusError?: string; onRefresh?: () => void
  modelingSkills?: ModelingSkillOption[]; defaults?: RunPolicyInput
  capabilityScope?: { skills: string[]; narrowed: boolean }
}) {
  const { t } = useI18n()
  const effective = mergeRunPolicyInputs(defaults, runtime?.policy, value)
  return <details className="w-full rounded-xl border border-border/60 p-3 text-sm">
    <summary className="cursor-pointer font-medium">{t('policyConversation')}</summary>
    <div className="mt-3 max-h-[60vh] space-y-4 overflow-y-auto">
      <p className="text-sm text-muted-foreground">{t('policyConversationHelp')}</p>
      {statusError && <p role="alert">{t('policyRuntimeUnavailable')}</p>}
      <SkillScopeFields value={effective} onChange={onChange} skills={modelingSkills} disabled={disabled} />
      <RunPolicyFields value={effective} onChange={onChange} disabled={disabled} />
      {runtime && <div className="space-y-2 text-xs text-muted-foreground">
        <p>{t(runtime.busy ? 'policyRunning' : runtime.waitingForReply ? 'policyWaiting' : 'policyReady')}</p>
        {runtime.waitingForReply && <p>{runtime.question}</p>}
        <p>{t('policyModelRevision')}: {runtime.modelRevision}</p>
        {runtime.usage && <p>{t('policyUsage')}: {runtime.usage.toolCalls} / {runtime.usage.llmCalls} / {runtime.usage.recoveries}</p>}
        {runtime.modeling?.builder && <p>{t('policyBuilderUsed')}: {t(runtime.modeling.builder === 'explicit' ? 'policyBuilderExplicit' : runtime.modeling.builder === 'template' ? 'policyBuilderTemplate' : 'policyBuilderLlm')}</p>}
        <ConversationJobs runtime={runtime} locale={locale} onRefresh={onRefresh} />
        {runtime.policy && <details><summary>{t('policyRecord')}</summary><p className="break-all">{runtime.policy.policyHash}</p></details>}
      </div>}
      {onRefresh && <button type="button" className="underline" onClick={onRefresh}>{t('policyRuntimeRefresh')}</button>}
    </div>
  </details>
}
