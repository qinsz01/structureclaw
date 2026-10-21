import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { visualizationScenarios } from '../fixtures/visualization-models'
import { startLlmFixture, configureFixtureLlm, toolCall } from '../fixtures/llm-server'

// Real saved models, OpenSees, result queries and WebGL. Only LLM transport is scripted.
async function pixels(page: Page, mark = false) {
  return page.locator('[data-testid="visualization-modal-scene"] canvas').evaluate((canvas: HTMLCanvasElement, mark) => {
    const state = window as Window & { workspacePixels?: ImageData; workspaceCanvas?: HTMLCanvasElement }
    const copy = document.createElement('canvas')
    copy.width = canvas.width; copy.height = canvas.height
    const ctx = copy.getContext('2d')!
    ctx.drawImage(canvas, 0, 0)
    const image = ctx.getImageData(0, 0, copy.width, copy.height)
    const data = image.data, before = state.workspacePixels
    let ink = 0, changed = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] && [0, 1, 2].some(c => Math.abs(data[i + c] - data[c]) > 30)) ink++
      if (before?.width === image.width && before.height === image.height && [0, 1, 2, 3].some(c => Math.abs(data[i + c] - before.data[i + c]) > 20)) changed++
    }
    const sameCanvas = state.workspaceCanvas === canvas
    if (mark) { state.workspacePixels = image; state.workspaceCanvas = canvas }
    return { ink, changed, sameCanvas, width: image.width, height: image.height, ratio: changed / (image.width * image.height) }
  }, mark)
}

async function expectFigureLayout(workspace: Locator, width: number, locale = 'en') {
  const selectors = await workspace.getByLabel(locale === 'en' ? 'Run' : '运行', { exact: true }).boundingBox()
  const figure = await workspace.getByTestId('workspace-inline-figure').boundingBox()
  if (width < 1024) {
    expect(figure!.y).toBeGreaterThan(selectors!.y + selectors!.height)
    expect(figure!.width).toBeGreaterThan(width * .85)
  } else {
    expect(figure!.x).toBeGreaterThan(selectors!.x + selectors!.width)
  }
  const canvas = await workspace.locator('canvas').boundingBox()
  const legend = await workspace.getByTestId('visualization-legend').boundingBox()
  expect(canvas!.x + canvas!.width, 'The legend must not cover any of the camera viewport').toBeLessThanOrEqual(legend!.x + 1)
}

test.describe('Workspace inline figure', () => {
  let llm: Awaited<ReturnType<typeof startLlmFixture>>
  test.beforeAll(async ({ request }) => {
    llm = await startLlmFixture()
    await configureFixtureLlm(request, llm)
  })
  test.afterAll(async () => { await llm?.close() })

  for (const scenario of visualizationScenarios) {
    test(`immediate figure, linked selection, fullscreen and workspace screenshots: ${scenario.id}`, async ({ page }, info) => {
      test.setTimeout(240_000)
      const out = process.env.SCLAW_WORKSPACE_OUT || info.outputPath('workspace')
      await fs.mkdir(out, { recursive: true })
      const errors: string[] = [], screenshots: string[] = []
      const calls: { component?: string; resultKey?: string; includeModelSnapshot?: boolean }[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => {
        if (request.url().includes('/result-review/') && request.url().endsWith('/tools')) {
          const body = request.postDataJSON()
          if (body.tool === 'query_results') calls.push(body.args)
        }
      })
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.addInitScript(() => { localStorage.setItem('structureclaw.locale', 'en'); localStorage.setItem('theme', 'light') })
      await page.goto('/')
      await page.getByRole('button', { name: 'New Conversation', exact: true }).click()
      await page.getByRole('button', { name: 'Context', exact: true }).click()
      // A deterministic 2× combination adds case-switch coverage without altering the audit inputs.
      const model = { ...scenario.model, load_combinations: [...scenario.model.load_combinations,
        { id: 'workspace-double', factors: { [scenario.model.load_cases[0].id]: 2 } }] }
      await page.getByPlaceholder('Paste StructureModel v2 JSON here.', { exact: false }).fill(JSON.stringify(model))
      await page.keyboard.press('Escape')
      llm.enqueue(toolCall('run_analysis', { ...scenario.analysis, loadCombinationIds: model.load_combinations.map(row => row.id) }), 'WORKSPACE_FIGURE_READY')
      const stream = page.waitForResponse(response => response.url().endsWith('/api/v1/chat/stream'), { timeout: 180_000 })
      await page.locator('textarea[placeholder]').fill(`Analyze the supplied ${scenario.id} model and its combinations with OpenSees. Keep its inputs.`)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await (await stream).text()
      const closeResults = page.getByRole('button', { name: 'Close Results', exact: true })
      if (await closeResults.isVisible()) await closeResults.click()
      await page.getByRole('button', { name: 'Results and history', exact: true }).click()
      const workspace = page.getByRole('dialog', { name: 'Result workspace', exact: true })
      const canvas = workspace.locator('canvas')
      await expect(canvas).toBeVisible()
      await expect(workspace.getByRole('button', { name: 'Query selected result', exact: true })).toBeEnabled()
      await expect(page.getByTestId('visualization-scene-fallback')).toHaveCount(0)
      await expect.poll(async () => (await pixels(page)).ink).toBeGreaterThan(300)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ includeModelSnapshot: true })
      expect(calls[0].component).toBeUndefined()
      await expect(workspace.getByTestId('workspace-query-result')).toHaveCount(0)
      await expect(workspace.getByRole('button', { name: 'View selected figure', exact: true })).toHaveCount(0)

      // Exercise both sides of the breakpoint at the normal 1000px height.
      for (const width of [768, 1023, 1024, 1440]) {
        await page.setViewportSize({ width, height: 1000 })
        await workspace.getByRole('button', { name: 'Fit', exact: true }).click()
        await page.waitForTimeout(500)
        await canvas.scrollIntoViewIfNeeded()
        await expectFigureLayout(workspace, width)
        if (scenario.id === 'beam') {
          await workspace.getByRole('button', { name: 'Node Labels', exact: true }).click()
          const viewport = await canvas.boundingBox()
          for (const node of scenario.model.nodes) {
            const label = workspace.getByTestId('visualization-modal-scene').getByText(node.id, { exact: true })
            await expect(label).toBeVisible()
            const bounds = await label.boundingBox()
            expect(bounds!.x).toBeGreaterThan(viewport!.x)
            expect(bounds!.x + bounds!.width).toBeLessThan(viewport!.x + viewport!.width)
            expect(bounds!.y).toBeGreaterThan(viewport!.y)
            expect(bounds!.y + bounds!.height).toBeLessThan(viewport!.y + viewport!.height)
          }
          await workspace.getByRole('button', { name: 'Node Labels', exact: true }).click()
        }
      }
      await page.waitForTimeout(500)
      await pixels(page, true)
      const caseResponse = page.waitForResponse(response => response.url().endsWith('/tools') && response.request().postDataJSON()?.args?.resultKey === 'combination:workspace-double')
      await workspace.getByLabel('Case / combination', { exact: true }).selectOption('combination:workspace-double')
      expect((await (await caseResponse).json()).success).toBe(true)
      await expect.poll(async () => (await pixels(page)).changed).toBeGreaterThan(80)
      const casePixels = await pixels(page)
      expect(casePixels.sameCanvas).toBe(true)
      await expect(workspace).toBeVisible()

      await page.waitForTimeout(500)
      await pixels(page, true)
      await workspace.getByLabel('Object', { exact: true }).selectOption(scenario.model.nodes[1].id)
      await expect.poll(async () => (await pixels(page)).changed).toBeGreaterThan(80)
      const objectPixels = await pixels(page)
      expect(objectPixels.sameCanvas).toBe(true)
      expect(calls).toHaveLength(2)
      // The viewer's object list shares the canvas picking callback.
      await workspace.getByText('Object details', { exact: true }).click()
      await workspace.locator('aside').getByRole('button', { name: scenario.model.nodes[0].id, exact: true }).click()
      await expect(workspace.getByLabel('Object', { exact: true })).toHaveValue(scenario.model.nodes[0].id)
      await workspace.getByText('Object details', { exact: true }).click()

      await workspace.getByLabel('Object kind', { exact: true }).selectOption('member')
      await workspace.getByLabel('Member position (m)', { exact: true }).fill('1')
      await expect(workspace.getByTestId('visualization-selected-position')).toContainText('1 m')
      const quantityResponse = page.waitForResponse(response => response.url().endsWith('/tools') && response.request().postDataJSON()?.args?.component === 'M2')
      await workspace.getByRole('button', { name: 'Query selected result', exact: true }).click()
      const queried = await (await quantityResponse).json()
      expect(queried.success).toBe(true)
      expect(Number.isFinite(queried.result.quantity.value)).toBe(true)
      await expect(workspace.getByTestId('workspace-query-result')).toContainText('M2')
      await expect(workspace.getByTestId('workspace-query-result')).toContainText('kN.m')
      await workspace.getByRole('button', { name: 'Model', exact: true }).click()
      await expect(workspace.getByTestId('workspace-query-result')).toHaveCount(0)
      await workspace.getByRole('button', { name: 'Diagram', exact: true }).click()
      await expect(workspace.getByTestId('workspace-query-result')).toBeVisible()
      const slider = workspace.getByRole('slider')
      await slider.fill('1.5')
      if (scenario.id === 'frame3d') await workspace.getByRole('button', { name: 'Front', exact: true }).click()
      await canvas.hover()
      await page.mouse.wheel(0, -180)
      await page.mouse.move(2, 2)
      await page.waitForTimeout(700)
      await pixels(page, true)
      await workspace.getByRole('button', { name: 'Fullscreen', exact: true }).click()
      const fullscreen = page.getByRole('dialog', { name: 'Structural Visualization', exact: true })
      await expect(fullscreen.locator('canvas')).toBeVisible()
      expect((await pixels(page)).sameCanvas).toBe(true)
      await expect(fullscreen.getByRole('slider')).toHaveValue('1.5')
      await expect(fullscreen.getByTestId('visualization-query-result')).toContainText('M2')
      if (scenario.id === 'frame3d') await expect(fullscreen.getByRole('button', { name: 'Front', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await page.keyboard.press('Escape')
      await expect(workspace).toBeVisible()
      await expect(workspace.getByLabel('Case / combination', { exact: true })).toHaveValue('combination:workspace-double')
      await expect(workspace.getByLabel('Object kind', { exact: true })).toHaveValue('member')
      await expect(workspace.getByLabel('Member position (m)', { exact: true })).toHaveValue('1')
      await expect(slider).toHaveValue('1.5')
      await page.waitForTimeout(500)
      const roundTrip = await pixels(page)
      expect(roundTrip.sameCanvas).toBe(true)
      expect(roundTrip.ratio, 'Fullscreen must preserve the orbit camera as well as viewer controls').toBeLessThan(.03)
      await workspace.getByRole('button', { name: 'Close', exact: true }).click()

      for (const locale of ['en', 'zh'] as const) {
        if (locale === 'zh') {
          await page.getByRole('button', { name: /^(Open settings|打开设置)$/ }).click()
          await page.getByRole('tab', { name: /^(Appearance|外观)$/ }).click()
          await page.getByLabel('Language', { exact: true }).selectOption('zh')
          await page.keyboard.press('Escape')
        }
        for (const theme of ['light', 'dark']) {
          await page.getByRole('button', { name: /^(Open settings|打开设置)$/ }).click()
          await page.getByRole('tab', { name: /^(Appearance|外观)$/ }).click()
          await page.getByLabel(locale === 'en' ? 'Theme' : '主题', { exact: true }).selectOption(theme)
          await page.keyboard.press('Escape')
          expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe(theme)
          await page.getByRole('button', { name: locale === 'en' ? 'Results and history' : '结果与历史', exact: true }).click()
          const ws = page.getByRole('dialog', { name: locale === 'en' ? 'Result workspace' : '结果工作区', exact: true })
          await expect(ws.locator('canvas')).toBeVisible()
          for (const width of [1440, 768]) {
            // A portrait viewport shows the complete stacked workspace without changing its styles.
            await page.setViewportSize({ width, height: width < 1024 ? 1600 : 1000 })
            await ws.getByRole('button', { name: locale === 'en' ? 'Fit' : '适配视图', exact: true }).click()
            await page.waitForTimeout(500)
            await expectFigureLayout(ws, width, locale)
            expect((await pixels(page)).ink).toBeGreaterThan(300)
            expect(await ws.locator('canvas').evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(180)
            expect(await ws.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
            const file = path.join(out, `${scenario.id}-${theme}-${locale}-${width}.png`)
            await ws.screenshot({ path: file }); screenshots.push(file)
          }
          await page.keyboard.press('Escape')
          await page.setViewportSize({ width: 1440, height: 1000 })
        }
      }
      await page.setViewportSize({ width: 640, height: 1000 })
      await page.getByRole('button', { name: '结果与历史', exact: true }).click()
      const stacked = page.getByRole('dialog', { name: '结果工作区', exact: true })
      await expect(stacked.locator('canvas')).toBeAttached()
      const selectorsBox = await stacked.getByLabel('运行', { exact: true }).boundingBox()
      const figureBox = await stacked.getByTestId('workspace-inline-figure').boundingBox()
      expect(figureBox!.y).toBeGreaterThan(selectorsBox!.y + selectorsBox!.height)
      await stacked.locator('canvas').scrollIntoViewIfNeeded()
      await expect(stacked.locator('canvas')).toBeVisible()
      expect(await stacked.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      await page.keyboard.press('Escape')
      expect(errors).toEqual([])
      const evidence = { scenario: scenario.id, casePixels, objectPixels, roundTrip, screenshots, errors }
      const receipt = path.join(out, `${scenario.id}-workspace-results.json`)
      await fs.writeFile(receipt, JSON.stringify(evidence, null, 2))
      await info.attach('workspace-figure-evidence', { path: receipt, contentType: 'application/json' })
      expect(screenshots).toHaveLength(8)
    })
  }
})
