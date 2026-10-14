import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RunSettings } from '@/components/chat/run-settings'

describe('run settings', () => {
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
})
