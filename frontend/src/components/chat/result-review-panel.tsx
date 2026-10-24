'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '@/lib/api-base'
import { useI18n } from '@/lib/i18n'
import { formatResultNumber } from '@/lib/utils'
import { visualizationMessages } from '@/lib/i18n/messages/visualization'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { buildVisualizationSnapshot } from '@/components/visualization/adapter'
import type { VisualizationNodeResults, VisualizationSnapshot } from '@/components/visualization/types'
import { getResultPeak, isForceComponent } from '@/components/visualization/structural-scene-utils'
import { queryMatchesView, type VizState } from '@/components/visualization/state'
import { MarkdownBody } from './markdown-body'
import { NativeDesignPanel, type NativeDesignReview } from './native-design-panel'

const StructuralViewer = dynamic(() => import('@/components/visualization/structural-viewer').then(module => module.StructuralViewer), { ssr: false })
type Row = Record<string, unknown>
type ResultInfo = { key: string; available: boolean; modes: { modeNumber: number; period?: number; frequency?: number }[]; times: { index: number; time: number | null }[]; responseDefinition?: unknown }
type RunInfo = { runId: string; current: boolean; selectedResultKey?: string; analysisType: string; nodes: string[]; members: string[]; results: ResultInfo[] }
type Catalog = { conversationId: string; revisionToken: string; currentRunId: string | null; allowedTools: string[]; runs: RunInfo[]; nativeDesign?: NativeDesignReview }
export type ResultSelection = { runId: string; resultKey: string; modeNumber?: number; timeIndex?: number; nodeId?: string; elementId?: string; positionM?: number; side?: 'left' | 'right'; end?: 'n1' | 'n2'; field: string; component: string; unit: string }
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const box = 'w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm'
const forceOnlyRun = (run?: RunInfo, key?: string) => {
  const definition=record(run?.results.find(result=>result.key===(key ?? run.selectedResultKey))?.responseDefinition)
  return (Array.isArray(definition.available) && !definition.available.includes('displacements'))
    || (Array.isArray(definition.unavailable) && definition.unavailable.includes('displacements'))
}
const defaultSelection = (run?: RunInfo, key?: string): ResultSelection => {
  const resultKey = key ?? run?.selectedResultKey ?? run?.results[0]?.key ?? ''
  const result = run?.results.find(value => value.key === resultKey)
  return { runId: run?.runId ?? '', resultKey, nodeId: run?.nodes[0],
    ...(forceOnlyRun(run, resultKey) ? {field:'reactions',component:'fz',unit:'kN'} : {field:'displacements',component:'uz',unit:result?.modes.length && !result.times.length ? '1' : 'mm'}),
    ...(result?.times.length ? { timeIndex: 0 } : result?.modes.length ? { modeNumber: result.modes[0].modeNumber } : {}) }
}
const cleanSelection = (selection: ResultSelection) => Object.fromEntries(Object.entries(selection).filter(([, value]) => value !== undefined))
function queryDisplayPeak(snapshot: VisualizationSnapshot | null, selection: ResultSelection) {
  return getResultPeak(snapshot?.cases.find(row => row.id === snapshot.defaultCaseId), selection.field, selection.component)
    * (selection.field === 'displacements' && ['ux', 'uy', 'uz'].includes(selection.component) && selection.unit === snapshot?.displacementUnit ? snapshot.displacementDisplayFactor ?? 1 : 1)
}
/** Print the already-rendered selected report; never parses raw HTML from a model response. */
export function printSelectedReport(element: HTMLElement | null, title: string) {
  if (!element) return
  const frame = document.createElement('iframe')
  frame.title = title; frame.style.cssText = 'position:fixed;width:0;height:0;border:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument; const view = frame.contentWindow
  if (!doc || !view) { frame.remove(); return }
  doc.title = title
  const style = doc.createElement('style')
  style.textContent = '@page{size:A4;margin:18mm}body{font:11pt/1.6 Arial,"Microsoft YaHei",sans-serif;color:#111}h1,h2,h3{break-after:avoid}table{border-collapse:collapse;width:100%;font-size:9pt}th,td{border:1px solid #aaa;padding:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere}img,svg{max-width:100%}a{color:inherit}'
  doc.head.appendChild(style); doc.body.appendChild(doc.importNode(element, true))
  view.addEventListener('afterprint', () => frame.remove(), { once: true })
  view.focus(); view.print()
}
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement('a')
  link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url)
}

/** Viewer projection only. Mechanics and unit conversion remain in query_results. */
export function selectedResultSnapshot(output: Row, selection: ResultSelection, zh: boolean): VisualizationSnapshot | null {
  const model = record(output.modelSnapshot); const data = record(output.visualizationData)
  if (!Array.isArray(model.nodes)) return null
  const metadata = record(model.metadata), text = visualizationMessages[zh ? 'zh' : 'en']
  const structure = [metadata.name, metadata.description, metadata.structureType, model.structure_type]
    .find(value => typeof value === 'string' && value.trim())
  const caseId = String(record(output.resultSelection).id ?? selection.resultKey.replace(/^(case|combination):/, ''))
  const sourceCase = (Array.isArray(model.load_cases) ? model.load_cases : []).map(record).find(row => row.id === caseId)
  const caseLabel = String(sourceCase?.name ?? caseId)
  const title = `${structure ?? text.visualizationAnalysisResult} · ${caseLabel}${selection.modeNumber ? ` · ${text.visualizationMode} ${selection.modeNumber}` : selection.timeIndex !== undefined ? ` · t=${String(data.time)} s` : ''}`
  if (selection.modeNumber === undefined && selection.timeIndex === undefined) {
    const snapshot = buildVisualizationSnapshot({
    title, model, analysis: output.resultSelection ? { runId: output.runId, meta: output.meta, selectedResultKey: selection.resultKey,
      results: { [selection.resultKey]: { success: true, selection: output.resultSelection, meta: output.meta, data } } }
      : { success: true, meta: output.meta, data }, mode: 'analysis-result' })
    return snapshot ? { ...snapshot, runId: selection.runId } : null
  }
  const geometry = buildVisualizationSnapshot({ title, model, mode: 'model-only' })
  if (!geometry) return null
  const displacements = record(data.displacements); const reactions = record(data.reactions)
  const nodeResults: Record<string, VisualizationNodeResults> = {}
  for (const node of geometry.nodes) {
    const displacement = Object.fromEntries(Object.entries(record(displacements[node.id])).filter(([key, value]) => ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'].includes(key) && typeof value === 'number' && Number.isFinite(value)))
    const reaction = Object.fromEntries(Object.entries(record(reactions[node.id])).filter(([key, value]) => ['fx', 'fy', 'fz', 'mx', 'my', 'mz'].includes(key) && typeof value === 'number' && Number.isFinite(value)))
    if (Object.keys(displacement).length || Object.keys(reaction).length) nodeResults[node.id] = { displacement, reaction }
  }
  const availableViews: VisualizationSnapshot['availableViews'] = ['model']
  if (geometry.nodes.every(node => ['ux', 'uy', 'uz'].every(key => typeof record(displacements[node.id])[key] === 'number' && Number.isFinite(record(displacements[node.id])[key])))) availableViews.push('deformed')
  if (Object.keys(reactions).length) availableViews.push('reactions')
  return { ...geometry, source: 'result', title, runId: selection.runId, loads: [], defaultCaseId: selection.resultKey, availableViews,
    ...(selection.modeNumber !== undefined ? { displacementUnit: '1', displacementDisplayFactor: 1 } : {}),
    cases: [{ id: selection.resultKey, label: caseLabel, kind: 'result', nodeResults, elementResults: {}, availableViews }],
    statusMessage: selection.modeNumber !== undefined
      ? zh ? '振型按最大平动分量归一化，无量纲；杆线连接仅用于显示，不代表跨内物理位移。' : 'Mode shape normalized by its maximum translational component, dimensionless. Connecting member lines are display interpolation, not physical interior displacements.'
      : `${zh ? '实际记录时间点；整体变形需全部节点平动记录完整，缺测不补零。杆线连接仅用于显示。响应定义：' : 'Recorded time sample; global deformation requires all node translations. Missing DOFs are not filled with zero. Connecting lines are display interpolation. Response definition: '}${JSON.stringify(data.responseDefinition ?? null)}` }
}

function ResponseCurve({ points, unit, label }: { points: { timeIndex: number; time: number; value: number }[]; unit: string; label: string }) {
  if (!points.length) return null
  const xmin = points[0]!.time, xmax = points[points.length - 1]!.time
  const ymin = Math.min(...points.map(point => point.value)), ymax = Math.max(...points.map(point => point.value))
  const x = (n: number) => 64 + 650 * (n - xmin) / (xmax - xmin || 1)
  const y = (n: number) => 208 - 176 * (n - ymin) / (ymax - ymin || 1)
  return <svg role="img" aria-label={label} viewBox="0 0 750 245" className="w-full rounded-xl border border-border bg-background text-foreground">
    <path d="M64 20V208H720" fill="none" stroke="currentColor" opacity=".3" />
    <text x="8" y="25" fontSize="10" fill="currentColor">{ymax.toPrecision(5)} {unit}</text><text x="8" y="210" fontSize="10" fill="currentColor">{ymin.toPrecision(5)}</text>
    <text x="64" y="233" fontSize="11" fill="currentColor">{xmin} s</text><text x="660" y="233" fontSize="11" fill="currentColor">{xmax} s</text>
    <polyline points={points.map(point => `${x(point.time)},${y(point.value)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" />
    {points.length <= 300 && points.map(point => <circle key={point.timeIndex} cx={x(point.time)} cy={y(point.value)} r="2" fill="currentColor"><title>{`#${point.timeIndex} · ${point.time}s · ${point.value} ${unit}`}</title></circle>)}
  </svg>
}

export function ResultReviewPanel({ open, onClose, conversationId, locale, disabled, onUsageChanged }: {
  open: boolean; onClose: () => void; conversationId: string; locale: 'zh' | 'en'; disabled: boolean; onUsageChanged: () => void
}) {
  const { t } = useI18n(); const zh = locale === 'zh'; const l = (cn: string, en: string) => zh ? cn : en
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [selection, setSelection] = useState<ResultSelection>(defaultSelection())
  const [result, setResult] = useState<Row | null>(null); const [series, setSeries] = useState<Row | null>(null); const [report, setReport] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [figureData, setFigureData] = useState<{ output: Row; selection: ResultSelection } | null>(null)
  const [figureLoading, setFigureLoading] = useState(false)
  const [activeView, setActiveView] = useState<Pick<VizState, 'view' | 'component'>>({ view: 'model', component: 'M2' })
  const [responseRevision, setResponseRevision] = useState(0)
  const [range, setRange] = useState({ startIndex: 0, endIndex: 0, stride: 1 })
  const endpoint = `${API_BASE}/api/v1/agent/result-review/${encodeURIComponent(conversationId)}`
  const generation = useRef(0)
  const catalogRef = useRef<Catalog | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const usageChangedRef = useRef(onUsageChanged)
  usageChangedRef.current = onUsageChanged
  const requests = useRef<Promise<unknown>>(Promise.resolve())
  const curveRef = useRef<HTMLDivElement>(null)
  const reportRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const ticket = ++generation.current
    catalogRef.current = null
    setCatalog(null); setResult(null); setSeries(null); setReport(null); setError(''); setFullscreen(false); setSelection(defaultSelection()); setBusy(false); setFigureData(null); setFigureLoading(false)
    if (!open || !conversationId) return
    const controller = new AbortController()
    fetch(endpoint, { signal: controller.signal }).then(async response => {
      const value = await response.json()
      if (!response.ok) throw new Error(value.error ?? response.statusText)
      if (value.conversationId !== conversationId) throw new Error('CONVERSATION_MISMATCH')
      if (generation.current !== ticket) return
      catalogRef.current = value
      const current = value.runs.find((run: RunInfo) => run.current) ?? value.runs[value.runs.length - 1]
      setCatalog(value); setSelection(defaultSelection(current))
    }).catch(cause => { if (generation.current === ticket && !controller.signal.aborted) setError(String(cause)) })
    return () => { controller.abort(); generation.current = ticket + 1 }
  }, [open, conversationId, endpoint])
  const run = catalog?.runs.find(item => item.runId === selection.runId)
  const item = run?.results.find(value => value.key === selection.resultKey)
  const locked = busy || disabled || figureLoading
  const change = (next: ResultSelection, followResponse = true) => {
    if (followResponse && (next.field !== selection.field || next.component !== selection.component)) setResponseRevision(value => value + 1)
    selectionRef.current = next; setSelection(next); setResult(null); setSeries(null); setReport(null); setError('')
  }
  const selectResult = (nextRun: RunInfo | undefined, key?: string) => {
    const next = defaultSelection(nextRun, key)
    change(next)
  }
  const timeCount = item?.times.length ?? 0
  useEffect(() => {
    setRange({ startIndex: 0, endIndex: Math.max(0, timeCount - 1), stride: Math.max(1, Math.ceil(timeCount / 10000)) })
  }, [selection.runId, selection.resultKey, timeCount])
  const action = useCallback((tool: 'query_results' | 'generate_report' | 'run_code_check', args: Row, background = false) => {
    const ticket = generation.current
    // Snapshot reads and explicit queries share the saved revision/usage ledger.
    // Serialize them and use the revision returned by the preceding action.
    const request = requests.current.then(async () => {
      if (!catalogRef.current || (!background && disabledRef.current) || ticket !== generation.current) return null
      if (!background) setBusy(true)
      setError('')
      try {
        const response = await fetch(`${endpoint}/tools`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionToken: catalogRef.current.revisionToken, tool, args }) })
        const value = await response.json()
        if (ticket !== generation.current) return null
        if (!response.ok) throw new Error(value.error ?? response.statusText)
        if (value.review?.conversationId !== conversationId) throw new Error('CONVERSATION_MISMATCH')
        catalogRef.current = value.review
        setCatalog(value.review); usageChangedRef.current()
        if (!value.success) throw new Error(JSON.stringify(value.result))
        const output = record(value.result)
        if (tool === 'query_results' && (output.runId !== args.runId || output.resultKey !== args.resultKey)) throw new Error('RESULT_SELECTION_MISMATCH')
        if (tool === 'generate_report') {
          const returned = record(record(record(output.report).json).requestedSelection)
          if (!Object.entries(record(args.selection)).every(([key, expected]) => returned[key] === expected)) throw new Error('REPORT_SELECTION_MISMATCH')
        }
        return output
      } catch (cause) { if (ticket === generation.current) setError(String(cause)); return null }
      finally { if (ticket === generation.current && !background) setBusy(false) }
    })
    requests.current = request
    return request
  }, [conversationId, endpoint])
  // Reading an archived figure takes the chat lock too. Busy polling must not
  // cancel that same read and start it again when the lock is released. The
  // backend still enforces the saved permissions, revision and session lock.
  const canLoadFigure = Boolean(open && item?.available && catalog?.allowedTools.includes('query_results'))
  const { runId, resultKey, modeNumber, timeIndex } = selection
  useEffect(() => {
    if (!canLoadFigure) { setFigureData(null); setFigureLoading(false); return }
    let cancelled = false
    const selected = selectionRef.current
    setFigureLoading(true)
    void action('query_results', { runId, resultKey, modeNumber, timeIndex, includeModelSnapshot: true }, true).then(output => {
      if (cancelled) return
      setFigureData(output ? { output, selection: selected } : null)
      setFigureLoading(false)
    })
    return () => { cancelled = true }
  }, [action, canLoadFigure, runId, resultKey, modeNumber, timeIndex])
  const querySelection = async (next: ResultSelection) => {
    setReport(null)
    const value = await action('query_results', { ...cleanSelection(next), quantityId: 'viewer-selected' })
    if (value && JSON.stringify(selectionRef.current) === JSON.stringify(next)) setResult(value)
  }
  const query = () => querySelection(selection)
  const querySeries = async () => { const value = await action('query_results', { ...cleanSelection({ ...selection, timeIndex: undefined }), quantityId: 'viewer-series', series: range }); if (value) setSeries(record(value.series)) }
  const makeReport = async () => { const value = await action('generate_report', { message: l('按当前结果选择生成报告', 'Report the selected result'), analysisType: run?.analysisType ?? 'static', locale, selection: cleanSelection(selection), narrative: 'structured' }); if (value) setReport(record(value.report)) }
  const runDesign = async (args: Row) => { setResult(null); setSeries(null); setReport(null); await action('run_code_check', args) }
  const reportDesign = async (runId: string) => { setReport(null); const value = await action('generate_report', {
    message: l('生成已保存的原生设计报告', 'Report the saved native design'), analysisType: 'static', locale,
    selection: { runId }, narrative: 'structured' }); if (value) setReport(record(value.report)) }
  const snapshot = useMemo(() => figureData ? selectedResultSnapshot(figureData.output, figureData.selection, zh) : null, [figureData, zh])
  const member = selection.elementId !== undefined
  const forceOnly=forceOnlyRun(run, selection.resultKey)
  const fields = forceOnly ? member ? ['forces'] : ['reactions'] : selection.modeNumber !== undefined ? ['displacements'] : member ? selection.timeIndex !== undefined ? ['forces'] : ['forces', 'displacements'] : selection.timeIndex !== undefined ? ['displacements', 'velocities', 'accelerations', 'reactions'] : ['displacements', 'reactions']
  const components = member ? selection.field === 'displacements' ? ['ux', 'uy', 'uz'] : ['N', 'V2', 'V3', 'T', 'M2', 'M3'] : selection.field === 'reactions' ? ['fx', 'fy', 'fz', 'mx', 'my', 'mz'] : selection.modeNumber !== undefined ? ['ux', 'uy', 'uz'] : ['ux', 'uy', 'uz', 'rx', 'ry', 'rz']
  const componentUnit = (component: string, field: string) => selection.modeNumber !== undefined ? '1' : ['T','M2','M3','mx','my','mz'].includes(component) ? 'kN.m' : ['N','V2','V3','fx','fy','fz'].includes(component) ? 'kN' : component.startsWith('r') ? field === 'velocities' ? 'rad/s' : field === 'accelerations' ? 'rad/s2' : 'rad' : field === 'velocities' ? 'mm/s' : field === 'accelerations' ? 'mm/s2' : 'mm'
  const objectSelection = (object: { kind: 'node' | 'member'; id: string }, quantity?: { field: string; component: string }): ResultSelection => {
    const sameKind = (object.kind === 'member') === member
    const field = quantity?.field ?? (sameKind ? selection.field : object.kind === 'member'
      ? activeView.view === 'deformed' && !forceOnly && selection.timeIndex === undefined ? 'displacements' : 'forces'
      : activeView.view === 'reactions' || forceOnly ? 'reactions' : 'displacements')
    const component = quantity?.component ?? (sameKind ? selection.component : field === 'forces' ? isForceComponent(activeView.component) ? activeView.component : 'M2' : field === 'reactions' ? 'fz' : 'uz')
    return { ...selection, field, component, unit: componentUnit(component, field),
      ...(object.kind === 'node' ? { nodeId: object.id, elementId: undefined, positionM: undefined, side: undefined, end: undefined }
        : { nodeId: undefined, elementId: object.id, positionM: selection.timeIndex === undefined ? object.id === selection.elementId ? selection.positionM ?? 0 : 0 : undefined,
          side: object.id === selection.elementId ? selection.side : undefined, end: selection.timeIndex === undefined ? undefined : 'n1' }) }
  }
  const quantity = record(result?.quantity)
  const queryPeak = queryDisplayPeak(snapshot, selection)
  const showQuantity = result && queryMatchesView(selection, activeView.view, activeView.component)
  return <DialogShell open={open} suspended={fullscreen} onClose={onClose} title={l('结果工作区', 'Result workspace')} closeLabel={l('关闭', 'Close')}
    className="my-[2vh] h-[92vh] max-w-[min(1600px,96vw)] bg-card dark:bg-card"
    contentClassName="p-0 sm:p-0"
    description={l('所有数值、图形和报告使用同一保存的运行与结果选择。', 'Values, figures and reports use the same saved run and result selection.')}>
    <div className="grid min-h-full grid-cols-1 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(220px,280px)_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]">
    <div className="space-y-4 p-4 lg:overflow-y-auto">
      {error && <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
      {catalog && !catalog.allowedTools.includes('query_results') && <p className="text-sm text-muted-foreground">{l('当前会话策略未开放结果查询。已有会话权限不会自动扩大。', 'The saved conversation policy does not allow result queries; its permissions are not expanded automatically.')}</p>}
      <fieldset disabled={locked} className="grid grid-cols-2 gap-3">
        <label className="col-span-2 text-xs">{l('运行', 'Run')}<select aria-label={l('运行', 'Run')} className={box} value={selection.runId} onChange={event => selectResult(catalog?.runs.find(run => run.runId === event.target.value))}>
          {!catalog?.runs.length && <option value="">{l('暂无保存的运行', 'No saved runs')}</option>}
          {catalog?.runs.map(run => <option key={run.runId} value={run.runId}>{run.current ? l('当前', 'Current') : l('历史', 'Historical')} · {run.runId}</option>)}
        </select></label>
        <label className="col-span-2 text-xs">{l('工况／组合', 'Case / combination')}<select aria-label={l('工况／组合', 'Case / combination')} className={box} value={selection.resultKey} onChange={event => selectResult(run, event.target.value)}>{run?.results.map(value => <option key={value.key} value={value.key}>{value.key}{value.available ? '' : l('（不可用）', ' (unavailable)')}</option>)}</select></label>
        {item?.modes.length && item?.times.length ? <label className="text-xs">{l('结果类型', 'Result domain')}<select aria-label={l('结果类型', 'Result domain')} className={box} value={selection.modeNumber !== undefined ? 'mode' : 'time'} onChange={event => change({ ...selection, elementId: undefined, positionM: undefined, side: undefined, end: undefined, nodeId: run?.nodes[0], field: 'displacements', component: 'uz', modeNumber: event.target.value === 'mode' ? item.modes[0]!.modeNumber : undefined, timeIndex: event.target.value === 'time' ? 0 : undefined, unit: event.target.value === 'mode' ? '1' : 'mm' })}><option value="time">{l('时程', 'Time history')}</option><option value="mode">{l('模态', 'Modes')}</option></select></label> : null}
        {item?.modes.length && selection.modeNumber !== undefined ? <label className="text-xs">{l('模态', 'Mode')}<select aria-label={l('模态', 'Mode')} className={box} value={selection.modeNumber} onChange={event => change({ ...selection, modeNumber: Number(event.target.value), timeIndex: undefined })}>{item.modes.map(mode => <option key={mode.modeNumber} value={mode.modeNumber}>{mode.modeNumber} · T={mode.period ?? '—'} s · f={mode.frequency ?? '—'} Hz</option>)}</select></label> : null}
        {item?.times.length && selection.timeIndex !== undefined ? <label className="text-xs">{l('时间索引', 'Time index')}<input aria-label={l('时间索引', 'Time index')} className={box} type="number" min="0" max={item.times.length - 1} value={selection.timeIndex ?? 0} onChange={event => change({ ...selection, timeIndex: Number(event.target.value), modeNumber: undefined })} /><span>{item.times[selection.timeIndex ?? 0]?.time ?? '—'} s</span></label> : null}
        <label className="text-xs">{l('对象类别', 'Object kind')}<select aria-label={l('对象类别', 'Object kind')} className={box} value={member ? 'member' : 'node'} onChange={event => change(event.target.value === 'member' ? { ...selection, nodeId: undefined, elementId: run?.members[0] ?? '', positionM: selection.timeIndex === undefined ? 0 : undefined, end: selection.timeIndex !== undefined ? 'n1' : undefined, field: 'forces', component: 'M2', unit: 'kN.m' } : { ...selection, elementId: undefined, positionM: undefined, side: undefined, end: undefined, nodeId: run?.nodes[0] ?? '', ...(forceOnly ? {field:'reactions',component:'fz',unit:'kN'} : {field:'displacements',component:'uz',unit:componentUnit('uz','displacements')}) })}><option value="node">{l('节点', 'Node')}</option>{selection.modeNumber === undefined && <option value="member">{l('构件', 'Member')}</option>}</select></label>
        <label className="text-xs">{l('对象', 'Object')}<select aria-label={l('对象', 'Object')} className={box} value={selection.elementId ?? selection.nodeId ?? ''} onChange={event => change({ ...selection, [member ? 'elementId' : 'nodeId']: event.target.value })}>{(member ? run?.members : run?.nodes)?.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
        <label className="text-xs">{l('响应', 'Response')}<select aria-label={l('响应', 'Response')} className={box} value={selection.field} onChange={event => { const field = event.target.value; const component = field === 'reactions' ? 'fz' : field === 'forces' ? 'M2' : 'uz'; change({ ...selection, field, component, unit: componentUnit(component, field) }) }}>{fields.map(field => <option key={field} value={field}>{({ displacements: l('位移／转角', 'Displacement / rotation'), velocities: l('速度', 'Velocity'), accelerations: l('加速度', 'Acceleration'), forces: l('内力', 'Member force'), reactions: l('反力', 'Reaction') })[field]}</option>)}</select></label>
        <label className="text-xs">{l('分量', 'Component')}<select aria-label={l('分量', 'Component')} className={box} value={selection.component} onChange={event => change({ ...selection, component: event.target.value, unit: componentUnit(event.target.value, selection.field) })}>{components.map(component => <option key={component} value={component}>{component}</option>)}</select><span>{selection.unit}</span></label>
        {member && selection.timeIndex === undefined && <><label className="text-xs">{l('沿构件位置 (m)', 'Member position (m)')}<input aria-label={l('沿构件位置 (m)', 'Member position (m)')} className={box} type="number" min="0" step="any" value={selection.positionM ?? 0} onChange={event => change({ ...selection, positionM: Number(event.target.value) })} /></label><label className="text-xs">{l('断点侧', 'Cut side')}<select className={box} value={selection.side ?? 'right'} onChange={event => change({ ...selection, side: event.target.value as 'left' | 'right' })}><option value="left">{l('左侧', 'Left')}</option><option value="right">{l('右侧', 'Right')}</option></select></label></>}
        {member && selection.timeIndex !== undefined && <label className="text-xs">{l('物理端点', 'Physical end')}<select className={box} value={selection.end ?? 'n1'} onChange={event => change({ ...selection, end: event.target.value as 'n1' | 'n2' })}><option>n1</option><option>n2</option></select></label>}
      </fieldset>
      <div className="flex flex-wrap gap-2"><Button disabled={locked || !item?.available || !catalog?.allowedTools.includes('query_results')} onClick={query}>{busy ? l('处理中…', 'Working…') : l('查询所选结果', 'Query selected result')}</Button><Button variant="outline" disabled={!result || locked || !catalog?.allowedTools.includes('generate_report')} onClick={makeReport}>{l('生成所选报告', 'Report selected result')}</Button></div>
      {showQuantity ? <div data-testid="workspace-query-result" className="rounded-xl border border-border bg-muted/30 p-4"><p className="text-xs text-muted-foreground">{selection.resultKey} · {selection.nodeId ?? selection.elementId} · {selection.component}{selection.timeIndex !== undefined ? ` · ${quantity.time} s` : selection.modeNumber !== undefined ? ` · mode ${selection.modeNumber}` : ''}</p><p className="mt-1 text-2xl tabular-nums">{typeof quantity.value === 'number' ? formatResultNumber(quantity.value, locale, queryPeak) : '—'} <span className="text-base">{String(quantity.unit ?? '')}</span></p>{selection.modeNumber !== undefined && <p className="text-xs">{l('无量纲归一化振型，不是实际位移。', 'Dimensionless normalized mode shape, not a physical displacement.')}</p>}<details className="mt-2 text-xs"><summary>{l('数值来源', 'Quantity source')}</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(quantity, null, 2)}</pre></details></div> : <p className="text-sm text-muted-foreground">{result ? l('所选数值仅在对应的图形视图显示。', 'The selected value appears only in its matching figure view.') : l('更改选择后请重新查询；不会沿用上一项的数字。', 'Query again after changing the selection; previous values are cleared.')}</p>}
      {selection.timeIndex !== undefined && <div className="space-y-3 rounded-xl border border-border p-4"><p className="text-sm">{l('响应曲线：实际记录样本，连接线仅辅助阅读。', 'Response curve: recorded samples; joining lines are visual guides.')}</p><fieldset disabled={locked} className="grid grid-cols-3 gap-3">{(['startIndex', 'endIndex', 'stride'] as const).map((key, index) => <label key={key} className="text-xs">{[l('起始索引', 'Start index'), l('末尾索引', 'End index'), l('采样间隔', 'Sample stride')][index]}<input className={box} type="number" min={key === 'stride' ? 1 : 0} value={range[key]} onChange={event => { setRange({ ...range, [key]: Number(event.target.value) }); setSeries(null) }} /></label>)}</fieldset><Button variant="outline" disabled={locked || !item?.available || !catalog?.allowedTools.includes('query_results')} onClick={querySeries}>{l('读取响应曲线', 'Read response curve')}</Button>{series && <><div ref={curveRef}><ResponseCurve points={series.points as { timeIndex: number; time: number; value: number }[]} unit={String(series.unit)} label={l('响应随时间变化', 'Response over time')} /></div><p className="text-xs">{String(series.component)} · {String(series.unit)} · {l('采样间隔', 'Sample stride')} {String(series.stride)} · {JSON.stringify(series.responseDefinition ?? null)}</p><Button variant="outline" onClick={() => download('response.csv', 'timeIndex,time_s,value,unit\n' + (series.points as Row[]).map(point => `${point.timeIndex},${point.time},${point.value},${series.unit}`).join('\n'), 'text/csv;charset=utf-8')}>{l('导出曲线 CSV', 'Export curve CSV')}</Button><Button variant="outline" onClick={() => { const svg = curveRef.current?.querySelector('svg')?.cloneNode(true) as SVGElement | undefined; if (!svg) return; svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); svg.setAttribute('style', 'color:#16202a;background:white'); download('response.svg', svg.outerHTML, 'image/svg+xml') }}>{l('导出曲线 SVG', 'Export curve SVG')}</Button></>}</div>}
      {catalog?.nativeDesign && <NativeDesignPanel key={conversationId} review={catalog.nativeDesign} locale={locale} disabled={locked} reportAllowed={catalog.allowedTools.includes('generate_report')} onExecute={runDesign} onReport={reportDesign} />}
      {report && <div className="space-y-3 rounded-xl border border-border p-4"><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => download('selected-report.md', String(report.markdown ?? ''), 'text/markdown;charset=utf-8')}>{l('导出 Markdown', 'Export Markdown')}</Button><Button variant="outline" onClick={() => download('selected-report.json', JSON.stringify(report.json, null, 2), 'application/json')}>{l('导出 JSON', 'Export JSON')}</Button><Button variant="outline" onClick={() => printSelectedReport(reportRef.current, String(record(record(report.json).meta).runId ?? selection.runId))}>{l('打印／保存 PDF', 'Print / save PDF')}</Button></div><div ref={reportRef}><MarkdownBody content={String(report.markdown ?? '')} /></div></div>}
    </div>
    <div className="relative h-[780px] min-w-0 p-3 lg:h-full lg:min-h-0 lg:pl-0" aria-busy={figureLoading}>
    <StructuralViewer embedded fullscreen={fullscreen} onFullscreenChange={setFullscreen} open={open} onClose={() => setFullscreen(false)} snapshot={snapshot} locale={locale} t={t}
    figureKey={snapshot?.runId ?? selection.runId} responseKey={String(responseRevision)} onViewChange={setActiveView}
    onChangeCase={() => { setFullscreen(false); requestAnimationFrame(() => document.querySelector<HTMLSelectElement>(`select[aria-label="${l('工况／组合', 'Case / combination')}"]`)?.focus()) }} queryBusy={locked}
    querySelection={error ? undefined : selection}
    queryResult={fullscreen ? error ? <span role="alert">{error}</span> : result ? <><div>{t('visualizationSelectedValue')}: {typeof quantity.value === 'number' ? formatResultNumber(quantity.value, locale, queryPeak) : '—'} {String(quantity.unit ?? '')}</div><div className="mt-1 text-muted-foreground">{selection.nodeId ?? selection.elementId} · {selection.component}</div></> : undefined : undefined}
    initialView={selection.field === 'forces' ? 'forces' : selection.field === 'reactions' ? 'reactions' : selection.field === 'displacements' ? 'deformed' : 'model'}
    initialForceMetric={isForceComponent(selection.component) ? selection.component : 'M2'}
    queryObjectKinds={selection.modeNumber !== undefined ? ['node'] : ['node', 'member']}
    selectedObject={selection.elementId ? { kind: 'member', id: selection.elementId } : selection.nodeId ? { kind: 'node', id: selection.nodeId } : undefined}
    selectedPositionM={selection.positionM}
    onSelectObject={object => { if (!locked) change(objectSelection(object), false) }}
    onQueryObject={async (object, quantity) => {
      if (locked || (object.kind === 'member' && selection.modeNumber !== undefined)) return
      const next = objectSelection(object, quantity)
      change(next, false)
      await querySelection(next)
    }} />
    {figureLoading && <div role="status" className="absolute inset-3 flex items-center justify-center rounded-3xl bg-background/80 text-sm text-muted-foreground">{l('正在加载图形…', 'Loading figure…')}</div>}
    </div>
    </div>
  </DialogShell>
}
