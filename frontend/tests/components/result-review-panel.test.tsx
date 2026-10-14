import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResultReviewPanel, selectedResultSnapshot } from '@/components/chat/result-review-panel'

vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/chat/markdown-body', () => ({ MarkdownBody: ({ content }: { content: string }) => <div>{content}</div> }))
vi.mock('@/components/ui/dialog-shell', () => ({ DialogShell: ({ open, children, title }: { open: boolean; children: React.ReactNode; title: string }) => open ? <div aria-label={title}>{children}</div> : null }))
const model = {schema_version:'2.1',unit_system:'SI',coordinate_system:{semantics:'global-z-up',version:1,dimension:'3d',plane:null,dof_order:['ux','uy','uz','rx','ry','rz']},nodes:[{id:'a',x:0,y:0,z:0},{id:'b',x:4,y:0,z:0}],elements:[{id:'e',type:'beam',nodes:['a','b']}],materials:[],sections:[],load_cases:[]}
const catalog = { conversationId:'A',revisionToken:'v1',currentRunId:'now',allowedTools:['query_results','generate_report'],runs:[
  {runId:'old',current:false,analysisType:'static',selectedResultKey:'case:D',nodes:['a','b'],members:['e'],results:[{key:'case:D',available:true,modes:[],times:[]}]},
  {runId:'now',current:true,analysisType:'dynamic',selectedResultKey:'analysis:dynamic',nodes:['a','b'],members:['e'],results:[{key:'analysis:dynamic',available:true,modes:[],times:[{index:0,time:0},{index:1,time:.03},{index:2,time:.11}]}]},
] }
const result = {runId:'now',resultKey:'analysis:dynamic',quantity:{value:-2,unit:'mm',time:.03},modelSnapshot:model,visualizationData:{time:.03,displacements:{a:{ux:0,uy:0,uz:0},b:{ux:0,uy:0,uz:-.002}}}}
beforeEach(() => vi.restoreAllMocks())

describe('one selected result for query, curve and report', () => {
  it.each(['zh','en'] as const)('uses exact time and archived run, clearing old values on a new selection (%s)', async locale => {
    const posts: {tool:string;args:Record<string,unknown>;revisionToken:string}[]=[]
    vi.stubGlobal('fetch',vi.fn(async (_url:string,init?:RequestInit) => {
      if (!init?.method) return {ok:true,json:async()=>catalog}
      const body=JSON.parse(String(init.body)); posts.push(body)
      const value=body.tool==='generate_report'?{report:{markdown:'bound selected report',json:{requestedSelection:body.args.selection}}}
        :body.args.series?{runId:body.args.runId,resultKey:body.args.resultKey,series:{unit:'mm',component:'uz',stride:1,points:[{timeIndex:0,time:0,value:0},{timeIndex:1,time:.03,value:-2}]}}:{...result,runId:body.args.runId,resultKey:body.args.resultKey}
      return {ok:true,json:async()=>({success:true,result:value,review:{...catalog,revisionToken:`v${posts.length+1}`}})}
    }))
    const labels=locale==='zh'?{query:'查询所选结果',time:'时间索引',report:'生成所选报告',curve:'读取响应曲线',run:'运行'}:{query:'Query selected result',time:'Time index',report:'Report selected result',curve:'Read response curve',run:'Run'}
    render(<ResultReviewPanel open conversationId="A" locale={locale} disabled={false} onClose={()=>{}} onUsageChanged={()=>{}} />)
    const time=await screen.findByLabelText(labels.time)
    fireEvent.change(time,{target:{value:'1'}})
    fireEvent.click(screen.getByRole('button',{name:labels.query}))
    await screen.findByText('-2.000000000')
    expect(posts[0].args).toMatchObject({runId:'now',resultKey:'analysis:dynamic',timeIndex:1,nodeId:'a',component:'uz',unit:'mm',includeModelSnapshot:true})
    fireEvent.click(screen.getByRole('button',{name:labels.report}))
    await screen.findByText('bound selected report')
    expect(posts[1]).toMatchObject({revisionToken:'v2',tool:'generate_report',args:{narrative:'structured',selection:{runId:'now',timeIndex:1,resultKey:'analysis:dynamic'}}})
    fireEvent.click(screen.getByRole('button',{name:labels.curve}))
    await screen.findByRole('img',{name:locale==='zh'?'响应随时间变化':'Response over time'})
    expect(posts[2].args.timeIndex).toBeUndefined();expect(posts[2].args.series).toEqual({startIndex:0,endIndex:2,stride:1})
    fireEvent.change(screen.getByLabelText(labels.run),{target:{value:'old'}})
    expect(screen.queryByText('-2.000000000')).toBeNull();expect(screen.queryByText('bound selected report')).toBeNull()
    expect(screen.getByRole('button',{name:labels.report})).toBeDisabled()
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
