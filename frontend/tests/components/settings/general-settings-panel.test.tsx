import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GeneralSettingsPanel } from '@/components/settings/general-settings-panel'

function settingsPayload(detachedHouseApiBaseUrl = 'http://127.0.0.1:8569') {
  return {
    detachedHouse: {
      apiBaseUrl: {
        value: detachedHouseApiBaseUrl,
        source: detachedHouseApiBaseUrl === 'http://127.0.0.1:8569' ? 'default' : 'runtime',
        defaultValue: 'http://127.0.0.1:8569',
      },
    },
  }
}

describe('GeneralSettingsPanel detached-house API setting', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the detached-house API URL with the local default and unavailable notice', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(settingsPayload()),
    } as unknown as Response)

    render(<GeneralSettingsPanel />)

    expect(await screen.findByText('Detached House API')).toBeInTheDocument()
    expect(screen.getByLabelText('API URL')).toHaveValue('http://127.0.0.1:8569')
    expect(screen.getByText(/not currently available/i)).toBeInTheDocument()
  })

  it('saves the detached-house API URL under detachedHouse.apiBaseUrl', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(settingsPayload()),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(settingsPayload('http://127.0.0.1:9999')),
      } as unknown as Response)

    render(<GeneralSettingsPanel />)

    const input = await screen.findByLabelText('API URL')
    fireEvent.change(input, { target: { value: 'http://127.0.0.1:9999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    const saveCall = fetchMock.mock.calls[1]
    expect(String(saveCall?.[0])).toMatch(/\/api\/v1\/admin\/settings$/)
    expect(saveCall?.[1]).toMatchObject({ method: 'PUT' })
    expect(JSON.parse(String((saveCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      detachedHouse: {
        apiBaseUrl: 'http://127.0.0.1:9999',
      },
    })
  })
})
