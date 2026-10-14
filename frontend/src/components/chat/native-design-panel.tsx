'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

type Row = Record<string, unknown>
type Label = { zh: string; en: string }
type Parameter = { key: string; label: Label; kind: 'integer' | 'choice' | 'boolean'; min?: number; max?: number; choices?: string[]; unit?: string }
export type NativeDesignReview = {
  modelRevision: number; modelHash: string | null; runId: string | null; available: boolean; reason: string | null
  options: { engine: string; codes: string[]; modes: string[]; parameters: Parameter[] } | null
  latestAttempt: Row | null; acceptedRecords: Row[]
}
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const box = 'w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm'

/** Request form only; all records, effective settings and eligibility come from the saved run. */
export function NativeDesignPanel({ review, locale, disabled, reportAllowed, onExecute, onReport }: {
  review: NativeDesignReview; locale: 'zh' | 'en'; disabled: boolean; reportAllowed: boolean
  onExecute: (args: Row) => Promise<void>; onReport: (runId: string) => Promise<void>
}) {
  const zh = locale === 'zh'; const l = (cn: string, en: string) => zh ? cn : en
  const [code, setCode] = useState(''); const [mode, setMode] = useState('code-check')
  const [adopt, setAdopt] = useState(false); const [values, setValues] = useState<Record<string, string>>({})
  useEffect(() => { setCode(''); setMode('code-check'); setAdopt(false); setValues({}) }, [review.modelHash, review.modelRevision, review.options?.engine])
  const options = review.options
  const reason = review.reason === 'TOOL_NOT_ALLOWED' ? l('当前策略未开放原生设计工具。', 'The current policy does not permit native design.')
    : review.reason === 'ANALYSIS_FAILED' ? l('当前分析未成功，请重新分析后再设计。之前完成的设计仅保留为历史记录。', 'The current analysis failed. Analyze again before designing; previous completed designs remain historical records.')
      : review.reason === 'NATIVE_DESIGN_ENGINE_REQUIRED' ? l('原生设计需要当前有效的 PKPM 或 YJK 分析。', 'Native design requires a current valid PKPM or YJK analysis.')
        : review.reason ? `${l('尚不能执行', 'Cannot execute yet')}: ${review.reason}` : ''
  const invalid = options?.parameters.some(parameter => {
    const value = values[parameter.key]; if (!value) return false
    if (parameter.kind !== 'integer') return false
    const n = Number(value); return !Number.isInteger(n) || n < parameter.min! || n > parameter.max!
  }) ?? false
  const submit = async () => {
    if (!options || !review.available || !adopt || !options.codes.includes(code) || invalid) return
    const parameters = Object.fromEntries(options.parameters.filter(parameter => values[parameter.key] !== undefined && values[parameter.key] !== '')
      .map(parameter => [parameter.key, parameter.kind === 'integer' ? Number(values[parameter.key]) : parameter.kind === 'boolean' ? values[parameter.key] === 'true' : values[parameter.key]]))
    await onExecute({ designCode: code, provider: 'native', design: { mode, adoptedNativeDefaults: true, parameters } })
  }
  const status = (value: unknown) => ({ complete: l('计算完成', 'Calculation complete'), incomplete: l('未完成', 'Incomplete'), pass: l('已报告检查通过', 'Reported checks passed'), fail: l('存在超限', 'Checks failed'),
    not_evaluated: l('未评定实配合规性', 'Installed reinforcement not evaluated'), not_applicable: l('不适用', 'Not applicable') })[String(value)] ?? String(value ?? '—')
  const renderRecord = (row: Row) => {
    const meta = object(row.meta); const rows = Array.isArray(row.records) ? row.records.map(object) : []
    const checks = Array.isArray(row.details) ? row.details.map(object) : []
    return <div key={String(row.designRecordId)} className="space-y-2 rounded-lg border border-border p-3 text-sm">
      <p className="font-medium">{String(row.designCode)} · {status(row.completionStatus)} · {status(row.complianceStatus)}</p>
      <p className="break-all text-xs text-muted-foreground">{l('模型版本', 'Model revision')} {String(meta.modelRevision)} · run {String(meta.runId)} · {row.current ? l('当前', 'Current') : l('历史设计', 'Historical design')}</p>
      {(row.designMode === 'required-reinforcement' || row.reinforcementScope === 'required-not-installed') && <p>{l('仅计算所需配筋面积；未验算已有配筋，也不表示实配通过。', 'Required reinforcement areas only. Installed reinforcement was not checked or certified.')}</p>}
      {(row.message || row.errorCode) ? <p role="status" className="whitespace-pre-wrap text-destructive">{String(row.errorCode ?? '')} {String(row.message ?? '')}</p> : null}
      {Array.isArray(row.missingInputs) && row.missingInputs.length > 0 && <pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(row.missingInputs, null, 2)}</pre>}
      {!!rows.length && <details><summary>{l('所需配筋', 'Required reinforcement')} ({rows.length})</summary><div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs"><thead><tr>{[l('构件', 'Member'), l('分量', 'Component'), l('所需面积', 'Required area'), l('原生计算面积', 'Native calculated area'), l('组合', 'Combination')].map(text => <th key={text} className="p-1">{text}</th>)}</tr></thead><tbody>{rows.map((value, index) => <tr key={index}><td className="p-1">{String(value.elementId)}</td><td className="p-1">{String(value.component)}</td><td className="p-1">{String(value.requiredArea)} mm²</td><td className="p-1">{value.calculatedArea === undefined ? '—' : `${value.calculatedArea} mm²`}</td><td className="p-1">{JSON.stringify(value.nativeCombination)}</td></tr>)}</tbody></table></div></details>}
      {!!checks.length && <details><summary>{l('原生检查', 'Native checks')} ({checks.length})</summary><div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs"><thead><tr>{[l('构件', 'Member'), l('检查项', 'Check'), l('需求／限值', 'Demand / limit'), l('结果', 'Status'), l('组合', 'Combination')].map(text => <th key={text} className="p-1">{text}</th>)}</tr></thead><tbody>{checks.map((value, index) => <tr key={index}><td className="p-1">{String(value.elementId)}</td><td className="p-1">{String(value.check)}</td><td className="p-1">{String(value.demand ?? '—')} / {String(value.capacity ?? '—')} {String(value.unit ?? '')}</td><td className="p-1">{status(value.status)}</td><td className="p-1">{JSON.stringify(value.nativeCombination)}</td></tr>)}</tbody></table></div></details>}
      <details><summary>{l('请求、有效参数与来源', 'Request, effective parameters and sources')}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(row, null, 2)}</pre></details>
      {row.completionStatus === 'complete' && <Button variant="outline" disabled={disabled || !reportAllowed} onClick={() => onReport(String(meta.runId))}>{l('生成此设计报告', 'Report this design')}</Button>}
    </div>
  }
  return <section aria-label={l('原生设计', 'Native design')} className="space-y-3 rounded-xl border border-border p-4">
    <h3 className="font-medium">{l('原生设计', 'Native design')}</h3>
    <p className="text-xs text-muted-foreground">{l('设计针对当前模型，另建运行记录；采用软件原生设计组合，不等同于上方选中的分析工况。选项表示接口已接入，实际模型适用性仍由原生预检和读回决定。', 'Design uses the current model and creates a separate run. Native design combinations differ from the analysis case selected above. These options describe connected inputs; native preflight and readback still determine applicability.')}</p>
    {reason && <p role="status" className="text-sm">{reason}</p>}
    {options && <><fieldset disabled={disabled || !review.available} className="space-y-3">
      <p className="break-all text-xs">{options.engine.toUpperCase()} · {l('模型版本', 'Model revision')} {review.modelRevision} · run {review.runId}</p>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs">{l('设计规范／配置', 'Design code / profile')}<select className={box} value={code} onChange={event => setCode(event.target.value)}><option value="">{l('请选择', 'Select explicitly')}</option>{options.codes.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="text-xs">{l('设计目的', 'Design purpose')}<select className={box} value={mode} onChange={event => setMode(event.target.value)}>{options.modes.map(value => <option key={value} value={value}>{value === 'required-reinforcement' ? l('计算所需配筋', 'Calculate required reinforcement') : l('原生规范检查', 'Native code checks')}</option>)}</select></label></div>
      {!!options.parameters.length && <details><summary className="text-sm">{l('可选设计参数', 'Optional design parameters')}</summary><p className="my-2 text-xs text-muted-foreground">{l('留空采用本次明确接受的软件默认值，并记录实际读回值。不会修改源模型。', 'Blank fields use the explicitly adopted software defaults, with effective values read back. The source model is unchanged.')}{options.engine === 'pkpm' && l(' SATWE 箍筋设计基准固定为 100 mm，不是实配间距。', ' SATWE uses a fixed 100 mm design stirrup spacing; this is not the installed spacing.')}</p>
        <div className="grid gap-3 sm:grid-cols-2">{options.parameters.map(parameter => <label key={parameter.key} className="text-xs">{parameter.label[locale]}{parameter.unit && ` (${parameter.unit})`}{parameter.kind === 'integer' ? <input type="number" step="1" min={parameter.min} max={parameter.max} className={box} value={values[parameter.key] ?? ''} placeholder={l('原生默认', 'Native default')} onChange={event => setValues({ ...values, [parameter.key]: event.target.value })} />
          : <select className={box} value={values[parameter.key] ?? ''} onChange={event => setValues({ ...values, [parameter.key]: event.target.value })}><option value="">{l('原生默认', 'Native default')}</option>{parameter.kind === 'boolean' ? <><option value="true">{l('有侧移', 'Sway')}</option><option value="false">{l('无侧移', 'Non-sway')}</option></> : parameter.choices?.map(value => <option key={value} value={value}>{value}</option>)}</select>}</label>)}</div>
      </details>}
      {invalid && <p role="alert" className="text-sm text-destructive">{l('设计参数须为范围内整数；PKPM 箍筋设计间距只能为 100 mm。', 'Design dimensions must be integers within range; PKPM design stirrup spacing must be 100 mm.')}</p>}
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={adopt} onChange={event => setAdopt(event.target.checked)} />{l('采用未指定参数的软件默认值，并要求原生读回确认；不将所需配筋解释为实配验算通过。', 'Adopt native defaults for unspecified parameters and require readback confirmation; required reinforcement does not certify installed reinforcement.')}</label>
      <Button disabled={disabled || !review.available || !code || !adopt || invalid} onClick={submit}>{l('执行原生设计', 'Run native design')}</Button>
    </fieldset></>}
    {review.latestAttempt?.completionStatus !== 'complete' && review.latestAttempt && <div><h4 className="mb-2 text-xs font-medium">{l('最近设计尝试', 'Latest design attempt')}</h4>{renderRecord(review.latestAttempt)}</div>}
    {review.acceptedRecords.length > 0 && <div className="space-y-2"><h4 className="text-xs font-medium">{l('本模型版本已完成的设计记录（完成不等于通过）', 'Completed designs for this model revision (completion does not imply passing)')}</h4>{[...review.acceptedRecords].reverse().map(renderRecord)}</div>}
  </section>
}
