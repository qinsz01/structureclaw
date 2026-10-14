'use client'

import type { RunPolicyInput } from '../../../../backend/src/runtime/run-policy'

export type { RunPolicyInput }

export function RunSettings({ value, onChange, locale, disabled }: {
  value: RunPolicyInput; onChange: (value: RunPolicyInput) => void; locale: 'zh' | 'en'; disabled: boolean
}) {
  const zh = locale === 'zh'
  const inherit = zh ? '沿用会话／系统设置' : 'Use conversation / system settings'
  const selectClass = 'rounded-lg border border-border bg-background px-2 py-1 text-xs'
  return <details className="mx-2 mb-2 rounded-xl border border-border/60 p-3 text-xs text-muted-foreground">
    <summary className="cursor-pointer font-medium text-foreground">{zh ? '运行设置' : 'Run settings'}</summary>
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
