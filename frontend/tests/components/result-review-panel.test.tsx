import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ResultReviewPanel, selectedResultSnapshot } from '@/components/chat/result-review-panel'
import { buildVisualizationSnapshot } from '@/components/visualization/adapter'
import { messages } from '@/lib/i18n'
import type { StructuralSceneProps } from '@/components/visualization/scene/types'

const testLocale = vi.hoisted(() => ({ current: 'en' as 'en' | 'zh' }))
vi.mock('next/dynamic', async () => {
  const { StructuralViewer } = await import('@/components/visualization/structural-viewer')
  return { default: () => StructuralViewer }
})
vi.mock('@/lib/i18n', async original => {
  const module = await original<typeof import('@/lib/i18n')>()
  return { ...module, useI18n: () => ({ t: (key: keyof typeof messages.en) => module.messages[testLocale.current][key] }) }
})
vi.mock('@/components/visualization/structural-scene', () => ({
  StructuralScene: (props: StructuralSceneProps) => <div data-testid="test-scene" data-case={props.activeCase.id}
    data-node={props.selectedNodeId} data-member={props.selectedElementId} data-position={props.selectedPositionM}
    data-view={props.view} data-scale={props.deformationScale} data-camera={props.cameraPreset}>
    <button data-testid="scene-node-b" onClick={() => props.onSelectNode('b')}>Pick node</button>
    <button data-testid="scene-member-e" onClick={() => props.onSelectElement('e')}>Pick member</button>
  </div>,
}))
vi.mock('@/components/chat/markdown-body', () => ({ MarkdownBody: ({ content }: { content: string }) => <div>{content}</div> }))
const model = {schema_version:'2.1',unit_system:'SI',coordinate_system:{semantics:'global-z-up',version:1,dimension:'3d',plane:null,dof_order:['ux','uy','uz','rx','ry','rz']},nodes:[{id:'a',x:0,y:0,z:0},{id:'b',x:4,y:0,z:0}],elements:[{id:'e',type:'beam',nodes:['a','b']}],materials:[],sections:[],load_cases:[]}
const catalog = { conversationId:'A',revisionToken:'v1',currentRunId:'now',allowedTools:['query_results','generate_report'],runs:[
  {runId:'old',current:false,analysisType:'static',selectedResultKey:'case:D',nodes:['a','b'],members:['e'],results:[{key:'case:D',available:true,modes:[],times:[]}]},
  {runId:'now',current:true,analysisType:'dynamic',selectedResultKey:'analysis:dynamic',nodes:['a','b'],members:['e'],results:[{key:'analysis:dynamic',available:true,modes:[],times:[{index:0,time:0},{index:1,time:.03},{index:2,time:.11}]}]},
] }
const result = {runId:'now',resultKey:'analysis:dynamic',quantity:{value:-2,unit:'mm',time:.03},modelSnapshot:model,visualizationData:{time:.03,displacements:{a:{ux:0,uy:0,uz:0},b:{ux:0,uy:0,uz:-.002}}}}
beforeEach(() => { vi.restoreAllMocks(); testLocale.current = 'en' })

const meta = { runId: 'old', modelHash: 'model', settingsHash: 'settings', coordinateSemantics: 'global-z-up',
  coordinateContractVersion: 1, dimension: '3d', plane: null, dofOrder: ['ux','uy','uz','rx','ry','rz'],
  activeDofs: ['ux','uy','uz','rx','ry','rz'], nodalResultFrame: 'global', elementForceFrame: 'element-local' }
function workspaceFixture(placeholder = false) {
  const responseDefinition = placeholder ? { stiffnessPlaceholder: true, available: ['forces', 'reactions'], unavailable: ['displacements', 'rotations'] } : undefined
  const review = { ...catalog, runs: [{ ...catalog.runs[0], current: true, results: ['case:D', 'case:L'].map(key => ({ key, available: true, modes: [], times: [], responseDefinition })) }] }
  const posts: { revisionToken: string; tool: string; args: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return { ok: true, json: async () => review }
    const body = JSON.parse(String(init.body)); posts.push(body)
    const data = { meta, responseDefinition,
      ...(!placeholder ? { displacements: { a: { ux: 0, uy: 0, uz: 0 }, b: { ux: 0, uy: 0, uz: body.args.resultKey === 'case:D' ? -.002 : -.004 } } } : {}),
      reactions: { a: { fx: 0, fy: 0, fz: 1 } },
      forces: { e: { axial: 1, n1: { N: 1, V3: 1, M2: 4 }, n2: { N: -1, V3: -1, M2: 0 } } },
      memberResponses: [{ id: 'e', state: placeholder ? 'force-only' : 'recovered', reason: 'fixture', length: 4,
        samples: [0, 4].map(x => ({ x, position: [x, 0, 0], M2: 4 - x, N: 1, V3: 1, V2: 0, T: 0, M3: 0,
          provenance: 'solver-direct', source: {}, ...(!placeholder ? { displacement: [0, 0, -x * .0005] } : {}) })) }],
    }
    return { ok: true, json: async () => ({ success: true, review: { ...review, revisionToken: `v${posts.length + 1}` },
      result: { runId: body.args.runId, resultKey: body.args.resultKey, meta, modelSnapshot: model,
        resultSelection: { key: body.args.resultKey, kind: 'case', id: body.args.resultKey.slice(5) }, visualizationData: data,
        ...(body.args.component ? { quantity: { value: -2, unit: body.args.unit } } : {}) } }) }
  }))
  return posts
}

describe('inline workspace figure', () => {
  it.each(['en', 'zh'] as const)('loads immediately, links both selectors and scene, and keeps free view choice (%s)', async locale => {
    testLocale.current = locale
    const posts = workspaceFixture()
    const m = messages[locale]
    render(<ResultReviewPanel open conversationId="A" locale={locale} disabled={false} onClose={() => {}} onUsageChanged={() => {}} />)
    const scene = await screen.findByTestId('test-scene')
    expect(scene).toHaveAttribute('data-view', 'deformed')
    expect(posts).toEqual([{ revisionToken: 'v1', tool: 'query_results', args: { runId: 'old', resultKey: 'case:D', includeModelSnapshot: true } }])
    expect(screen.queryByTestId('workspace-query-result')).toBeNull()
    expect(screen.queryByRole('button', { name: /View selected figure|查看所选图形/ })).toBeNull()
    const object = screen.getByLabelText(locale === 'en' ? 'Object' : '对象')
    fireEvent.change(object, { target: { value: 'b' } })
    expect(scene).toHaveAttribute('data-node', 'b')
    expect(screen.getByTestId('test-scene')).toBe(scene)
    fireEvent.click(screen.getByRole('button', { name: m.visualizationViewModel, exact: true }))
    fireEvent.change(object, { target: { value: 'a' } })
    expect(scene).toHaveAttribute('data-view', 'model')
    fireEvent.click(screen.getByTestId('scene-node-b'))
    expect(object).toHaveValue('b')
    fireEvent.click(screen.getByTestId('scene-member-e'))
    expect(screen.getByLabelText(locale === 'en' ? 'Object kind' : '对象类别')).toHaveValue('member')
    expect(object).toHaveValue('e')
    expect(scene).toHaveAttribute('data-view', 'model')
    fireEvent.change(screen.getByLabelText(locale === 'en' ? 'Member position (m)' : '沿构件位置 (m)'), { target: { value: '2' } })
    expect(scene).toHaveAttribute('data-position', '2')
    expect(posts).toHaveLength(1)
  })

  it('changes case in place and hides a queried value outside its matching view', async () => {
    const posts = workspaceFixture()
    render(<ResultReviewPanel open conversationId="A" locale="en" disabled={false} onClose={() => {}} onUsageChanged={() => {}} />)
    const scene = await screen.findByTestId('test-scene')
    fireEvent.change(screen.getByLabelText('Case / combination'), { target: { value: 'case:L' } })
    await waitFor(() => expect(scene).toHaveAttribute('data-case', 'case:L'))
    expect(screen.getByTestId('test-scene')).toBe(scene)
    expect(posts[1]).toMatchObject({ revisionToken: 'v2', args: { resultKey: 'case:L' } })
    fireEvent.click(screen.getByRole('button', { name: 'Query selected result' }))
    expect(await screen.findByTestId('workspace-query-result')).toHaveTextContent('-2.00 mm')
    fireEvent.click(screen.getByRole('button', { name: 'Model', exact: true }))
    expect(screen.queryByTestId('workspace-query-result')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Deformed', exact: true }))
    expect(screen.getByTestId('workspace-query-result')).toHaveTextContent('-2.00 mm')
    fireEvent.change(screen.getByLabelText('Object kind'), { target: { value: 'member' } })
    expect(screen.queryByTestId('workspace-query-result')).toBeNull()
    expect(scene).toHaveAttribute('data-view', 'forces')
    fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'V3' } })
    expect(screen.getByRole('button', { name: /^V3 ·/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it.each(['en', 'zh'] as const)('preserves the scene, scale, camera and selected object through fullscreen and Escape (%s)', async locale => {
    testLocale.current = locale
    workspaceFixture()
    const onClose = vi.fn(), m = messages[locale]
    render(<ResultReviewPanel open conversationId="A" locale={locale} disabled={false} onClose={onClose} onUsageChanged={() => {}} />)
    const scene = await screen.findByTestId('test-scene')
    fireEvent.click(screen.getByTestId('scene-node-b'))
    fireEvent.change(screen.getByRole('slider'), { target: { value: '150' } })
    fireEvent.click(screen.getByRole('button', { name: m.visualizationCameraTop, exact: true }))
    const scale = scene.getAttribute('data-scale')
    fireEvent.click(screen.getByRole('button', { name: m.visualizationFullscreen, exact: true }))
    const modal = screen.getByRole('dialog', { name: m.visualizationTitle })
    expect(within(modal).getByTestId('test-scene')).toBe(scene)
    expect(scene).toHaveAttribute('data-node', 'b')
    expect(scene).toHaveAttribute('data-camera', 'top')
    expect(scene).toHaveAttribute('data-scale', scale)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: m.visualizationTitle })).toBeNull()
    expect(screen.getByTestId('test-scene')).toBe(scene)
    expect(scene).toHaveAttribute('data-scale', scale)
    expect(screen.getByLabelText(locale === 'en' ? 'Object' : '对象')).toHaveValue('b')
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('offers only Model, Diagram and Reactions for a force-only placeholder', async () => {
    workspaceFixture(true)
    render(<ResultReviewPanel open conversationId="A" locale="en" disabled={false} onClose={() => {}} onUsageChanged={() => {}} />)
    expect(await screen.findByTestId('test-scene')).toHaveAttribute('data-view', 'reactions')
    for (const name of ['Model', 'Diagram', 'Reactions']) expect(screen.getByRole('button', { name, exact: true })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Deformed', exact: true })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen', exact: true }))
    expect(screen.queryByRole('button', { name: 'Deformed', exact: true })).toBeNull()
  })

  it('discards a pending snapshot when the workspace closes', async () => {
    const posts = workspaceFixture()
    const fetchFixture = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const response = await fetchFixture(...args)
      if (args[1]?.method) await gate
      return response
    })
    const props = { conversationId: 'A', locale: 'en' as const, disabled: false, onClose: vi.fn(), onUsageChanged: vi.fn() }
    const { rerender } = render(<ResultReviewPanel {...props} open />)
    await waitFor(() => expect(posts).toHaveLength(1))
    rerender(<ResultReviewPanel {...props} open={false} />)
    await act(async () => { release(); await gate })
    expect(screen.queryByTestId('test-scene')).toBeNull()
    expect(props.onUsageChanged).not.toHaveBeenCalled()
  })

  it('keeps the scene and selectors aligned while a quantity query is pending', async () => {
    workspaceFixture()
    const fetchFixture = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const response = await fetchFixture(...args)
      if (args[1]?.body && JSON.parse(String(args[1].body)).args.component) await gate
      return response
    })
    render(<ResultReviewPanel open conversationId="A" locale="en" disabled={false} onClose={() => {}} onUsageChanged={() => {}} />)
    const scene = await screen.findByTestId('test-scene')
    fireEvent.click(screen.getByRole('button', { name: 'Query selected result' }))
    await waitFor(() => expect(screen.getByLabelText('Object')).toBeDisabled())
    fireEvent.click(screen.getByTestId('scene-node-b'))
    expect(scene).toHaveAttribute('data-node', 'a')
    expect(screen.getByLabelText('Object')).toHaveValue('a')
    await act(async () => { release(); await gate })
    await screen.findByTestId('workspace-query-result')
    fireEvent.click(screen.getByTestId('scene-node-b'))
    expect(scene).toHaveAttribute('data-node', 'b')
    expect(screen.getByLabelText('Object')).toHaveValue('b')
    expect(screen.queryByTestId('workspace-query-result')).toBeNull()
  })
})

it.each([
  [false, {}, 'Analysis result'],
  [true, {}, '分析结果'],
  [false, { description: 'South bridge' }, 'South bridge'],
  [true, { structureType: '三维框架' }, '三维框架'],
  [false, { frameDimension: '3d' }, 'Analysis result'],
] as const)('uses a human figure title and separate run provenance (%s, %j)', (zh, metadata, expected) => {
  const selection = { runId: '0494e9c1-573d-4000-8000-123456789abc', resultKey: 'case:D',
    nodeId: 'b', timeIndex: 1, field: 'displacements', component: 'uz', unit: 'mm' }
  const snapshot = selectedResultSnapshot({ ...result, modelSnapshot: { ...model, metadata } }, selection, zh)!
  expect(snapshot.title).toBe(`${expected} · D · t=0.03 s`)
  expect(snapshot.title).not.toContain(selection.runId)
  expect(snapshot.title).not.toContain('case:')
  expect(snapshot.runId).toBe(selection.runId)
})

describe('one selected result for query, curve and report', () => {
  it.each(['zh','en'] as const)('uses exact time and archived run, clearing old values on a new selection (%s)', async locale => {
    testLocale.current = locale
    const posts: {tool:string;args:Record<string,unknown>;revisionToken:string}[]=[]
    vi.stubGlobal('fetch',vi.fn(async (_url:string,init?:RequestInit) => {
      if (!init?.method) return {ok:true,json:async()=>catalog}
      const body=JSON.parse(String(init.body))
      if (body.tool === 'query_results' && !body.args.component) return {ok:true,json:async()=>({success:true,result:{...result,runId:body.args.runId,resultKey:body.args.resultKey},review:catalog})}
      posts.push(body)
      const value=body.tool==='generate_report'?{report:{markdown:'bound selected report',json:{requestedSelection:body.args.selection}}}
        :body.args.series?{runId:body.args.runId,resultKey:body.args.resultKey,series:{unit:'mm',component:'uz',stride:1,points:[{timeIndex:0,time:0,value:0},{timeIndex:1,time:.03,value:-2}]}}:{...result,runId:body.args.runId,resultKey:body.args.resultKey}
      return {ok:true,json:async()=>({success:true,result:value,review:{...catalog,revisionToken:`v${posts.length+1}`}})}
    }))
    const labels=locale==='zh'?{query:'查询所选结果',time:'时间索引',report:'生成所选报告',curve:'读取响应曲线',run:'运行'}:{query:'Query selected result',time:'Time index',report:'Report selected result',curve:'Read response curve',run:'Run'}
    render(<ResultReviewPanel open conversationId="A" locale={locale} disabled={false} onClose={()=>{}} onUsageChanged={()=>{}} />)
    const time=await screen.findByLabelText(labels.time)
    await waitFor(() => expect(time).toBeEnabled())
    fireEvent.change(time,{target:{value:'1'}})
    await waitFor(() => expect(screen.getByRole('button',{name:labels.query})).toBeEnabled())
    fireEvent.click(screen.getByRole('button',{name:labels.query}))
    expect(await screen.findByTestId('workspace-query-result')).toHaveTextContent('-2.00')
    expect(posts[0].args).toMatchObject({runId:'now',resultKey:'analysis:dynamic',timeIndex:1,nodeId:'a',component:'uz',unit:'mm',includeModelSnapshot:true})
    fireEvent.click(screen.getByRole('button',{name:labels.report}))
    await screen.findByText('bound selected report')
    expect(posts[1]).toMatchObject({revisionToken:'v2',tool:'generate_report',args:{narrative:'structured',selection:{runId:'now',timeIndex:1,resultKey:'analysis:dynamic'}}})
    fireEvent.click(screen.getByRole('button',{name:labels.curve}))
    await screen.findByRole('img',{name:locale==='zh'?'响应随时间变化':'Response over time'})
    expect(posts[2].args.timeIndex).toBeUndefined();expect(posts[2].args.series).toEqual({startIndex:0,endIndex:2,stride:1})
    fireEvent.change(screen.getByLabelText(labels.run),{target:{value:'old'}})
    expect(screen.queryByTestId('workspace-query-result')).toBeNull();expect(screen.queryByText('bound selected report')).toBeNull()
    expect(screen.getByRole('button',{name:labels.report})).toBeDisabled()
    await waitFor(() => expect(screen.getByRole('button',{name:labels.query})).toBeEnabled())
    fireEvent.click(screen.getByRole('button',{name:labels.query}))
    await waitFor(()=>expect(posts).toHaveLength(4))
    expect(posts[3].args).toMatchObject({runId:'old',resultKey:'case:D'});expect(posts[3].args.timeIndex).toBeUndefined()
  })

  it('unavailable saved results are visible but cannot query, and disabled tools cannot execute', async () => {
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({...catalog,allowedTools:[],runs:[{...catalog.runs[0],results:[{...catalog.runs[0].results[0],available:false}]}]})})))
    render(<ResultReviewPanel open conversationId="A" locale="en" disabled={false} onClose={()=>{}} onUsageChanged={()=>{}} />)
    await screen.findByText('case:D (unavailable)')
    expect(screen.getByRole('button',{name:'Query selected result'})).toBeDisabled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['unavailable', {stiffnessPlaceholder:true,unavailable:['displacements','rotations']}],
    ['available', {available:['forces','reactions']}],
  ])('a force-only run (%s) defaults to reactions and never offers displacements', async (_kind, responseDefinition) => {
    const posts: {args:Record<string,unknown>}[]=[]
    const forceOnly={...catalog,runs:[{...catalog.runs[0],current:true,results:[{...catalog.runs[0].results[0],responseDefinition}]}]}
    vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{
      if (!init?.method) return {ok:true,json:async()=>forceOnly}
      const body = JSON.parse(String(init.body))
      if (body.args.component) posts.push(body)
      return {ok:true,json:async()=>({success:true,result:{runId:'old',resultKey:'case:D',quantity:{value:1,unit:'kN'}},review:forceOnly})}
    }))
    render(<ResultReviewPanel open conversationId="A" locale="en" disabled={false} onClose={()=>{}} onUsageChanged={()=>{}} />)
    const response=await screen.findByLabelText('Response') as HTMLSelectElement
    expect([...response.options].map(option=>option.value)).toEqual(['reactions'])
    await waitFor(() => expect(screen.getByRole('button',{name:'Query selected result'})).toBeEnabled())
    fireEvent.click(screen.getByRole('button',{name:'Query selected result'}))
    await waitFor(()=>expect(posts).toHaveLength(1))
    expect(posts[0].args).toMatchObject({field:'reactions',component:'fz',unit:'kN'})
  })
})

it('mode and time figures use archived geometry and never invent unobserved node translations', () => {
  const selection={runId:'old',resultKey:'analysis:modal',nodeId:'b',modeNumber:1,field:'displacements',component:'uz',unit:'1'}
  const shape=selectedResultSnapshot({...result,visualizationData:{displacements:{a:{ux:0,uy:0,uz:0},b:{ux:0,uy:0,uz:-1}}}},selection,true)!
  expect(shape.nodes.find(node=>node.id==='b')?.position.x).toBe(4)
  expect(shape.displacementUnit).toBe('1');expect(shape.displacementDisplayFactor).toBe(1)
  expect(shape.availableViews).toContain('deformed');expect(shape.cases[0].memberResponses).toBeUndefined()
  const partial=selectedResultSnapshot({...result,visualizationData:{displacements:{b:{uz:-.002}},time:.03}}, {...selection,modeNumber:undefined,timeIndex:1,unit:'mm'},false)!
  expect(partial.availableViews).not.toContain('deformed');expect(partial.cases[0].nodeResults.a).toBeUndefined()
  expect(partial.cases[0].nodeResults.b.displacement?.ux).toBeUndefined()
})

it('static figures retain full solver fields when effective nodal loads include equivalent component and vector readback', () => {
  const meta = { runId: 'now', modelHash: 'model', settingsHash: 'settings', coordinateSemantics: 'global-z-up',
    coordinateContractVersion: 1, dimension: '3d', plane: null, dofOrder: ['ux','uy','uz','rx','ry','rz'],
    activeDofs: ['ux','uy','uz','rx','ry','rz'], nodalResultFrame: 'global', elementForceFrame: 'element-local' }
  const effectiveLoad = { type: 'nodal', node: 'b', reference_frame: 'global',
    fx: 0, fy: 0, fz: -1, mx: 2, my: 3, mz: 4, forces: [0, 0, -1, 2, 3, 4] }
  const data = { meta, effectiveLoads: [effectiveLoad],
    displacements: { a: { ux: 0, uy: 0, uz: 0 }, b: { ux: 0, uy: 0, uz: -.002 } },
    reactions: { a: { fx: 0, fy: 0, fz: 1 } },
    forces: { e: { axial: 0, n1: { N: 0, V: 1, M: 4, V3: 1, M2: 4 }, n2: { N: 0, V: -1, M: 0, V3: -1, M2: 0 } } },
    memberResponses: [{ id: 'e', state: 'recovered', reason: 'checked', length: 4, samples: [
      { x: 0, position: [0,0,0], displacement: [0,0,0] },
      { x: 2, position: [2,0,0], displacement: [0,0,-.0006] },
      { x: 4, position: [4,0,0], displacement: [0,0,-.002] },
    ] }] }
  const selection = { runId: 'now', resultKey: 'case:D', nodeId: 'b', field: 'displacements', component: 'uz', unit: 'mm' }
  const output = { runId: 'now', meta, resultSelection: { key: 'case:D', kind: 'case', id: 'D' },
    modelSnapshot: model, visualizationData: data, quantity: { value: 12345, unit: 'mm' } }
  const snapshot = selectedResultSnapshot(output, selection, false)!
  expect(snapshot.cases[0].resultStatus).toBe('available')
  expect(snapshot.availableViews).toEqual(expect.arrayContaining(['deformed', 'forces', 'reactions']))
  expect(snapshot.cases[0].nodeResults.b.displacement?.uz).toBe(-.002)
  expect(snapshot.cases[0].memberResponses?.e.samples[1].displacement?.[2]).toBe(-.0006)
  expect(snapshot.loads).toEqual(expect.arrayContaining([
    expect.objectContaining({ nodeId: 'b', caseId: 'case:D', kind: 'nodal', referenceFrame: 'global', vector: { x: 0, y: 0, z: -1 } }),
    expect.objectContaining({ nodeId: 'b', caseId: 'case:D', kind: 'moment', referenceFrame: 'global', vector: { x: 2, y: 3, z: 4 } }),
  ]))
  expect(data.effectiveLoads[0].forces).toEqual([0, 0, -1, 2, 3, 4])
  const conflict = selectedResultSnapshot({ ...output, visualizationData: {
    ...data, effectiveLoads: [{ ...effectiveLoad, forces: [0, 0, -2, 2, 3, 4] }],
  } }, selection, false)!
  expect(conflict.cases[0].resultStatus).toBe('unavailable')
  expect(conflict.availableViews).toEqual(['model'])
  const wrongFrame = selectedResultSnapshot({ ...output, visualizationData: {
    ...data, effectiveLoads: [{ ...effectiveLoad, reference_frame: 'element-local' }],
  } }, selection, false)!
  expect(wrongFrame.cases[0].resultStatus).toBe('unavailable')
  expect(buildVisualizationSnapshot({ title: 'Invalid source load', mode: 'model-only',
    model: { ...model, load_cases: [{ id: 'D', loads: [effectiveLoad] }] },
  })).toBeNull()
  const scalarOnly = selectedResultSnapshot({ ...output, visualizationData: { meta } }, selection, false)!
  expect(scalarOnly.availableViews).toEqual(['model'])
  expect(scalarOnly.cases[0].nodeResults).toEqual({})
})

it('runs native design through the same conversation and reports the returned design run, not the historical selector', async () => {
  const posts: { tool: string; revisionToken: string; args: Record<string, unknown> }[] = []
  const native = { modelRevision: 3, modelHash: 'hash', runId: 'now', available: true, reason: null,
    options: { engine: 'yjk', codes: ['GB50017-2017'], modes: ['code-check'], parameters: [] }, latestAttempt: null, acceptedRecords: [] }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toContain('/result-review/A')
    if (!init?.method) return { ok: true, json: async () => ({ ...catalog, allowedTools: ['query_results', 'run_code_check', 'generate_report'], nativeDesign: native }) }
    const body = JSON.parse(String(init.body))
    if (body.tool === 'query_results' && !body.args.component) return { ok: true, json: async () => ({ success: true, result: { ...result, runId: body.args.runId, resultKey: body.args.resultKey },
      review: { ...catalog, allowedTools: ['query_results', 'run_code_check', 'generate_report'], nativeDesign: native } }) }
    posts.push(body)
    const value = body.tool === 'run_code_check' ? { success: true, runId: 'designed' }
      : { report: { markdown: 'bound design report', json: { meta: { runId: 'designed' }, requestedSelection: body.args.selection } } }
    return { ok: true, json: async () => ({ success: true, result: value, review: { ...catalog, revisionToken: 'v2', allowedTools: ['query_results', 'run_code_check', 'generate_report'],
      nativeDesign: { ...native, acceptedRecords: [{ designRecordId: 'design', designCode: 'GB50017-2017', completionStatus: 'complete', complianceStatus: 'fail',
        meta: { runId: 'designed', modelRevision: 3 }, current: true }] } } }) }
  }))
  render(<ResultReviewPanel open conversationId="A" locale="en" disabled={false} onClose={() => {}} onUsageChanged={() => {}} />)
  const code = await screen.findByLabelText('Design code / profile')
  await waitFor(() => expect(screen.getByLabelText('Run')).toBeEnabled())
  fireEvent.change(screen.getByLabelText('Run'), { target: { value: 'old' } })
  await waitFor(() => expect(screen.getByLabelText('Run')).toBeEnabled())
  fireEvent.change(code, { target: { value: 'GB50017-2017' } })
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Run native design' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Report this design' }))
  await screen.findByText('bound design report')
  expect(posts[0]).toEqual({ revisionToken: 'v1', tool: 'run_code_check', args: { designCode: 'GB50017-2017', provider: 'native', design: { mode: 'code-check', adoptedNativeDefaults: true, parameters: {} } } })
  expect(posts[1]).toMatchObject({ revisionToken: 'v2', tool: 'generate_report', args: { selection: { runId: 'designed' }, narrative: 'structured' } })
  expect(screen.getByLabelText('Run')).toHaveValue('old')
})
