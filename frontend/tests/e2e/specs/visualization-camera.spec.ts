import { test, expect, type Locator } from '@playwright/test'
import fs from 'node:fs/promises'
import { visualizationScenarios } from '../fixtures/visualization-models'
import { startLlmFixture, configureFixtureLlm, toolCall } from '../fixtures/llm-server'

async function labelCenter(scene: Locator, id: string) {
  const box = await scene.locator('[data-viz-label]').filter({ hasText: new RegExp(`^${id}$`) }).boundingBox()
  expect(box).not.toBeNull()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

test.describe('Visualization camera', () => {
  let llm: Awaited<ReturnType<typeof startLlmFixture>>
  test.beforeAll(async ({ request }) => {
    llm = await startLlmFixture()
    await configureFixtureLlm(request, llm)
  })
  test.afterAll(async () => { await llm?.close() })

  for (const scenario of visualizationScenarios.filter(row => row.id !== 'frame2d')) {
    test(`centers the structure and zooms around the cursor: ${scenario.id}`, async ({ page }, info) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.addInitScript(() => { localStorage.setItem('structureclaw.locale', 'en'); localStorage.setItem('theme', 'light') })
      await page.goto('/')
      await page.getByRole('button', { name: 'New Conversation', exact: true }).click()
      await page.getByRole('button', { name: 'Context', exact: true }).click()
      await page.getByPlaceholder('Paste StructureModel v2 JSON here.', { exact: false }).fill(JSON.stringify(scenario.model))
      await page.keyboard.press('Escape')
      llm.enqueue(toolCall('run_analysis', scenario.analysis), 'CAMERA_READY')
      const stream = page.waitForResponse(response => response.url().endsWith('/api/v1/chat/stream'), { timeout: 120_000 })
      await page.locator('textarea[placeholder]').fill(`Analyze the supplied ${scenario.id} model with OpenSees. Keep its inputs.`)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await (await stream).text()
      const closeResults = page.getByRole('button', { name: 'Close Results', exact: true })
      if (await closeResults.isVisible()) await closeResults.click()
      await page.getByRole('button', { name: 'Results and history', exact: true }).click()
      const workspace = page.getByRole('dialog', { name: 'Result workspace', exact: true })
      const scene = workspace.getByTestId('visualization-modal-scene')
      const canvas = scene.locator('canvas')
      await expect(canvas).toBeVisible()
      await workspace.getByRole('button', { name: 'Node Labels', exact: true }).click()
      await page.waitForTimeout(700)
      const initialViewport = (await canvas.boundingBox())!
      const initialNodes = await Promise.all(scenario.model.nodes.map((node: { id: string }) => labelCenter(scene, node.id)))
      const initialOffsetX = (Math.min(...initialNodes.map(point => point.x)) + Math.max(...initialNodes.map(point => point.x))) / 2
        - initialViewport.x - initialViewport.width / 2
      expect.soft(Math.abs(initialOffsetX), 'Opening the figure must show the whole structure without an extra Fit click').toBeLessThan(initialViewport.width * .03 + 3)
      await workspace.screenshot({ path: info.outputPath(`${scenario.id}-initial.png`) })
      await workspace.getByRole('button', { name: 'Model', exact: true }).click()
      if (scenario.id === 'frame3d') await workspace.getByRole('button', { name: 'Front', exact: true }).click()
      await workspace.getByRole('button', { name: 'Fit', exact: true }).click()
      await page.waitForTimeout(700)
      const viewport = (await canvas.boundingBox())!
      const centers = await Promise.all(scenario.model.nodes.map((node: { id: string }) => labelCenter(scene, node.id)))
      const center = {
        x: (Math.min(...centers.map(point => point.x)) + Math.max(...centers.map(point => point.x))) / 2,
        y: (Math.min(...centers.map(point => point.y)) + Math.max(...centers.map(point => point.y))) / 2,
      }
      const offset = { x: center.x - viewport.x - viewport.width / 2, y: center.y - viewport.y - viewport.height / 2 }
      expect.soft(Math.abs(offset.x), 'The structure must be horizontally centered').toBeLessThan(viewport.width * .03 + 3)
      // Labels sit slightly above their nodes; arrows and supports must not shift the structure.
      expect.soft(Math.abs(offset.y), 'The structure must be vertically centered').toBeLessThan(viewport.height * .04 + 6)

      const minY = Math.min(...scenario.model.nodes.map((node: { y: number }) => node.y))
      const minZ = Math.min(...scenario.model.nodes.map((node: { z: number }) => node.z))
      const row = scenario.model.nodes.filter((node: { y: number; z: number }) => node.y === minY && node.z === minZ)
        .sort((a: { x: number }, b: { x: number }) => a.x - b.x)
      const first = row[0].id, last = row[row.length - 1].id
      const before = [await labelCenter(scene, first), await labelCenter(scene, last)]
      const cursor = { x: viewport.x + viewport.width * .76, y: viewport.y + viewport.height * .34 }
      await page.mouse.move(cursor.x, cursor.y)
      await page.mouse.wheel(0, -240)
      await page.waitForTimeout(700)
      const after = [await labelCenter(scene, first), await labelCenter(scene, last)]
      const scale = (after[1].x - after[0].x) / (before[1].x - before[0].x)
      expect(scale, 'The wheel must enlarge the actual rendered structure').toBeGreaterThan(1.05)
      const anchor = { x: (after[0].x - scale * before[0].x) / (1 - scale), y: (after[0].y - scale * before[0].y) / (1 - scale) }
      expect.soft(Math.hypot(anchor.x - cursor.x, anchor.y - cursor.y), 'Zoom must be anchored at the mouse, not the viewport center').toBeLessThan(8)
      const receipt = info.outputPath('camera-measurements.json')
      await fs.writeFile(receipt, JSON.stringify({ initialOffsetX, viewport, offset, cursor, before, after, scale, anchor }, null, 2))
      await info.attach('camera-measurements', { path: receipt, contentType: 'application/json' })
      await workspace.screenshot({ path: info.outputPath(`${scenario.id}-camera.png`) })

      await workspace.getByLabel('Object', { exact: true }).selectOption(last)
      await expect.poll(async () => Math.abs((await labelCenter(scene, last)).x - viewport.x - viewport.width / 2),
        { message: 'An explicit object selection must still focus that object' }).toBeLessThan(3)
      await workspace.getByRole('button', { name: 'Fit', exact: true }).click()
      await expect.poll(async () => Math.abs((await labelCenter(scene, first)).x - before[0].x),
        { message: 'Fit must restore the complete structure after cursor zoom and selection' }).toBeLessThan(3)
    })
  }
})
