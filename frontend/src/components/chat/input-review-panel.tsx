'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { FileCheck2, RefreshCw } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Button } from '@/components/ui/button'
import { API_BASE } from '@/lib/api-base'

type Row = Record<string, unknown>
type Attachment = { fileId: string; originalName: string; relPath: string; mimeType?: string }
type Evidence = Row & { id: string; field: string; status: string; source?: Row; resolution?: Row }
export type InputReviewSnapshot = {
  conversationId: string; revisionToken: string; model: Row | null; modelRevision: number; modelPending: boolean
  inputEvidence: Evidence[]; activeEvidenceIds: string[]; inputIssues: { field: string; reason: string }[]
  groundMotionRecords: Row[]; allowedTools: string[]; waitingForReply: boolean
  analysisCurrent: boolean; reportCurrent: boolean; runUsage: { toolCalls: number; llmCalls: number } | null
}
const box = 'w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm'
const group = 'rounded-xl border border-border/70 bg-background/50 p-4'
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const text = (value: unknown) => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
const sourceFile = (item: Evidence) => text(item.source?.file ?? item.source?.filePath)
const column = (value: string) => /^\d+$/.test(value.trim()) ? Number(value) : value.trim()
function parsedValue(value: string) { try { return JSON.parse(value) as unknown } catch { return value } }

/** Stable IDs, including a load's owning case. Never converts display units into model units implicitly. */
export function fieldEdit(field: string, value: unknown, model?: Row | null): Row | null {
  const segments = field.split('.')
  const collection = segments.shift()
  const exists = (current: unknown, remaining: string): boolean => {
    if (!remaining) return current !== undefined
    if (Array.isArray(current)) return current.map(record).filter(item => typeof item.id === 'string' && remaining.startsWith(`${item.id}.`)
      && exists(item, remaining.slice(String(item.id).length + 1))).length === 1
    const [key, ...rest] = remaining.split('.')
    return exists(record(current)[key], rest.join('.'))
  }
  const resolveId = (items: unknown, remaining: string) => {
    if (!Array.isArray(items)) return undefined
    const candidates = items.map(record).filter(item => typeof item.id === 'string' && remaining.startsWith(`${item.id}.`)
      && exists(item, remaining.slice(String(item.id).length + 1)))
    return candidates.length === 1 ? String(candidates[0].id) : undefined
  }
  const id = model && collection ? resolveId(model[collection], segments.join('.')) : segments[0]
  if (id) segments.splice(0, id.split('.').length)
  if (!id || !collection || !segments.length || segments.some(key => ['__proto__', 'constructor', 'prototype', 'id'].includes(key))) return null
  let target: Row = { operation: 'update', collection, id }
  if (collection === 'load_cases' && segments[0] === 'loads' && segments.length >= 3) {
    segments.shift()
    const loadCase = model && Array.isArray(model.load_cases) ? model.load_cases.map(record).find(item => item.id === id) : undefined
    const loadId = loadCase ? resolveId(loadCase.loads, segments.join('.')) : segments[0]
    if (!loadId) return null
    segments.splice(0, loadId.split('.').length)
    target = { operation: 'update', collection: 'loads', caseId: id, id: loadId }
  } else if (!['nodes', 'elements', 'materials', 'sections', 'stories', 'load_cases', 'load_combinations'].includes(collection)) return null
  let values: unknown = value
  for (const key of segments.reverse()) values = { [key]: values }
  return { ...target, values }
}

export function InputReviewPanel({ open, onClose, conversationId, locale, disabled, attachments, initialContext, onUpdate }: {
  open: boolean; onClose: () => void; conversationId: string; locale: 'zh' | 'en'; disabled: boolean
  attachments: Attachment[]; initialContext: Row; onUpdate: (view: InputReviewSnapshot) => void
}) {
  const zh = locale === 'zh'
  const l = (zhText: string, enText: string) => zh ? zhText : enText
  const [view, setView] = useState<InputReviewSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [file, setFile] = useState('')
  const [page, setPage] = useState('1')
  const [region, setRegion] = useState('')
  const [requiredFields, setRequiredFields] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [field, setField] = useState('')
  const [modelField, setModelField] = useState('')
  const [value, setValue] = useState('')
  const [unit, setUnit] = useState('')
  const [row, setRow] = useState('')
  const [cellColumn, setCellColumn] = useState('')
  const [entityId, setEntityId] = useState('')
  const [mappedFields, setMappedFields] = useState('')
  const [reason, setReason] = useState('')
  const [lastOutput, setLastOutput] = useState<Row | null>(null)
  const [motion, setMotion] = useState({ sheetName: '', timeColumn: '', accelerationColumn: '', unit: '', direction: '', dt: '', timeUnit: '' })
  const [preview, setPreview] = useState<Row | null>(null)
  const [motionRecord, setMotionRecord] = useState<Row | null>(null)
  const [lastReviewed, setLastReviewed] = useState<{ field: string; value: unknown; unit?: string } | null>(null)
  const endpoint = `${API_BASE}/api/v1/agent/input-review/${encodeURIComponent(conversationId)}`
  const activeEndpoint = useRef(endpoint)
  activeEndpoint.current = endpoint
  useEffect(() => {
    if (!open || !conversationId) return
    const controller = new AbortController()
    setView(null); setError(''); setLastOutput(null); setPreview(null); setMotionRecord(null); setLastReviewed(null)
    setFile(''); setField(''); setSourceId(''); setModelField(''); setValue(''); setReason('')
    setRow(''); setCellColumn(''); setEntityId(''); setUnit(''); setMappedFields('')
    fetch(endpoint, { signal: controller.signal }).then(async response => {
      const data = await response.json()
      if (activeEndpoint.current !== endpoint) return null
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      setView(data)
    }).catch(error => { if (!controller.signal.aborted) setError(String(error.message ?? error)) })
    return () => controller.abort()
  }, [open, conversationId, endpoint])
  useEffect(() => { setLastReviewed(null) }, [field, value, unit, modelField, sourceId])
  const files = useMemo(() => [...new Map([
    ...attachments.map(item => [item.relPath, item.originalName] as const),
    ...(view?.inputEvidence ?? []).map(item => [sourceFile(item), sourceFile(item).split(/[\\/]/).at(-1) ?? ''] as const),
  ].filter(([path]) => path)).entries()], [attachments, view?.inputEvidence])
  const chosenFile = file || files[0]?.[0] || ''
  const evidence = (view?.inputEvidence ?? []).filter(item => sourceFile(item) === chosenFile)
  const active = evidence.filter(item => view?.activeEvidenceIds.includes(item.id))
  const selected = view?.inputEvidence.find(item => item.id === sourceId)
  const editable = Boolean(view && !disabled && !busy)
  const allowed = (tool: string) => editable && Boolean(view?.allowedTools.includes(tool))
  async function refresh() {
    const response = await fetch(endpoint)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? response.statusText)
    setView(data)
    return data as InputReviewSnapshot
  }
  async function act(tool: string, args: Row) {
    if (!view || !allowed(tool)) return null
    setBusy(true); setError('')
    try {
      const response = await fetch(`${endpoint}/tools`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionToken: view.revisionToken, tool, args, initialContext }) })
      const data = await response.json()
      if (activeEndpoint.current !== endpoint) return null
      if (!response.ok) { if (response.status === 409 || response.status === 403) await refresh(); throw new Error(data.error ?? response.statusText) }
      setView(data.review); onUpdate(data.review)
      const output = record(data.result)
      setLastOutput(output)
      if (!data.success) throw new Error(text(output.error ?? output.message ?? data.result))
      return { output, review: data.review as InputReviewSnapshot }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); return null }
    finally { setBusy(false) }
  }
  function choose(item: Evidence) {
    setSourceId(item.id); setField(item.field); setModelField(text(item.resolution?.modelField))
    setValue(text(item.normalizedValue ?? item.value ?? item.resolution?.value)); setUnit(text(item.normalizedUnit ?? item.unit ?? item.resolution?.unit))
    setRow(text(item.source?.row)); setCellColumn(text(item.source?.column)); setEntityId(text(item.source?.entityId)); setMappedFields(''); setLastReviewed(null)
  }
  async function review(selectedSource?: string) {
    if (!field || !reason.trim()) return
    const actualValue = selectedSource ? selected?.normalizedValue ?? selected?.value : parsedValue(value)
    const isFile = field.startsWith('file:')
    const result = await act('review_input', { resolutions: [{ field, reason,
      ...(selectedSource ? { selectedSource } : { value: isFile ? true : actualValue }),
      ...(unit ? { unit } : {}), ...(modelField ? { modelField } : {}),
      ...(sourceId ? { sourceEvidenceId: sourceId } : {}),
      ...(row || cellColumn || entityId ? { sourceLocation: { ...(row ? { row: Number(row) } : {}), ...(cellColumn ? { column: column(cellColumn) } : {}), ...(entityId ? { entityId } : {}) } } : {}),
      ...(isFile && mappedFields ? { mappedFields: mappedFields.split(',').map(item => item.trim()).filter(Boolean) } : {}),
    }] })
    if (result && !isFile) {
      const values = Array.isArray(result.output.modelValues) ? result.output.modelValues.map(record) : []
      const canonical = values.find(item => item.field === (modelField || field))
      setLastReviewed(canonical ? { field: String(canonical.field), value: canonical.value, unit: text(canonical.unit) } : null)
    }
  }
  async function readFile(focused: boolean) {
    let crop: unknown
    if (focused && region.trim()) {
      try { crop = JSON.parse(region) } catch { setError(l('区域需为 [x,y,宽,高]，各值为 0–1。', 'Region must be [x,y,width,height], normalized to 0–1.')); return }
    }
    await act('analyze_file', { filePath: chosenFile, mode: 'full', ...(/\.pdf$/i.test(chosenFile) ? { pageStart: Number(page), pageCount: 1 } : {}),
      ...(crop ? { region: crop } : {}), ...(focused && requiredFields.trim() ? { requiredFields: requiredFields.split(',').map(item => item.trim()) } : {}) })
  }
  async function inspectMotion() {
    const parameters: Row = Object.fromEntries(Object.entries(motion).filter(([, value]) => value.trim()))
    if (motion.dt) parameters.dt = Number(motion.dt)
    for (const key of ['timeColumn', 'accelerationColumn']) if (parameters[key]) parameters[key] = column(String(parameters[key]))
    setPreview(null); setMotionRecord(null)
    const result = await act('analyze_file', { filePath: chosenFile, groundMotion: parameters })
    if (result) { setPreview(record(result.output.groundMotionPreview)); setMotionRecord(record(result.output.groundMotionRecord)) }
  }
  async function confirmMotion() {
    if (!motionRecord || !reason.trim()) return
    const matches = active.filter(item => item.field.startsWith('file:') && item.status !== 'resolved'
      && (item.source?.sheet === undefined || item.source.sheet === motionRecord.sheetName))
    const complete = matches.find(item => item.source?.complete === true && record(item.source?.fileReference).parsedSha256 === record(motionRecord.fileReference).parsedSha256)
    if (!complete) { setError(l('请先完整解析当前文件和工作表。', 'Parse this file and sheet completely first.')); return }
    await act('review_input', { resolutions: [...new Set(matches.map(item => item.field))].map(field => ({ field, value: true, reason,
      sourceEvidenceId: complete.id, analysisRecordId: motionRecord.id })) })
  }
  const imagePath = text(selected?.source?.renderedImagePath) || (/\.(png|jpe?g|webp)$/i.test(text(selected?.source?.filePath)) ? text(selected?.source?.filePath) : '')
  const crop = Array.isArray(selected?.source?.region) ? selected.source.region as number[] : null
  const points = Array.isArray(record(preview?.preview).points) ? record(preview?.preview).points as Row[] : []
  const magnitude = Math.max(...points.map(item => Math.abs(Number(item.acceleration))), 1e-12)
  const firstTime = Number(points[0]?.time ?? 0), timeSpan = Math.max(Number(points.at(-1)?.time ?? 0) - firstTime, 1e-12)
  return <DialogShell open={open} onClose={onClose} title={l('输入与证据', 'Inputs and evidence')} closeLabel={l('关闭', 'Close')}
    description={l('与当前会话共用模型、权限和调用预算。复核改变输入后，需要重新校验与计算。', 'Uses this conversation’s model, permissions and call budget. Changed inputs require validation and a new calculation.')}
    className="ml-auto mr-0 max-w-4xl" contentClassName="space-y-4">
    {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm break-words">{error}</p>}
    {!view ? <p className="text-sm text-muted-foreground">{l('读取会话证据…', 'Loading conversation evidence…')}</p> : <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{l('待处理', 'Pending')}: {view.inputIssues.length} · {l('模型版本', 'Model revision')}: {view.modelRevision} · {l('工具调用', 'Tool calls')}: {view.runUsage?.toolCalls ?? 0}</span>
        <Button size="sm" variant="outline" disabled={!editable} onClick={() => refresh().catch(error => setError(String(error.message)))}><RefreshCw className="h-3.5 w-3.5" />{l('刷新', 'Refresh')}</Button>
      </div>
      {view.waitingForReply && <p className="text-xs text-muted-foreground">{l('会话正在等待答复。这里的复核保存后，回到对话继续回答即可。', 'This conversation is awaiting a reply. Review here, then return to the conversation to answer.')}</p>}
      {view.inputIssues.length > 0 && <details className={group} open><summary className="cursor-pointer font-medium">{l('尚未解决的输入', 'Unresolved inputs')}</summary><ul className="mt-3 space-y-2 text-xs">{view.inputIssues.map((item, i) => <li key={i} className="break-words"><b>{item.field}</b><p className="mt-1 text-muted-foreground">{item.reason}</p></li>)}</ul></details>}
      <section className={group}>
        <label className="grid gap-2 text-sm font-medium">{l('来源文件', 'Source file')}<select className={box} value={chosenFile} onChange={event => { setFile(event.target.value); setSourceId(''); setField(''); setPreview(null); setMotionRecord(null); setLastOutput(null); setModelField(''); setValue(''); setReason(''); setRow(''); setCellColumn(''); setEntityId(''); setUnit(''); setMappedFields('') }}>
          {!files.length && <option value="">{l('先在对话中上传文件', 'Upload a file in the conversation first')}</option>}{files.map(([path, name]) => <option key={path} value={path}>{name}</option>)}
        </select></label>
        <p className="mt-2 break-all text-xs text-muted-foreground">{chosenFile}</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {/\.pdf$/i.test(chosenFile) && <label className="grid gap-1 text-xs">{l('页码', 'Page')}<input className={box} type="number" min="1" value={page} onChange={e => setPage(e.target.value)} /></label>}
          <Button variant="outline" disabled={!chosenFile || !allowed('analyze_file')} onClick={() => readFile(false)}>{l('完整读取此文件／页', 'Read this file / page completely')}</Button>
        </div>
        <details className="mt-3 text-xs"><summary className="cursor-pointer">{l('图像区域定点复核', 'Review a drawing region')}</summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2"><label>{l('区域 [x,y,宽,高]，0–1', 'Region [x,y,width,height], 0–1')}<input className={box} value={region} onChange={e => setRegion(e.target.value)} placeholder="[0.1,0.2,0.4,0.3]" /></label>
            <label>{l('必查字段，逗号分隔', 'Required fields, comma separated')}<input className={box} value={requiredFields} onChange={e => setRequiredFields(e.target.value)} /></label></div>
          <Button className="mt-2" size="sm" variant="outline" disabled={!chosenFile || !allowed('analyze_file')} onClick={() => readFile(true)}>{l('复核区域（使用视觉模型）', 'Review region (uses vision model)')}</Button>
        </details>
        <div className="mt-4 space-y-2">{evidence.map(item => <button type="button" key={item.id} onClick={() => choose(item)} className={`w-full rounded-lg border p-3 text-left text-xs ${item.id === sourceId ? 'border-primary bg-primary/5' : 'border-border'}`}>
          <div className="flex flex-wrap justify-between gap-2"><b className="break-all">{item.field}</b><span>{item.status}{!view.activeEvidenceIds.includes(item.id) ? l(' · 已排除/历史', ' · excluded / history') : ''}</span></div>
          <div className="mt-1 break-words text-muted-foreground">{['page', 'sheet', 'row', 'column', 'entityId', 'region'].filter(key => item.source?.[key] !== undefined).map(key => `${key}: ${text(item.source?.[key])}`).join(' · ')}</div>
          {item.value !== undefined && <p className="mt-1 break-words">{text(item.value)} {text(item.unit)}</p>}
        </button>)}</div>
        {/* Local files may require the backend permission-checked URL; Next image optimization cannot authorize it. */}
        {imagePath && <div className="relative mt-3 inline-block max-w-full"><img src={`${API_BASE}/api/v1/files/serve?path=${encodeURIComponent(imagePath)}`} alt={l('选中证据的原图', 'Source image for selected evidence')} className="block max-h-96 max-w-full" />{crop && <span aria-label={l('证据区域', 'Evidence region')} className="pointer-events-none absolute border-2 border-amber-500 bg-amber-500/10" style={{ left: `${crop[0] * 100}%`, top: `${crop[1] * 100}%`, width: `${crop[2] * 100}%`, height: `${crop[3] * 100}%` }} />}</div>}
      </section>
      <section className={group}>
        <h3 className="font-medium">{l('确认字段与来源', 'Confirm fields and sources')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{l('明确填写来源单位。确认保留证据；服务端换算后，应用按钮才修改当前模型。', 'Declare the source units. Confirmation records evidence; Apply uses the server-converted value to change the current model.')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs">{l('证据字段', 'Evidence field')}<input className={box} value={field} onChange={e => setField(e.target.value)} /></label>
          <label className="text-xs">{l('来源证据', 'Source evidence')}<select className={box} value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="">{l('用户补充，无附件来源', 'User correction without an attachment')}</option>{evidence.map(item => <option key={item.id} value={item.id}>{item.field} · {item.status}</option>)}</select></label>
          {field.startsWith('file:') ? <label className="text-xs sm:col-span-2">{l('此来源已用于哪些已复核字段（逗号分隔）', 'Reviewed fields used from this source (comma separated)')}<input className={box} value={mappedFields} onChange={e => setMappedFields(e.target.value)} placeholder="nodes.A.x, nodes.B.x" /></label> : <>
            <label className="text-xs">{l('对应模型字段（稳定对象 ID）', 'Model field (stable object ID)')}<input className={box} value={modelField} onChange={e => setModelField(e.target.value)} placeholder="nodes.A.x" /></label>
            <label className="text-xs">{l('确认值（文本或 JSON）', 'Confirmed value (text or JSON)')}<input className={box} value={value} onChange={e => setValue(e.target.value)} /></label>
            <label className="text-xs">{l('来源单位', 'Source unit')}<input className={box} value={unit} onChange={e => setUnit(e.target.value)} placeholder="m / mm / kN / MPa" /></label>
          </>}
          <label className="text-xs">{l('表格行（从 1 开始）', 'Table row (one based)')}<input className={box} type="number" min="1" value={row} onChange={e => setRow(e.target.value)} /></label>
          <label className="text-xs">{l('表格列（名称或从 1 开始）', 'Table column (name or one based)')}<input className={box} value={cellColumn} onChange={e => setCellColumn(e.target.value)} /></label>
          <label className="text-xs">{l('CAD 来源实体 ID（如适用）', 'CAD source entity ID (if applicable)')}<input className={box} value={entityId} onChange={e => setEntityId(e.target.value)} /></label>
          <label className="text-xs sm:col-span-2">{l('复核／排除依据（必填）', 'Review / exclusion reason (required)')}<textarea className={box} value={reason} onChange={e => setReason(e.target.value)} /></label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={!field || !reason.trim() || !allowed('review_input')} onClick={() => review()}><FileCheck2 className="h-4 w-4" />{l('保存复核', 'Save review')}</Button>
          {selected?.status === 'observed' && <Button variant="outline" disabled={!reason.trim() || !allowed('review_input')} onClick={() => review(selected.id)}>{l('采用此来源值', 'Use this observed value')}</Button>}
          <Button variant="outline" disabled={!chosenFile || !active.length || !reason.trim() || !allowed('review_input')} onClick={() => act('review_input', { excludeSources: [{ sourceFile: chosenFile, reason, ...(sourceId ? { evidenceIds: [sourceId] } : {}) }] })}>{l(sourceId ? '排除此条无关证据' : '排除此无关来源', sourceId ? 'Exclude this unrelated observation' : 'Exclude this unrelated source')}</Button>
          {lastReviewed && fieldEdit(lastReviewed.field, lastReviewed.value, view.model) && <Button variant="outline" disabled={!view.model || !allowed('edit_model')} onClick={() => act('edit_model', { baseRevision: view.modelRevision, label: 'User-reviewed field', edits: [fieldEdit(lastReviewed.field, lastReviewed.value, view.model)] })}>{l('应用已复核值到模型', 'Apply reviewed value to model')}</Button>}
          <Button variant="outline" disabled={!view.model || !allowed('validate_model')} onClick={() => act('validate_model', {})}>{l('校验当前模型', 'Validate current model')}</Button>
        </div>
        {lastReviewed && <p className="mt-3 break-words text-xs">{l('将应用的模型值', 'Model value to apply')}: {lastReviewed.field} = {text(lastReviewed.value)} {lastReviewed.unit}</p>}
        {Array.isArray(lastOutput?.modelValueErrors) && lastOutput.modelValueErrors.map((item, i) => <p key={i} className="mt-2 break-words text-xs text-amber-600 dark:text-amber-400">{text(record(item).reason)}</p>)}
        {view.modelPending && <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">{l('存在待应用的建模修改，请先在对话中完成模型更新。仅校验现有模型不会应用草稿。', 'Model changes are pending. Complete the model update in the conversation; validating the existing model does not apply a draft.')}</p>}
      </section>
      {/\.(csv|tsv|xlsx?|txt|at2)$/i.test(chosenFile) && <section className={group}>
        <h3 className="font-medium">{l('作为地震波使用', 'Use as a ground motion')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{l('完整文件校验，不启动求解。未知单位、非均匀时间轴或坏单元格会明确报错。', 'Validates the complete file without solving. Unknown units, irregular time axes and bad cells are rejected.')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">{([
          ['sheetName', l('工作表（Excel 必需多表选择）', 'Sheet (select for a multi-sheet workbook)')], ['timeColumn', l('时间列（名称或从 0 开始）', 'Time column (name or zero based)')],
          ['accelerationColumn', l('加速度列（名称或从 0 开始）', 'Acceleration column (name or zero based)')], ['dt', l('时间步 dt（秒；无时间列时必需）', 'Time step dt (seconds; required without time column)')],
        ] as const).map(([key, label]) => <label key={key} className="text-xs">{label}<input className={box} value={motion[key]} onChange={e => { setMotion({ ...motion, [key]: e.target.value }); setPreview(null); setMotionRecord(null) }} /></label>)}
          <label className="text-xs">{l('加速度单位', 'Acceleration unit')}<select className={box} value={motion.unit} onChange={e => { setMotion({ ...motion, unit: e.target.value }); setPreview(null); setMotionRecord(null) }}><option value="">{l('使用文件明确标注', 'Use explicit file annotation')}</option>{['g', 'm/s2', 'cm/s2', 'mm/s2'].map(unit => <option key={unit}>{unit}</option>)}</select></label>
          <label className="text-xs">{l('全局激励方向（必选）', 'Global excitation direction (required)')}<select className={box} value={motion.direction} onChange={e => { setMotion({ ...motion, direction: e.target.value }); setPreview(null); setMotionRecord(null) }}><option value="">{l('请选择', 'Select')}</option><option value="x">X</option><option value="y">Y</option></select></label>
          <label className="text-xs">{l('时间列单位', 'Time column unit')}<select className={box} value={motion.timeUnit} onChange={e => { setMotion({ ...motion, timeUnit: e.target.value }); setPreview(null); setMotionRecord(null) }}><option value="">{l('文件标注／接口秒', 'File annotation / API seconds')}</option><option value="s">s</option><option value="ms">ms</option></select></label>
        </div>
        <Button className="mt-3" variant="outline" disabled={!motion.direction || !allowed('analyze_file')} onClick={inspectMotion}>{l('解析并预览完整记录', 'Parse and preview complete record')}</Button>
        {preview && <div className="mt-4 rounded-lg border border-border p-3 text-sm"><p>{l('样本数', 'Samples')}: {text(preview.pointCount)} · dt: {text(preview.dt)} s · {l('时长', 'Duration')}: {text(preview.duration)} s</p>
          <p className="mt-1">PGA: {text(preview.pgaMps2)} m/s² · {text(preview.direction).toUpperCase()}</p>
          {points.length > 0 && <svg role="img" aria-label={l('地震波显示采样预览', 'Sampled ground motion display')} viewBox="0 0 600 130" className="mt-3 h-32 w-full"><path d="M0 65H600" className="stroke-border" /><polyline fill="none" className="stroke-primary" strokeWidth="1.5" points={points.map(item => `${(Number(item.time) - firstTime) * 600 / timeSpan},${65 - Number(item.acceleration) / magnitude * 58}`).join(' ')} /></svg>}
          <p className="mt-2 text-xs text-muted-foreground">{l('曲线为显示采样，计算读取完整文件；PGA 取完整记录。沿用上方复核依据。', 'The curve is sampled for display; calculation uses the full file and PGA uses the complete record. Uses the review reason above.')}</p>
          <Button className="mt-3" disabled={!reason.trim() || !allowed('review_input')} onClick={confirmMotion}>{l('确认来源及当前采样参数', 'Confirm source and sampling settings')}</Button>
        </div>}
      </section>}
      {lastOutput && <details className={group}><summary className="cursor-pointer text-sm">{l('最近工具返回（解析内容／校验依据）', 'Latest tool response (parsed content / validation)')}</summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(lastOutput, null, 2).slice(0, 20000)}</pre>{JSON.stringify(lastOutput, null, 2).length > 20000 && <p className="mt-2 text-xs text-muted-foreground">{l('仅此文本展示截取前 20,000 字符；完整源文件与解析文件保留。', 'This text display is limited to 20,000 characters. The complete source and parsed files are retained.')}</p>}</details>}
      <p className="text-xs text-muted-foreground">{l('不可用按钮表示当前会话未授权相应工具或操作正在执行；此面板不会扩大权限或重置预算。', 'Unavailable actions reflect this conversation’s permissions or an operation in progress. This panel never expands permissions or resets budgets.')}</p>
    </>}
  </DialogShell>
}
