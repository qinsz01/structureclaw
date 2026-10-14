'use client'

import type { RunPolicyInput } from '../../../../backend/src/runtime/run-policy'
import type { ConversationRuntimeSnapshot } from './use-conversation-runtime'
import { ConversationJobs } from './conversation-jobs'

export type { RunPolicyInput }

export function RunSettings({ value, onChange, locale, disabled, runtime, statusError, onRefresh }: {
  value: RunPolicyInput; onChange: (value: RunPolicyInput) => void; locale: 'zh' | 'en'; disabled: boolean
  runtime?: ConversationRuntimeSnapshot | null; statusError?: string; onRefresh?: () => void
}) {
  const zh = locale === 'zh'
  const inherit = zh ? '沿用会话／系统设置' : 'Use conversation / system settings'
  const selectClass = 'rounded-lg border border-border bg-background px-2 py-1 text-xs'
  const policy = runtime?.policy
  const source = (key: string) => {
    const labels = zh ? { default: '系统默认', settings: '系统设置', session: '会话保存', legacy: '兼容入口', request: '本次请求', 'server-limit': '服务端限制' }
      : { default: 'Default', settings: 'Settings', session: 'Saved session', legacy: 'Legacy input', request: 'Request', 'server-limit': 'Server limit' }
    const keySource = policy?.fieldSources[key]
    return keySource ? labels[keySource] : '—'
  }
  const usage = runtime?.usage
  return <details className="mx-2 mb-2 rounded-xl border border-border/60 p-3 text-xs text-muted-foreground">
    <summary className="cursor-pointer font-medium text-foreground">{zh ? '运行设置' : 'Run settings'}</summary>
    {statusError && <p role="alert" className="mt-3 text-amber-700 dark:text-amber-300">{zh ? '无法读取服务端会话状态；发送前必须重新确认。' : 'Server session state is unavailable; it must be checked before sending.'}</p>}
    {runtime && <div className="my-3 space-y-2 rounded-lg bg-muted/40 p-3" aria-label={zh ? '服务端会话状态' : 'Server session state'}>
      <p>{runtime.busy ? (zh ? '运行中' : 'Running') : runtime.waitingForReply ? (zh ? '等待你的答复' : 'Waiting for your reply') : (zh ? '可继续' : 'Ready')}
        {' · '}{zh ? '模型版本' : 'Model revision'}: {runtime.modelRevision}{runtime.modelPending ? (zh ? '（草稿待完成）' : ' (draft pending)') : ''}</p>
      {runtime.waitingForReply && <p>{runtime.question}<br />{zh ? '继续此回合会保留原策略与已用预算。' : 'Resuming keeps the original policy and consumed budget.'}</p>}
      {runtime.analysis.runId && <p className="break-all">{zh ? '分析运行' : 'Analysis run'}: {runtime.analysis.runId} · {runtime.analysis.resultKey ?? '—'} · {runtime.analysis.current ? (zh ? '当前有效' : 'Current') : (zh ? '历史／不可用于当前模型' : 'Historical / unavailable for current model')}</p>}
      <p>{zh ? '当前报告' : 'Current report'}: {runtime.report.current ? (zh ? '有效' : 'Available') : (zh ? '尚无有效报告' : 'Unavailable')}</p>
      <ConversationJobs runtime={runtime} locale={locale} onRefresh={onRefresh} />
      {policy ? <>
        <p className="font-medium text-foreground">{zh ? '实际生效（服务端）' : 'Effective policy (server)'}</p>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {[
            [zh ? '专业指导' : 'Professional guidance', policy.knowledge === 'enabled' ? (zh ? '开启' : 'Enabled') : (zh ? '关闭' : 'Disabled'), 'knowledge'],
            [zh ? '建模方式' : 'Model builder', policy.builder === 'auto' ? (zh ? '自动／适用模板' : 'Auto / applicable templates') : (zh ? '通用建模' : 'General builder'), 'builder'],
            [zh ? '路由' : 'Routing', policy.routing.mode === 'auto' ? (zh ? '自动' : 'Auto') : policy.routing.skillId, 'routing.mode'],
            [zh ? '对话上下文' : 'Conversation context', policy.context.history === 'full' ? (zh ? '完整对话' : 'Full conversation') : (zh ? '仅当前回合' : 'Current turn'), 'context.history'],
            [zh ? '记忆范围' : 'Memory scopes', policy.context.memoryScopes.map(scope => scope === 'conversation' ? (zh ? '会话' : 'Conversation') : (zh ? '工作区' : 'Workspace')).join(', ') || (zh ? '关闭' : 'Disabled'), 'context.memoryScopes'],
          ].map(([label, text, field]) => <div key={field}><dt className="inline">{label}: </dt><dd className="inline">{text} · {source(field)}</dd></div>)}
        </dl>
        <p>{zh ? '本回合已用／上限' : 'This turn used / limit'} — {zh ? '工具' : 'Tools'} {usage?.toolCalls ?? 0}/{policy.budgets.maxToolCallsPerTurn} ({source('budgets.maxToolCallsPerTurn')}); LLM {usage?.llmCalls ?? 0}/{policy.budgets.maxLlmCallsPerTurn ?? (zh ? '未设上限' : 'unlimited')} ({source('budgets.maxLlmCallsPerTurn')}); {zh ? '纠正' : 'Corrections'} {usage?.recoveries ?? 0}/{policy.repair.maxRecoveriesPerTurn} ({source('repair.maxRecoveriesPerTurn')})</p>
        <details><summary className="cursor-pointer">{zh ? '权限与策略记录' : 'Permissions and policy record'}</summary>
          <p className="mt-2 break-all">{zh ? '策略' : 'Policy'}: {policy.policyHash}</p>
          <p>{zh ? '有效技能' : 'Active skills'}: {policy.activeSkillIds.join(', ') || '∅'}</p>
          <p>{zh ? '有效工具' : 'Active tools'}: {policy.activeToolIds.join(', ') || '∅'}</p>
          <p>{zh ? '未获准技能／工具' : 'Denied skills / tools'}: {[...policy.deniedSkillIds, ...policy.deniedToolIds].join(', ') || '∅'}</p>
          <p>{policy.executionOwner === 'external' ? (zh ? '外部宿主负责对话与循环；预算只覆盖 StructureClaw 内部调用。' : 'The external host owns conversation and loop; budgets cover StructureClaw calls only.') : (zh ? '对话、工具循环与内部调用由 StructureClaw 管理。' : 'StructureClaw manages conversation, tool loop and internal calls.')}</p>
        </details>
      </> : <p>{zh ? '此会话尚未开始运行；下方是下一回合的申请值。' : 'This conversation has not run yet; controls below request the next turn’s settings.'}</p>}
    </div>}
    {onRefresh && <button type="button" className="mt-2 underline" onClick={onRefresh}>{zh ? '刷新服务端状态' : 'Refresh server state'}</button>}
    <p className="my-3">{zh ? '修改在下一回合生效，并由服务端保存到此会话。工程校验始终开启。' : 'Changes apply next turn and are saved to this conversation by the server. Engineering validation is always active.'}</p>
    <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1">{zh ? '专业指导' : 'Professional guidance'}
        <select className={selectClass} value={value.knowledge ?? ''} onChange={e => onChange({ ...value, knowledge: (e.target.value || undefined) as RunPolicyInput['knowledge'] })}>
          <option value="">{inherit}</option><option value="enabled">{zh ? '开启' : 'Enabled'}</option><option value="disabled">{zh ? '关闭' : 'Disabled'}</option>
        </select>
      </label>
      <label className="grid gap-1">{zh ? '建模方式' : 'Model builder'}
        <select className={selectClass} value={value.builder ?? ''} onChange={e => onChange({ ...value, builder: (e.target.value || undefined) as RunPolicyInput['builder'] })}>
          <option value="">{inherit}</option><option value="auto">{zh ? '适用时使用模板' : 'Use templates when applicable'}</option><option value="llm">{zh ? '通用建模' : 'General model builder'}</option>
        </select>
      </label>
      <label className="grid gap-1">{zh ? '失败后自动纠正' : 'Automatic correction after failure'}
        <select className={selectClass} value={value.repair?.enabled === undefined ? '' : value.repair.enabled ? '2' : '0'} onChange={e => onChange({ ...value, repair: e.target.value === '' ? undefined : { enabled: e.target.value !== '0', maxRecoveriesPerTurn: Number(e.target.value) } })}>
          <option value="">{inherit}</option><option value="2">{zh ? '最多 2 次' : 'Up to 2 corrections'}</option><option value="0">{zh ? '关闭（仍可执行正常工具链）' : 'Disabled (normal tool chain remains available)'}</option>
        </select>
      </label>
      <label className="grid gap-1">{zh ? '对话上下文' : 'Conversation context'}
        <select className={selectClass} value={value.context?.history ?? ''} onChange={e => onChange({ ...value, context: { ...value.context, history: (e.target.value || undefined) as 'full' | 'current-turn' | undefined } })}>
          <option value="">{inherit}</option><option value="full">{zh ? '保留对话' : 'Full conversation'}</option><option value="current-turn">{zh ? '仅当前回合（保留工程模型）' : 'Current turn (keep engineering model)'}</option>
        </select>
      </label>
      <label className="grid gap-1">{zh ? '工具调用上限' : 'Tool call limit'}
        <input className={selectClass} type="number" min={1} max={200} placeholder={inherit} value={value.budgets?.maxToolCallsPerTurn ?? ''}
          onChange={e => onChange({ ...value, budgets: { ...value.budgets, maxToolCallsPerTurn: e.target.value === '' ? undefined : Math.max(1, Math.min(200, Number(e.target.value))) } })} />
      </label>
    </fieldset>
  </details>
}
