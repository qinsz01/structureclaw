import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunSettings } from '@/components/chat/run-settings'
import type { ConversationRuntimeSnapshot } from '@/components/chat/use-conversation-runtime'

afterEach(cleanup)

describe('run settings', () => {
  it.each(['en', 'zh'] as const)('shows actual policy and consumed budget independently of the requested controls (%s)', locale => {
    const runtime: ConversationRuntimeSnapshot = { conversationId: 'a', busy: false, waitingForReply: true, question: 'Support?', options: [],
      modelRevision: 4, modelPending: false, analysis: { current: false, runId: 'old-run', resultKey: 'case:D', reason: 'MODEL_REBUILD_REQUIRED' },
      report: { current: false, runId: null }, jobs: [], usage: { runId: 'turn-a', policyHash: 'hash-a', toolCalls: 7, llmCalls: 3, recoveries: 1 },
      policy: { version: 1, policyHash: 'hash-a', knowledge: 'disabled', builder: 'llm', skillIds: ['generic'], routing: { mode: 'auto' },
        repair: { enabled: true, maxRecoveriesPerTurn: 2 }, context: { history: 'full', memoryScopes: ['conversation'] },
        tools: { enabledIds: ['query_model'], disabledIds: [] }, budgets: { maxToolCallsPerTurn: 20, maxLlmCallsPerTurn: 5 },
        activeSkillIds: ['generic'], activeToolIds: ['query_model'], deniedSkillIds: [], deniedToolIds: ['shell'], executionOwner: 'structureclaw',
        fieldSources: { knowledge: 'session', builder: 'request', 'budgets.maxToolCallsPerTurn': 'server-limit' },
        enforcement: { hostLoop: 'structureclaw', conversationText: 'structureclaw', llmBudget: 'structureclaw-calls', recovery: 'structureclaw-operations' }, compatibilityNotes: [] } }
    const onChange = vi.fn()
    render(<RunSettings value={{ knowledge: 'enabled' }} onChange={onChange} locale={locale} disabled runtime={runtime} />)
    expect(screen.getByText(locale === 'en' ? 'Effective policy (server)' : '实际生效（服务端）')).toBeInTheDocument()
    expect(screen.getByText(/7\/20.*3\/5.*1\/2/)).toBeInTheDocument()
    expect(screen.getByText(/old-run/)).toHaveTextContent(locale === 'en' ? 'Historical' : '历史')
    expect(screen.getByLabelText(locale === 'en' ? 'Professional guidance' : '专业指导')).toHaveValue('enabled')
    expect(screen.getByText(/Support\?/)).toBeInTheDocument()
    expect(screen.getByText(/hash-a/)).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('updates one control without changing knowledge, tools or engineering history implicitly', () => {
    const onChange = vi.fn()
    render(<RunSettings value={{knowledge:'enabled',tools:{enabledIds:[]}}} onChange={onChange} locale="en" disabled={false} />)
    fireEvent.change(screen.getByLabelText('Model builder'), {target:{value:'llm'}})
    expect(onChange).toHaveBeenCalledWith({knowledge:'enabled',tools:{enabledIds:[]},builder:'llm'})
    fireEvent.change(screen.getByLabelText('Automatic correction after failure'), {target:{value:'0'}})
    expect(onChange).toHaveBeenLastCalledWith({knowledge:'enabled',tools:{enabledIds:[]},repair:{enabled:false,maxRecoveriesPerTurn:0}})
  })
  it('keeps the active run immutable and provides bilingual labels', () => {
    render(<RunSettings value={{}} onChange={vi.fn()} locale="zh" disabled />)
    expect(screen.getByLabelText('专业指导')).toBeDisabled()
    expect(screen.getByText('运行设置')).toBeInTheDocument()
    expect(screen.getByText(/工程校验始终开启/)).toBeInTheDocument()
  })
  it.each(['en', 'zh'] as const)('keeps advanced routing, empty memory and nullable LLM limit explicit (%s)', locale => {
    const onChange = vi.fn()
    const value = { tools: { enabledIds: [] }, context: { history: 'current-turn' as const }, budgets: { maxToolCallsPerTurn: 12 } }
    render(<RunSettings value={value} onChange={onChange} locale={locale} disabled={false} modelingSkills={[{ id: 'beam', label: 'Beam' }]} />)
    fireEvent.change(screen.getByLabelText(locale === 'en' ? 'Skill routing' : '技能路由'), { target: { value: 'skill:beam' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...value, routing: { mode: 'fixed', skillId: 'beam' } })
    fireEvent.change(screen.getByLabelText(locale === 'en' ? 'Memory read and write scope' : '记忆读取与写入范围'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...value, context: { history: 'current-turn', memoryScopes: [] } })
    fireEvent.click(screen.getByLabelText(locale === 'en' ? 'Do not request an LLM call limit' : '不申请 LLM 调用上限'))
    expect(onChange).toHaveBeenLastCalledWith({ ...value, budgets: { maxToolCallsPerTurn: 12, maxLlmCallsPerTurn: null } })
    fireEvent.change(screen.getByLabelText(locale === 'en' ? 'Internal LLM call limit' : '内部 LLM 调用上限'), { target: { value: '5' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...value, budgets: { maxToolCallsPerTurn: 12, maxLlmCallsPerTurn: 5 } })
  })
})
