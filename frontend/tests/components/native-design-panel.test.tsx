import React from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NativeDesignPanel, type NativeDesignReview } from '@/components/chat/native-design-panel'

const review: NativeDesignReview = { modelRevision: 3, modelHash: 'model-hash', runId: 'current', available: true, reason: null,
  options: { engine: 'pkpm', codes: ['PKPM-2025R2.5-native'], modes: ['code-check', 'required-reinforcement'], parameters: [
    { key: 'beamCoverMm', kind: 'integer', min: 10, max: 100, unit: 'mm', label: { zh: '梁保护层', en: 'Beam cover' } },
    { key: 'beamStirrupSpacingMm', kind: 'integer', min: 100, max: 100, unit: 'mm', label: { zh: '梁原生设计箍筋间距', en: 'Beam native design stirrup spacing' } },
  ] }, latestAttempt: null, acceptedRecords: [] }
beforeEach(() => vi.restoreAllMocks())

it.each(['en', 'zh'] as const)('requires explicit native defaults and only sends entered, supported parameters (%s)', async locale => {
  const execute = vi.fn(async () => {}), report = vi.fn(async () => {})
  const labels = locale === 'en' ? { code: 'Design code / profile', purpose: 'Design purpose', button: 'Run native design', cover: 'Beam cover (mm)', spacing: 'Beam native design stirrup spacing (mm)' }
    : { code: '设计规范／配置', purpose: '设计目的', button: '执行原生设计', cover: '梁保护层 (mm)', spacing: '梁原生设计箍筋间距 (mm)' }
  const { rerender } = render(<NativeDesignPanel review={review} locale={locale} disabled={false} reportAllowed onExecute={execute} onReport={report} />)
  expect(screen.getByRole('button', { name: labels.button })).toBeDisabled()
  fireEvent.change(screen.getByLabelText(labels.code), { target: { value: 'PKPM-2025R2.5-native' } })
  fireEvent.change(screen.getByLabelText(labels.purpose), { target: { value: 'required-reinforcement' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByLabelText(labels.cover), { target: { value: '25' } })
  fireEvent.change(screen.getByLabelText(labels.spacing), { target: { value: '80' } })
  expect(screen.getByRole('button', { name: labels.button })).toBeDisabled()
  expect(screen.getByRole('alert')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText(labels.spacing), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: labels.button }))
  await waitFor(() => expect(execute).toHaveBeenCalledWith({ designCode: 'PKPM-2025R2.5-native', provider: 'native', design: { mode: 'required-reinforcement', adoptedNativeDefaults: true, parameters: { beamCoverMm: 25 } } }))
  rerender(<NativeDesignPanel review={{ ...review, modelRevision: 4 }} locale={locale} disabled={false} reportAllowed onExecute={execute} onReport={report} />)
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('button', { name: labels.button })).toBeDisabled()
})

it('keeps explicit false distinct from adopting a software default', async () => {
  const execute = vi.fn(async () => {})
  render(<NativeDesignPanel review={{ ...review, options: { engine: 'yjk', codes: ['GB50017-2017'], modes: ['code-check'],
    parameters: [{ key: 'steelColumnSwayX', kind: 'boolean', label: { zh: 'X 向侧移', en: 'X sway' } }] } }} locale="en" disabled={false} reportAllowed onExecute={execute} onReport={async () => {}} />)
  fireEvent.change(screen.getByLabelText('Design code / profile'), { target: { value: 'GB50017-2017' } })
  fireEvent.change(screen.getByLabelText('X sway'), { target: { value: 'false' } })
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Run native design' }))
  await waitFor(() => expect(execute).toHaveBeenCalledWith(expect.objectContaining({ design: expect.objectContaining({ parameters: { steelColumnSwayX: false } }) })))
})

it.each(['en', 'zh'] as const)('separates an incomplete attempt from completed required reinforcement and binds reports (%s)', async locale => {
  const record = { designRecordId: 'accepted', designCode: 'PKPM-2025R2.5-native', completionStatus: 'complete', complianceStatus: 'not_evaluated',
    reinforcementScope: 'required-not-installed', designMode: 'required-reinforcement', meta: { runId: 'accepted-run', modelRevision: 3 },
    records: [{ elementId: 'B', component: 'top', requiredArea: 550, unit: 'mm2', nativeCombination: { id: 2 } }], current: false }
  const report = vi.fn(async () => {})
  render(<NativeDesignPanel review={{ ...review, available: false, reason: 'ANALYSIS_FAILED', acceptedRecords: [record],
    latestAttempt: { designRecordId: 'failed', completionStatus: 'incomplete', complianceStatus: 'incomplete', errorCode: 'ENGINE_INPUT_UNSUPPORTED', message: 'Native stiffness conflicts', meta: { runId: 'failed', modelRevision: 3 } } }} locale={locale} disabled={false} reportAllowed onExecute={async () => {}} onReport={report} />)
  expect(screen.getByRole('button', { name: locale === 'en' ? 'Run native design' : '执行原生设计' })).toBeDisabled()
  expect(screen.getByText(/ENGINE_INPUT_UNSUPPORTED Native stiffness conflicts/)).toBeInTheDocument()
  expect(screen.getByText(locale === 'en' ? 'Required reinforcement areas only. Installed reinforcement was not checked or certified.' : '仅计算所需配筋面积；未验算已有配筋，也不表示实配通过。')).toBeInTheDocument()
  const details = screen.getByText(locale === 'en' ? 'Required reinforcement (1)' : '所需配筋 (1)')
  fireEvent.click(details)
  expect(screen.getByText('550 mm²')).toBeInTheDocument(); expect(screen.getByText('—')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Report this design' : '生成此设计报告' }))
  await waitFor(() => expect(report).toHaveBeenCalledWith('accepted-run'))
})
