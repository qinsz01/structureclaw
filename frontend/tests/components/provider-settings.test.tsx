import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderSettingsPanel } from '@/components/settings/provider-settings-panel'
import { AppStoreContext, createAppStore } from '@/lib/stores/context'

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); document.cookie = 'structureclaw.locale=; Max-Age=0; path=/' })

describe.each(['en', 'zh'] as const)('provider settings (%s)', locale => {
  it('shows installation separately from licence evidence and persists explicit disables', async () => {
    document.cookie = `structureclaw.locale=${locale}; path=/`
    let policy = {}
    const saved: unknown[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (String(input).endsWith('/providers')) return Response.json({ providers: [{
        id: 'yjk-static', kind: 'solver', name: { en: 'YJK', zh: '盈建科' }, description: { en: 'Frame statics', zh: '框架静力分析' },
        availability: { installed: true, configured: true, licence: 'unknown' }, enabled: true,
      }] })
      if (options?.method === 'PUT') { policy = JSON.parse(String(options.body)).agent.runPolicy; saved.push(policy) }
      return Response.json({ agent: { runPolicy: { value: policy }, toolCallCeiling: 200 } })
    })
    render(<AppStoreContext.Provider value={createAppStore({ locale })}><ProviderSettingsPanel /></AppStoreContext.Provider>)
    const checkbox = await screen.findByRole('checkbox', { name: locale === 'en' ? 'Allow provider: YJK' : '允许使用此 Provider: 盈建科' })
    expect(screen.getByText(locale === 'en' ? /Licence verified by a real job/ : /许可证须通过实际作业验证/)).toBeInTheDocument()
    await waitFor(() => expect(checkbox).toBeEnabled())
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Save provider preferences' : '保存 Provider 偏好' }))
    await waitFor(() => expect(saved).toEqual([{ providers: { disabledIds: ['yjk-static'] } }]))
  })
})
