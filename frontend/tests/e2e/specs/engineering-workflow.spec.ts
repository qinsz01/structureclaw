import { test, expect, type Page, type Locator } from '@playwright/test'
import { formatResultNumber } from '../../../src/lib/utils'
import { readFile } from 'node:fs/promises'
import { beamModel, beamReference, beamAnalysis } from '../fixtures/engineering-beam'
import { startLlmFixture, configureFixtureLlm, toolCall } from '../fixtures/llm-server'

// Only the provider's LLM transport is scripted. Browser requests, model validation,
// OpenSees, result recovery, transactions, reports, persistence and WebGL are real.
// A complete engineering model is entered through the UI; this is not an NLP accuracy test.
test.describe('Real engineering service through the browser', () => {
  let llm: Awaited<ReturnType<typeof startLlmFixture>>
  test.beforeAll(async ({ request }) => {
    llm = await startLlmFixture()
    await configureFixtureLlm(request, llm)
  })
  test.afterAll(async () => { await llm?.close() })

  test('invalid tool arguments preserve the saved analysis, report and browser figure', async ({ page, request }, info) => {
    test.setTimeout(180_000)
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.addInitScript(() => localStorage.setItem('structureclaw.locale', 'en'))
    await page.goto('/')
    await page.getByRole('button', { name: 'New Conversation', exact: true }).click()
    await page.getByRole('button', { name: 'Context', exact: true }).click()
    await page.getByPlaceholder('Paste StructureModel v2 JSON here.', { exact: false }).fill(JSON.stringify(beamModel))
    await page.keyboard.press('Escape')
    const initial = await sendScript(page, llm, 'Analyze the supplied beam and save its report.', [
      toolCall('run_analysis', beamAnalysis, 'preserve-analysis'),
      toolCall('generate_report', { message: 'Computed report', analysisType: 'static', locale: 'en', narrative: 'structured' }, 'preserve-report'), 'INITIAL_SAVED'])
    const url = `/api/v1/chat/conversation/${initial.conversationId}/session`
    const before = await (await request.get(url)).json()
    expect(before.analysis.current).toBe(true)
    expect(before.report.current).toBe(true)
    for (const call of [toolCall('run_analysis', { analysisType: 'equilibrium' }, 'invalid-analysis-type'),
      toolCall('extract_draft_params', { requestScope: { responses: [] } }, 'invalid-extraction-scope'),
      toolCall('build_model', {}, 'missing-build-draft')]) {
      const invalid = await sendScript(page, llm, 'Injected rejected operation must preserve the saved result.', [call, 'INVALID_CALL_REJECTED'], 1)
      expect(invalid.events.filter(event => event.type === 'artifact_payload_sync' && event.invalidated)).toEqual([])
      const retained = await (await request.get(url)).json()
      expect(retained.analysis).toEqual(before.analysis)
      expect(retained.report).toEqual(before.report)
    }
    const after = await (await request.get(url)).json()
    const workspace = await openResults(page)
    await expect(workspace.getByLabel('Run', { exact: true }).locator('option:checked')).toHaveText(`Current · ${before.analysis.runId}`)
    await selectMidpointDisplacement(workspace)
    expect((await querySelected(page, workspace)).quantity.value).toBeCloseTo(beamReference.midpointDisplacementMm, 8)
    await workspace.getByRole('button', { name: 'View selected figure', exact: true }).click()
    await expect(page.getByTestId('visualization-modal-scene')).toBeVisible()
    await expect(page.getByTestId('visualization-scene-fallback')).toHaveCount(0)
    expect(pageErrors).toEqual([])
    await info.attach('retained-result-session', { body: JSON.stringify({ before, after }, null, 2), contentType: 'application/json' })
    await info.attach('retained-result-figure', { body: await page.screenshot(), contentType: 'image/png' })
  })

  test('OpenSees → selected quantity → report/figure → edit invalidation → history → undo/recalculate', async ({ page, request }, testInfo) => {
    test.setTimeout(180_000)
    page.setDefaultTimeout(15_000)
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    await page.addInitScript(() => localStorage.setItem('structureclaw.locale', 'en'))
    await page.goto('/')
    await page.getByRole('button', { name: 'New Conversation', exact: true }).click()
    await page.getByRole('button', { name: 'Context', exact: true }).click()
    await page.getByPlaceholder('Paste StructureModel v2 JSON here.', { exact: false }).fill(JSON.stringify(beamModel, null, 2))
    await page.keyboard.press('Escape')

    const title = `E2E beam ${Date.now()}`
    const initial = await sendScript(page, llm, `${title}: Analyze this supplied 10 m beam with OpenSees. Do not change its geometry or loads.`,
      [toolCall('run_analysis', beamAnalysis, 'initial-analysis'),
        toolCall('generate_report', { message: 'Report this computed beam', analysisType: 'static', locale: 'en', narrative: 'structured' }, 'initial-report'),
        'ENGINEERING_INITIAL_DONE'])
    const conversationId = initial.conversationId
    expect(initial.steps).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'run_analysis', status: 'done' })]))
    const sessionUrl = `/api/v1/chat/conversation/${conversationId}/session`
    const session = await (await request.get(sessionUrl)).json()
    expect(session.analysis.current).toBe(true)
    expect(session.report.current).toBe(true)
    const initialRunId = session.analysis.runId
    expect(typeof initialRunId).toBe('string')

    let workspace = await openResults(page)
    await expect(workspace.getByLabel('Run', { exact: true }).locator('option:checked')).toHaveText(`Current · ${initialRunId}`)
    for (const nodeId of ['A', 'B']) {
      await workspace.getByLabel('Object', { exact: true }).selectOption(nodeId)
      await workspace.getByLabel('Response', { exact: true }).selectOption('reactions')
      const response = await querySelected(page, workspace)
      expect(response.quantity).toMatchObject({ runId: initialRunId, selection: 'case:LC1', component: 'fz', unit: 'kN', location: { kind: 'node', id: nodeId } })
      expect(response.quantity.value).toBeCloseTo(beamReference.reactionKn, 8)
    }
    await workspace.getByLabel('Object kind', { exact: true }).selectOption('member')
    await workspace.getByLabel('Member position (m)', { exact: true }).fill('5')
    const moment = await querySelected(page, workspace)
    expect(moment.quantity.value).toBeCloseTo(beamReference.midpointMomentKnm, 8)
    expect(moment.quantity.location).toMatchObject({ kind: 'member', id: 'beam', positionM: 5, side: 'right' })
    await workspace.getByLabel('Response', { exact: true }).selectOption('displacements')
    const displacement = await querySelected(page, workspace)
    expect(displacement.quantity.value).toBeCloseTo(beamReference.midpointDisplacementMm, 8)
    expect(displacement.modelSnapshot.nodes).toHaveLength(2)
    expect(displacement.modelSnapshot.elements).toHaveLength(1)

    const reportResponse = page.waitForResponse(response => response.url().includes('/result-review/') && response.url().endsWith('/tools'))
    await workspace.getByRole('button', { name: 'Report selected result', exact: true }).click()
    const reported = await (await reportResponse).json()
    expect(reported.success).toBe(true)
    const report = reported.result.report.json
    expect(report.requestedQuantities).toEqual([displacement.quantity])
    expect(report.requestedSelection).toMatchObject({ runId: initialRunId, resultKey: 'case:LC1', elementId: 'beam', positionM: 5, component: 'uz', unit: 'mm' })
    await expect(workspace.getByRole('button', { name: 'Export JSON', exact: true })).toBeEnabled()
    const downloadPromise = page.waitForEvent('download')
    await workspace.getByRole('button', { name: 'Export JSON', exact: true }).click()
    const download = await downloadPromise
    const reportPath = testInfo.outputPath('selected-report.json')
    await download.saveAs(reportPath)
    expect(JSON.parse(await readFile(reportPath, 'utf8')).requestedQuantities).toEqual([displacement.quantity])
    await testInfo.attach('real-selected-report', { path: reportPath, contentType: 'application/json' })

    await workspace.getByRole('button', { name: 'View selected figure', exact: true }).click()
    const figure = page.getByRole('dialog')
    await expect(page.getByTestId('visualization-modal-scene')).toBeVisible()
    await expect(page.getByTestId('visualization-scene-fallback')).toHaveCount(0)
    await expect(figure.getByRole('button', { name: 'Deformed', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(figure.getByRole('button', { name: 'Diagram', exact: true })).toBeVisible()
    await expect(figure.getByRole('button', { name: 'Reactions', exact: true })).toBeVisible()
    await expect(figure).toContainText(initialRunId)
    await expect(figure).toContainText(`Selected location value: ${formatResultNumber(displacement.quantity.value)} mm`)
    await expect(figure).toContainText('2D · 2 nodes · 1 elements')
    await expect(figure.locator('canvas')).toBeVisible()
    const figurePath = testInfo.outputPath('real-beam-deformation.png')
    await figure.screenshot({ path: figurePath })
    await testInfo.attach('real-beam-deformation', { path: figurePath, contentType: 'image/png' })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    // Reload is a fresh read of the persisted run, then query the same physical location.
    await page.reload()
    await page.getByTestId('console-history-panel').getByRole('button', { name: new RegExp(title) }).click()
    workspace = await openResults(page)
    await workspace.getByLabel('Run', { exact: true }).selectOption(initialRunId)
    await selectMidpointDisplacement(workspace)
    expect((await querySelected(page, workspace)).quantity).toMatchObject({ runId: initialRunId, value: displacement.quantity.value })
    await page.keyboard.press('Escape')

    const beforeEdit = await (await request.get(sessionUrl)).json()
    const edit = await sendScript(page, llm, 'Double the existing midpoint load to 2 kN, keeping its ID and position. Do not recalculate yet.', [
      toolCall('edit_model', { baseRevision: beforeEdit.modelRevision, label: 'Double existing midpoint load',
        edits: [{ operation: 'update', collection: 'loads', caseId: 'LC1', id: 'midpoint-load', values: { fz: -2 } }] }, 'double-load'),
      'ENGINEERING_EDIT_DONE',
    ])
    expect(edit.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'artifact_payload_sync', artifact: 'analysis', invalidated: true })]))
    const edited = await (await request.get(sessionUrl)).json()
    expect(edited.modelRevision).toBeGreaterThan(beforeEdit.modelRevision)
    expect(edited.analysis.current).toBe(false)
    expect(edited.report.current).toBe(false)
    const editedInput = await (await request.get(`/api/v1/agent/input-review/${conversationId}`)).json()
    expect(editedInput.model.load_cases[0].loads).toHaveLength(1)
    expect(editedInput.model.load_cases[0].loads[0]).toMatchObject({ id: 'midpoint-load', position: 5, fz: -2 })

    workspace = await openResults(page)
    await expect(workspace.getByLabel('Run', { exact: true }).locator('option:checked')).toHaveText(`Historical · ${initialRunId}`)
    await selectMidpointDisplacement(workspace)
    const historical = await querySelected(page, workspace)
    expect(historical).toMatchObject({ runId: initialRunId, historical: true, current: false })
    expect(historical.quantity.value).toBe(displacement.quantity.value)
    await workspace.getByRole('button', { name: 'View selected figure', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText(initialRunId)
    await expect(page.getByRole('dialog')).toContainText(`Selected location value: ${formatResultNumber(displacement.quantity.value)} mm`)
    await expect(page.getByTestId('visualization-scene-fallback')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(workspace.getByLabel('Run', { exact: true }).locator('option:checked')).toHaveText(`Historical · ${initialRunId}`)
    const historyReportPromise = page.waitForResponse(response => response.url().includes('/result-review/') && response.url().endsWith('/tools'))
    await workspace.getByRole('button', { name: 'Report selected result', exact: true }).click()
    const historicalReport = await (await historyReportPromise).json()
    expect(historicalReport.success).toBe(true)
    expect(historicalReport.result.report.json.requestedSelection.runId).toBe(initialRunId)
    expect((await (await request.get(sessionUrl)).json()).report.current).toBe(false)
    await page.keyboard.press('Escape')

    const undone = await sendScript(page, llm, 'Undo the last load change and recalculate the restored model with OpenSees.', [
      toolCall('undo_model', { baseRevision: edited.modelRevision }, 'undo-load'),
      toolCall('run_analysis', beamAnalysis, 'restored-analysis'),
      'ENGINEERING_UNDO_DONE',
    ])
    expect(undone.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'undo_model', status: 'done' }), expect.objectContaining({ tool: 'run_analysis', status: 'done' }),
    ]))
    const restored = await (await request.get(sessionUrl)).json()
    expect(restored.modelRevision).toBeGreaterThan(edited.modelRevision)
    expect(restored.analysis.current).toBe(true)
    expect(restored.analysis.runId).not.toBe(initialRunId)
    const restoredInput = await (await request.get(`/api/v1/agent/input-review/${conversationId}`)).json()
    expect(restoredInput.model.load_cases[0].loads[0]).toMatchObject({ id: 'midpoint-load', position: 5, fz: -1 })
    workspace = await openResults(page)
    await expect(workspace.getByLabel('Run', { exact: true }).locator('option:checked')).toHaveText(`Current · ${restored.analysis.runId}`)
    await expect(workspace.getByLabel('Run', { exact: true }).locator('option')).toHaveCount(2)
    await selectMidpointDisplacement(workspace)
    expect((await querySelected(page, workspace)).quantity.value).toBeCloseTo(beamReference.midpointDisplacementMm, 8)
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(llm.failures).toEqual([])
    expect(llm.pending()).toBe(0)
  })
})

async function sendScript(page: Page, llm: Awaited<ReturnType<typeof startLlmFixture>>, message: string, responses: Parameters<typeof llm.enqueue>, expectedToolErrors = 0) {
  llm.enqueue(...responses)
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/v1/chat/stream'))
  await page.locator('textarea[placeholder]').fill(message)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const response = await responsePromise
  expect(response.status()).toBe(200)
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)))
  expect(events.filter(event => event.type === 'error' || event.type === 'presentation_error')).toEqual([])
  const steps = events.filter(event => event.type === 'step_upsert').map(event => event.step)
  expect(steps.filter(step => step.status === 'error')).toHaveLength(expectedToolErrors)
  await expect(page.getByRole('button', { name: 'Results and history', exact: true })).toBeEnabled()
  return { events, steps, conversationId: events.find(event => event.type === 'start').content.conversationId as string }
}

async function openResults(page: Page) {
  const closeOutput = page.getByRole('button', { name: 'Close Results', exact: true })
  if (await closeOutput.isVisible()) await closeOutput.click()
  await page.getByRole('button', { name: 'Results and history', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Result workspace', exact: true })
  await expect(dialog.getByLabel('Run', { exact: true }).locator('option:checked')).not.toHaveText('No saved runs')
  return dialog
}

async function selectMidpointDisplacement(workspace: Locator) {
  await workspace.getByLabel('Object kind', { exact: true }).selectOption('member')
  await workspace.getByLabel('Member position (m)', { exact: true }).fill('5')
  await workspace.getByLabel('Response', { exact: true }).selectOption('displacements')
}

async function querySelected(page: Page, workspace: Locator) {
  const responsePromise = page.waitForResponse(response => response.url().includes('/result-review/') && response.url().endsWith('/tools'))
  await workspace.getByRole('button', { name: 'Query selected result', exact: true }).click()
  const response = await responsePromise
  expect(response.status()).toBe(200)
  const body = await response.json()
  expect(body.success).toBe(true)
  await expect(workspace.locator('p.text-2xl')).toContainText(`${body.result.quantity.value.toPrecision(10)} ${body.result.quantity.unit}`)
  return body.result
}
