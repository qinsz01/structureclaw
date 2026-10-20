// Adapted from G:/StructureClaw-All/viz-audit/audit.mjs (2026-10-19).
// The original evidence is untouched. Real browser + product API + OpenSees;
// only LLM transport is scripted. The historical frame inputs were recovered
// read-only from that audit's isolated saved runs, without accessing Bench.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const REPO = process.env.SCLAW_VIZ_REPO || (fs.existsSync(path.resolve(import.meta.dirname, '../../..', 'frontend')) ? path.resolve(import.meta.dirname, '../../..') : 'G:/StructureClaw-All/structureclaw')
const require = createRequire(`${REPO}/frontend/package.json`)
const { chromium, request } = require('playwright')
const { visualizationScenarios: scenarios } = await import(pathToFileURL(`${REPO}/frontend/tests/e2e/fixtures/visualization-models.ts`).href)
const { startLlmFixture, configureFixtureLlm, toolCall } = await import(pathToFileURL(`${REPO}/frontend/tests/e2e/fixtures/llm-server.ts`).href)
const labels = {
  en: { results: 'Results and history', workspace: 'Result workspace', query: 'Query selected result', figure: 'Fullscreen',
    views: ['Model', 'Deformed', 'Diagram', 'Reactions'], close: 'Close Visualization', fit: 'Fit', change: 'Change case' },
  zh: { results: '结果与历史', workspace: '结果工作区', query: '查询所选结果', figure: '全屏',
    views: ['模型', '变形', '内力图', '反力'], close: '关闭可视化', fit: '适配视图', change: '切换工况' },
}
const safe = text => text.replace(/[^a-z0-9._-]+/gi, '_')
const pause = page => page.waitForTimeout(450)
const setRange = (slider, value) => slider.evaluate((el, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }, value)
const dialog = page => page.locator('[role="dialog"][aria-modal="true"]').last()
const button = (page, name) => dialog(page).getByRole('button', { name, exact: true })

async function captureDialog(page, file) {
  const bounds = await dialog(page).boundingBox()
  assert(bounds && bounds.width > 0 && bounds.height > 0, 'The figure dialog must be visible')
  // Capture the settled dialog rectangle without scrolling the animated WebGL surface.
  await page.screenshot({ path: file, clip: bounds, animations: 'disabled' })
}

async function markPixels(page) {
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="visualization-modal-scene"] canvas')
    if (!canvas) { window.__vizAuditPixels = null; return }
    const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height
    const ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0)
    window.__vizAuditPixels = { data: ctx.getImageData(0, 0, copy.width, copy.height).data, width: copy.width, height: copy.height }
  })
}
async function pixelDifference(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="visualization-modal-scene"] canvas'), before = window.__vizAuditPixels
    if (!canvas || !before) return { pixels: canvas || before ? 100000 : 0, ratio: canvas || before ? 1 : 0 }
    const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height
    if (before.width !== copy.width || before.height !== copy.height) return { pixels: copy.width * copy.height, ratio: 1 }
    const ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0)
    const after = ctx.getImageData(0, 0, copy.width, copy.height).data
    let pixels = 0
    for (let i = 0; i < after.length; i += 4) if (Math.max(...[0, 1, 2, 3].map(c => Math.abs(after[i + c] - before.data[i + c]))) > 20) pixels++
    return { pixels, ratio: pixels / (copy.width * copy.height) }
  })
}
async function content(page) {
  return page.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1)
    if (!d) return ''
    // Ignore pressed styling: a toggle must affect content or actual canvas pixels.
    return ['[data-testid="visualization-modal-scene"]', 'aside', '[data-testid="visualization-toolbar"]', '[data-testid="visualization-run-copy-status"]'].map(q => d.querySelector(q)?.innerText || '').join('\n')
  })
}
async function exportedImage(page, file) {
  const data = fs.readFileSync(file).toString('base64')
  return page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let transparent = 0, legendInk = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) transparent++
    const bg = [...data.slice(0, 3)]
    for (let y = 168; y < Math.min(700, canvas.height); y++) for (let x = canvas.width - 400; x < canvas.width - 20; x++) {
      const i = (y * canvas.width + x) * 4
      if ([0, 1, 2].some(c => Math.abs(data[i + c] - bg[c]) > 35)) legendInk++
    }
    return { width: canvas.width, height: canvas.height, transparent, legendInk }
  }, data)
}

function readButtonContrast(elements, states) {
  const checks = []
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
  const luminance = rgb => rgb.slice(0, 3).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
  elements.forEach((el, index) => {
    if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || el.closest('aside')) return
    for (const state of states) {
      const target = state === 'disabled' ? el.cloneNode(true) : el
      if (state === 'disabled') { target.disabled = true; target.style.position = 'fixed'; target.style.left = '-10000px'; document.body.append(target) }
      const style = getComputedStyle(target), foreground = rgba(style.color), background = rgba(style.backgroundColor)
      const a = luminance(foreground), b = luminance(background)
      checks.push({ index, label: el.innerText, state, active: el.getAttribute('aria-pressed') === 'true',
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), opacity: Number(style.opacity),
        opaque: background[3] === 255 && foreground[3] === 255 })
      if (state === 'disabled') target.remove()
    }
  })
  return checks
}

async function toolbarContrast(page, theme, view) {
  const buttons = dialog(page).locator('button')
  await page.mouse.move(2, 2); await page.waitForTimeout(180)
  const checks = await buttons.evaluateAll(readButtonContrast, ['enabled', 'disabled'])
  for (const { index } of checks.filter(check => check.state === 'enabled')) {
    const button = buttons.nth(index)
    await button.hover(); await page.waitForTimeout(180)
    const [check] = await button.evaluateAll(readButtonContrast, ['hover'])
    assert(check, `Missing hover target: ${theme} ${view} button ${index}`)
    checks.push({ ...check, index })
  }
  await page.mouse.move(2, 2); await page.waitForTimeout(180)
  for (const check of checks) {
    assert(check.opaque && check.opacity === 1 && check.ratio >= 4.5, `${theme} ${view} ${check.label} ${check.state}: ${JSON.stringify(check)}`)
  }
  return checks.map(check => ({ theme, view, ...check }))
}

export async function runVisualizationAudit({ only, out, screenshots = true }) {
  fs.mkdirSync(out, { recursive: true })
  const port = Number(process.env.SCLAW_E2E_PORT || 31595)
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535 && ![3000, 31415, 31416].includes(port), 'Use an isolated E2E port')
  const BASE = `http://127.0.0.1:${port}`
  const receipt = JSON.parse(fs.readFileSync(path.join(REPO, '.tmp', `playwright-server-${port}.json`), 'utf8'))
  assert.equal(receipt.baseURL, BASE)
  assert(receipt.instanceId.startsWith('playwright-'))
  const health = await fetch(`${BASE}/health`).then(response => response.json())
  assert.equal(health.instanceId, receipt.instanceId, 'Refusing to audit an unrelated server')
  const api = await request.newContext({ baseURL: BASE })
  const llm = await startLlmFixture()
  let browser
  const rows = [], errors = [], exports = [], screenshotPaths = [], contrastChecks = []
  const save = () => fs.writeFileSync(path.join(out, `${only || 'all'}-results.json`), JSON.stringify({ rows, errors, exports, screenshotPaths, contrastChecks }, null, 2))
  try {
    await configureFixtureLlm(api, llm)
    browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
    for (const scenario of scenarios.filter(s => !only || s.id === only)) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
        permissions: ['clipboard-read', 'clipboard-write'] })
      const page = await context.newPage(); page.setDefaultTimeout(15000)
      page.on('pageerror', error => errors.push(`${scenario.id}: ${error.message}`))
      page.on('console', message => { if (message.type() === 'error') errors.push(`${scenario.id}: ${message.text()}`) })
      await page.addInitScript(() => { localStorage.setItem('structureclaw.locale', 'en'); localStorage.setItem('theme', 'light') })
      await page.goto(BASE)
      await page.getByRole('button', { name: 'New Conversation', exact: true }).click()
      await page.getByRole('button', { name: 'Context', exact: true }).click()
      await page.getByPlaceholder('Paste StructureModel v2 JSON here.', { exact: false }).fill(JSON.stringify(scenario.model))
      await page.keyboard.press('Escape')
      llm.enqueue(toolCall('run_analysis', scenario.analysis), 'VISUALIZATION_AUDIT_READY')
      const stream = page.waitForResponse(r => r.url().endsWith('/api/v1/chat/stream'), { timeout: 180000 })
      await page.locator('textarea[placeholder]').fill(`Analyze the supplied ${scenario.id} model with OpenSees. Do not change it.`)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await (await stream).text()
      await page.getByRole('button', { name: labels.en.results, exact: true }).waitFor()
      const closeOutput = page.getByRole('button', { name: 'Close Results', exact: true })
      if (await closeOutput.isVisible()) await closeOutput.click()
      async function openFigure(locale = 'en') {
        await page.getByRole('button', { name: labels[locale].results, exact: true }).click()
        const ws = page.getByRole('dialog', { name: labels[locale].workspace, exact: true })
        await ws.getByLabel(locale === 'en' ? 'Run' : '运行', { exact: true }).waitFor()
        await ws.locator('canvas').waitFor()
        const response = page.waitForResponse(r => r.url().includes('/result-review/') && r.url().endsWith('/tools') && r.request().postDataJSON()?.args?.component)
        await ws.getByRole('button', { name: labels[locale].query, exact: true }).click()
        const result = await (await response).json(); assert.equal(result.success, true, JSON.stringify(result.result))
        await ws.getByRole('button', { name: labels[locale].figure, exact: true }).click()
        await page.getByTestId('visualization-modal-scene').waitFor()
        assert.equal(await page.getByTestId('visualization-scene-fallback').count(), 0)
        await pause(page)
      }
      await openFigure()
      async function probe(control, action, artifact) {
        await page.mouse.move(2, 2); await pause(page)
        const beforeText = await content(page); await markPixels(page)
        const stem = path.join(out, safe(`${scenario.id}-${control}`))
        await captureDialog(page, `${stem}-before.png`)
        await action(); await page.mouse.move(2, 2); await pause(page)
        const diff = await pixelDifference(page), domChanged = beforeText !== await content(page)
        await captureDialog(page, `${stem}-after.png`).catch(() => {})
        const row = { scenario: scenario.id, control, pixels: diff.pixels, ratio: diff.ratio, domChanged,
          artifact: artifact || null, class: diff.pixels > 80 || domChanged || artifact ? 'a' : 'c' }
        rows.push(row); save(); console.log(JSON.stringify(row))
        assert.equal(row.class, 'a', `${scenario.id} ${control} has no visible effect`)
        return row
      }
      const copyRun = page.getByTestId('visualization-copy-run-id')
      const runId = await copyRun.getAttribute('title')
      assert(runId && (await copyRun.innerText()).includes(runId.slice(0, 8)))
      assert(!(await dialog(page).locator('h2').innerText()).includes(runId))
      await probe('copy-run-id', async () => {
        await copyRun.click()
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), runId)
        await page.getByTestId('visualization-run-copy-status').waitFor()
      })
      for (const view of labels.en.views) {
        await probe(`view-${view}`, () => button(page, view).click())
        const applicable = view === 'Model' ? ['Load Markers', 'Node Labels', 'Element Labels']
          : view === 'Deformed' ? ['Original shape', 'Node Labels', 'Element Labels', 'Legend'] : ['Node Labels', 'Element Labels', 'Legend']
        for (const control of applicable) if (await button(page, control).count()) {
          const row = await probe(`${view}-${control}`, () => button(page, control).click())
          if (control === 'Original shape') assert(row.pixels > 100, 'Original shape must visibly change the rendered geometry')
          await button(page, control).click(); await pause(page)
        }
        if (view === 'Deformed' || view === 'Diagram') {
          const slider = dialog(page).getByRole('slider'); const original = await slider.inputValue()
          await probe(`${view}-scale`, () => setRange(slider, String(view === 'Diagram' ? 2 : Number(original) * 2)))
          await setRange(slider, original); await pause(page)
        }
        if (view === 'Diagram') {
          const metrics = await dialog(page).getByTestId('visualization-toolbar').locator('button').allTextContents()
          for (const metric of metrics.filter(value => /^(N|V2|V3|T|M2|M3) ·/.test(value))) await probe(`component-${metric}`, () => button(page, metric).click())
          await button(page, 'M2 · Moment').click(); await pause(page)
          assert(await page.getByTestId('diagram-peak').count() > 0, 'Saved member samples must produce diagram labels')
          if (scenario.id === 'beam') assert.match(await page.getByTestId('diagram-peak').first().innerText(), /-2\.50 kN[·.]m/)
          if (scenario.id === 'frame3d') {
            assert(await page.getByTestId('diagram-peak').count() < scenario.model.elements.length, 'Default 3D labels must leave the diagram readable')
            await button(page, scenario.model.elements[0].id).click(); await pause(page)
            assert.equal(await page.getByTestId('diagram-peak').count(), 1, 'Inspecting a 3D member shows its own peak and end values')
          }
          await button(page, 'Node Labels').click(); await button(page, 'Element Labels').click(); await pause(page)
          const file = path.join(out, `${scenario.id}-export-2x.png`)
          await probe('export-image', async () => {
            const downloaded = page.waitForEvent('download')
            await button(page, 'Export image').click(); await (await downloaded).saveAs(file)
          }, file)
          const exported = await exportedImage(page, file); exports.push({ scenario: scenario.id, file, ...exported })
          assert.equal(exported.transparent, 0); assert(exported.legendInk > 500, 'PNG must contain its legend')
          await button(page, 'Node Labels').click(); await button(page, 'Element Labels').click()
          if (scenario.id === 'frame3d') await button(page, 'Fit').click()
        }
        if (view !== 'Diagram') {
          const file = path.join(out, `${scenario.id}-${view.toLowerCase()}-export-2x.png`)
          await probe(`${view}-export-image`, async () => {
            const downloaded = page.waitForEvent('download'); await button(page, 'Export image').click(); await (await downloaded).saveAs(file)
          }, file)
          const exported = await exportedImage(page, file); exports.push({ scenario: scenario.id, file, ...exported })
          assert.equal(exported.transparent, 0)
          if (view !== 'Model') assert(exported.legendInk > 500)
        }
      }
      await button(page, 'Model').click(); await pause(page)
      const loadNames = (await dialog(page).locator('aside button').allTextContents()).filter(value => / · (P|M|q|A)$/.test(value))
      for (const name of loadNames) await probe(`inspect-load-${name}`, () => button(page, name).click())
      await button(page, 'Reactions').click(); await pause(page)
      const canvas = page.getByTestId('visualization-modal-scene').locator('canvas')
      const zoom = async () => { const b = await canvas.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.wheel(0, -500); await pause(page) }
      await probe('wheel-zoom', zoom)
      await probe('fit', () => button(page, 'Fit').click())
      await zoom()
      await probe('double-click-fit', async () => { const b = await canvas.boundingBox(); await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2) })
      if (scenario.model.coordinate_system.dimension === '3d') for (const preset of ['Front', 'Side', 'Top', 'Iso']) await probe(`camera-${preset}`, () => button(page, preset).click())
      for (const node of scenario.model.nodes) await probe(`inspect-node-${node.id}`, () => button(page, node.id).click())
      for (const member of scenario.model.elements) await probe(`inspect-member-${member.id}`, () => button(page, member.id).click())
      await probe('clear-selection', () => button(page, 'Clear Selection').click())
      await button(page, scenario.model.nodes[1].id).click()
      await probe('query-object-in-place', async () => {
        const response = page.waitForResponse(r => r.url().includes('/result-review/') && r.url().endsWith('/tools') && r.request().postDataJSON()?.args?.component)
        await button(page, 'Query this object').click(); assert.equal((await (await response).json()).success, true)
        assert.equal(await page.getByTestId('visualization-modal-scene').count(), 1)
        assert((await page.getByTestId('visualization-query-result').innerText()).includes('fz'))
      })
      for (const [view, objectId, component] of [['Deformed', scenario.model.nodes[1].id, 'uz'], ['Diagram', scenario.model.elements[0].id, 'M2']]) {
        await button(page, view).click()
        assert.equal(await page.getByTestId('visualization-query-result').count(), 0, 'Hide the previous quantity in a different view')
        if (view === 'Diagram') await dialog(page).getByRole('button', { name: /^M2 ·/ }).click()
        await button(page, objectId).click()
        await probe(`query-${view}-in-place`, async () => {
          const response = page.waitForResponse(r => r.url().includes('/result-review/') && r.url().endsWith('/tools') && r.request().postDataJSON()?.args?.component)
          await button(page, 'Query this object').click(); assert.equal((await (await response).json()).success, true)
          assert((await page.getByTestId('visualization-query-result').innerText()).includes(component))
          if (scenario.id === 'beam' && view === 'Diagram') assert(!/E-\d+/i.test(await dialog(page).locator('aside').innerText()), 'Beam side-panel noise must format as zero')
        })
      }
      await probe('change-case-link', () => button(page, 'Change case').click())
      const ws = page.getByRole('dialog', { name: 'Result workspace', exact: true })
      const cases = await ws.getByLabel('Case / combination', { exact: true }).locator('option').evaluateAll(os => os.map(o => o.value))
      if (cases.length > 1) {
        await ws.getByLabel('Case / combination', { exact: true }).selectOption(cases[1])
        const response = page.waitForResponse(r => r.url().includes('/result-review/') && r.url().endsWith('/tools') && r.request().postDataJSON()?.args?.component)
        await ws.getByRole('button', { name: 'Query selected result', exact: true }).click(); assert.equal((await (await response).json()).success, true)
        await ws.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await pause(page)
        // The selected case snapshot can finish rendering after the quantity response.
        await dialog(page).locator('h2').filter({ hasText: cases[1].replace(/^(case|combination):/, '') }).waitFor()
        rows.push({ scenario: scenario.id, control: 'workspace-case-to-viewer', class: 'a', domChanged: true })
        await button(page, 'Close Visualization').click()
      }
      await page.keyboard.press('Escape')
      await openFigure()
      await probe('close-viewer', () => button(page, 'Close Visualization').click())
      await page.keyboard.press('Escape')
      // Model-only context preview has no result controls or second case selector.
      await page.getByRole('button', { name: 'Show Results', exact: true }).click()
      await page.getByRole('tab', { name: 'Context', exact: true }).click()
      await page.getByRole('button', { name: 'Preview Model', exact: true }).click()
      await page.getByTestId('visualization-modal-scene').waitFor(); await pause(page)
      assert.equal(await button(page, 'Deformed').count(), 0)
      assert.equal(await button(page, 'Legend').count(), 0)
      for (const name of ['Load Markers', 'Node Labels', 'Element Labels']) if (await button(page, name).count()) await probe(`model-only-${name}`, () => button(page, name).click())
      await button(page, 'Close Visualization').click(); await page.keyboard.press('Escape')
      if (screenshots) for (const locale of ['en', 'zh']) {
        if (locale === 'zh') await page.getByRole('button', { name: 'Switch language to Chinese', exact: true }).click()
        for (const theme of ['light', 'dark']) {
          for (let attempt = 0; attempt < 3 && await page.evaluate(() => localStorage.getItem('theme')) !== theme; attempt++) {
            await page.getByRole('button', { name: locale === 'en' ? /^Toggle theme/ : /切换主题/ }).click()
          }
          assert.equal(await page.evaluate(() => localStorage.getItem('theme')), theme)
          await openFigure(locale)
          for (const width of [1440, 768]) {
            await page.setViewportSize({ width, height: 1000 })
            for (const [index, view] of labels[locale].views.entries()) {
              await button(page, view).click(); await button(page, labels[locale].fit).click(); await pause(page)
              if (index === 2) {
                assert.equal(await page.getByTestId('visualization-query-result').count(), 0, 'A displacement query must not appear in Diagram')
                if (scenario.id === 'beam') assert(!(await page.getByTestId('diagram-end').allTextContents()).some(text => /E-\d+/i.test(text)), 'Beam end noise must format as zero')
              }
              if (locale === 'en' && width === 1440) contrastChecks.push(...await toolbarContrast(page, theme, view))
              if (index > 0) {
                // Canvas dimensions follow ResizeObserver after a view or locale changes.
                await page.waitForFunction(() => {
                  const viewport = document.querySelector('[data-testid="visualization-modal-scene"] canvas')?.getBoundingClientRect()
                  const legend = document.querySelector('[data-testid="visualization-legend"]')?.getBoundingClientRect()
                  return viewport && legend && viewport.width > 0 && viewport.right <= legend.left + 1
                }, undefined, { timeout: 5000 })
              }
              const file = path.join(out, `${scenario.id}-${labels.en.views[index].toLowerCase()}-${theme}-${locale}-${width}.png`)
              await captureDialog(page, file); screenshotPaths.push(file)
              assert(await canvas.evaluate(el => el.getBoundingClientRect().height) > 180, 'Responsive canvas must remain usable')
            }
          }
          await button(page, labels[locale].close).click(); await page.keyboard.press('Escape')
          await page.setViewportSize({ width: 1440, height: 1000 })
        }
      }
      await context.close()
    }
    assert.deepEqual(errors, []); assert.deepEqual(llm.failures, []); assert.equal(llm.pending(), 0)
    save(); console.log(`AUDIT PASS: ${rows.length} controls class a; ${exports.length} opaque exports; ${screenshotPaths.length} screenshots; 0 browser errors`)
    return { rows, exports, screenshotPaths, errors }
  } finally { save(); await browser?.close(); await llm.close(); await api.dispose() }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runVisualizationAudit({ only: process.argv[2], out: process.env.SCLAW_VIZ_OUT || 'G:/StructureClaw-All/verification/visualization-20261019', screenshots: process.env.SCLAW_VIZ_SCREENSHOTS !== '0' })
}
