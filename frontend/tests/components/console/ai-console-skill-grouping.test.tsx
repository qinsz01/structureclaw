import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PolicySettingsPanel } from '@/components/settings/policy-settings-panel'
import { AIConsole } from '@/components/chat/ai-console'
import { AppStoreContext, createAppStore } from '@/lib/stores/context'
import { CAPABILITY_PREFERENCE_STORAGE_KEY } from '@/lib/capability-preference'

const skills = ['beam','generic'].map(id => ({id,domain:'structure-type',name:{en:id,zh:id},description:{en:id,zh:id}}))
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); document.cookie='structureclaw.locale=; Max-Age=0; path=/' })

describe('unified skill settings and console integration', () => {
  it('saves a structure-only restriction in server defaults and exposes no tool switches', async () => {
    let policy: Record<string, unknown> = {}
    const writes: unknown[] = []
    vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
      if(String(input).endsWith('/agent/skills')) return Response.json({skills})
      if(init?.method==='PUT'){policy=JSON.parse(String(init.body)).agent.runPolicy;writes.push(policy)}
      return Response.json({agent:{runPolicy:{value:policy},toolCallCeiling:200}})
    })
    render(<AppStoreContext.Provider value={createAppStore()}><PolicySettingsPanel section="skills" /></AppStoreContext.Provider>)
    await waitFor(() => expect(screen.getByLabelText('Structure skills')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Structure skills'),{target:{value:'restricted'}})
    fireEvent.click(screen.getByLabelText('generic'))
    fireEvent.click(screen.getByRole('button',{name:'Save'}))
    await waitFor(() => expect(writes).toEqual([{skillIds:['beam'],routing:{mode:'auto'}}]))
    expect(screen.queryByText('Run analysis')).not.toBeInTheDocument()
    expect(localStorage.getItem(CAPABILITY_PREFERENCE_STORAGE_KEY)).toBeNull()
  })

  it('new conversations inherit server defaults without duplicating skills or tool lists in requests', async () => {
    const sent: Array<Record<string, unknown>>=[]
    vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
      const url=String(input)
      if(url.endsWith('/admin/settings')) return Response.json({agent:{runPolicy:{value:{skillIds:['beam']}}}})
      if(url.endsWith('/skills')) return Response.json({skills})
      if(url.endsWith('/capability-matrix')) return Response.json({skills,tools:[{id:'run_analysis',enabledByDefault:true}]})
      if(url.endsWith('/conversations')) return Response.json([])
      if(url.endsWith('/analysis-engines')) return Response.json({engines:[]})
      if(url.endsWith('/conversation')) return Response.json({id:'fresh'})
      if(url.endsWith('/session')) return Response.json({conversationId:'fresh',busy:false,waitingForReply:false,policy:null,analysis:{},report:{},jobs:[],modelRevision:0})
      if(url.includes('/chat/stream')) {sent.push(JSON.parse(String(init?.body)));return new Response('data: {"type":"done"}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})}
      return Response.json({})
    })
    const store=createAppStore()
    render(<AppStoreContext.Provider value={store}><AIConsole /></AppStoreContext.Provider>)
    await waitFor(() => expect(store.getState().capabilitySkillIds).toEqual(['beam']))
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'Analyze this structure'}})
    fireEvent.click(screen.getByRole('button',{name:'Send'}))
    await waitFor(() => expect(sent).toHaveLength(1))
    const context=sent[0].context as Record<string, unknown>
    expect(context.skillIds).toBeUndefined();expect(context.enabledToolIds).toBeUndefined()
    expect(context.autoCodeCheck).toBeUndefined()
  })

  it('failed global settings loads preserve legacy preferences for a later retry', async () => {
    const original=JSON.stringify({explicit:true,skillIds:['beam'],toolIds:[]})
    localStorage.setItem(CAPABILITY_PREFERENCE_STORAGE_KEY,original)
    vi.spyOn(globalThis,'fetch').mockImplementation(async input => String(input).endsWith('/skills') ? Response.json({skills})
      : String(input).endsWith('/capability-matrix') ? Response.json({tools:[]})
      : String(input).endsWith('/admin/settings') ? new Response('{}',{status:503}) : Response.json([]))
    render(<AppStoreContext.Provider value={createAppStore()}><AIConsole /></AppStoreContext.Provider>)
    await screen.findByRole('button',{name:'Retry capability loading'})
    expect(localStorage.getItem(CAPABILITY_PREFERENCE_STORAGE_KEY)).toBe(original)
  })
})
