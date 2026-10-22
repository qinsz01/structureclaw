import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'

// This is a browser layout regression with saved-history responses, not an LLM test.
const history = Array.from({ length: 50 }, (_, index) => ({
  id: `history-layout-${index}`, title: `Saved conversation #${index} — 已保存的结构分析会话`,
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
}))
const viewports = [{ width: 375, height: 667 }, { width: 768, height: 1000 },
  { width: 1024, height: 768 }, { width: 844, height: 390 }]

for (const locale of ['en', 'zh'] as const) {
  test(`history stays out of the chat viewport and remains usable: ${locale}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    const zh = locale === 'zh'
    const labels = { open: zh ? '展开历史' : 'Expand History', close: zh ? '收起历史' : 'Collapse History',
      history: zh ? '会话历史' : 'Conversation History', settings: zh ? '打开设置' : 'Open settings',
      settingsDialog: zh ? '工作区设置' : 'Workspace Settings', send: zh ? '发送' : 'Send',
      newConversation: zh ? '新建对话' : 'New Conversation' }
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.context().addCookies([{ name: 'structureclaw.locale', value: locale, url: String(info.project.use.baseURL) }])
    await page.addInitScript(locale => {
      localStorage.setItem('structureclaw.locale', locale)
      localStorage.setItem('theme', 'light')
      localStorage.setItem('structureclaw.console.ui-preferences', JSON.stringify({ historyCollapsed: true }))
    }, locale)
    await page.route('**/api/v1/chat/conversations', route => route.fulfill({ json: history }))
    await page.route(/\/api\/v1\/chat\/conversation\/history-layout-\d+(?:\/(?:session|snapshot))?(?:\?.*)?$/, route => {
      const url = new URL(route.request().url())
      const id = url.pathname.split('/')[5]
      if (url.pathname.endsWith('/snapshot')) return route.fulfill({ json: { success: true } })
      const session = { conversationId: id, busy: false, waitingForReply: false, question: null, options: [],
        policy: null, usage: null, modelRevision: 0, modelPending: false, jobs: [],
        analysis: { current: false, runId: null, resultKey: null, reason: 'ANALYSIS_REQUIRED' },
        report: { current: false, runId: null } }
      return route.fulfill({ json: url.pathname.endsWith('/session') ? session : {
        id, title: history[49].title, session, messages: [
          { id: 'layout-user', role: 'user', content: 'Read the saved conversation.' },
          { id: 'layout-reply', role: 'assistant', content: 'LAYOUT_SAVED_REPLY\n\n'
            + Array.from({ length: 100 }, (_, i) => `Saved result paragraph ${i}. 已保存的结构分析结果。`).join('\n\n') },
        ],
      } })
    })
    const grid = page.getByTestId('console-layout-grid')
    const input = page.locator('textarea[placeholder]')
    const drawer = page.getByRole('dialog', { name: labels.history, exact: true })
    const trigger = page.getByRole('button', { name: labels.open, exact: true }).first()
    const measurements: unknown[] = []
    async function checkViewport(state: string) {
      await expect(input).toBeInViewport({ ratio: .99 })
      await expect(page.getByRole('button', { name: labels.send, exact: true })).toBeInViewport({ ratio: .99 })
      const measure = await page.evaluate(() => {
        const bounds = document.querySelector('[data-testid="console-chat-panel"]')!.getBoundingClientRect()
        return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight, chat: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } }
      })
      expect(measure.documentWidth).toBeLessThanOrEqual(measure.width + 1)
      expect(measure.documentHeight).toBeLessThanOrEqual(measure.height + 1)
      expect(measure.chat.y).toBeLessThan(150)
      expect(measure.chat.y + measure.chat.height).toBeLessThanOrEqual(measure.height + 1)
      measurements.push({ state, ...measure })
    }

    await page.setViewportSize(viewports[0])
    await page.goto('/')
    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      await expect(grid).toHaveAttribute('data-history-collapsed', 'true')
      await expect(page.getByTestId('console-history-scroll')).toHaveCount(0)
      await checkViewport('idle')
      await input.fill('Keep this unsent draft')
      await trigger.click()
      await expect(drawer).toBeVisible()
      await expect(drawer.getByRole('button', { name: /Saved conversation #/ })).toHaveCount(50)
      const scroll = drawer.getByTestId('console-history-scroll')
      expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
      await drawer.getByRole('button', { name: /^Saved conversation #49 / }).scrollIntoViewIfNeeded()
      expect(await scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
      await page.keyboard.press('Escape')
      await expect(drawer).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await expect(input).toHaveValue('Keep this unsent draft')
      await trigger.click()
      await drawer.getByRole('button', { name: labels.close, exact: true }).click()
      await expect(drawer).toHaveCount(0)
      await trigger.click()
      await page.mouse.click(viewport.width - 2, viewport.height / 2)
      await expect(drawer).toHaveCount(0)
      await checkViewport('idle-after-history')
      if (viewport.width !== 1024) await page.screenshot({ path: info.outputPath(`${locale}-idle-${viewport.width}.png`), fullPage: true })
    }

    await page.getByRole('button', { name: labels.newConversation, exact: true }).click()
    await expect(input).toHaveValue('')
    await trigger.click()
    await drawer.getByRole('button', { name: /^Saved conversation #49 / }).click()
    await expect(drawer).toHaveCount(0)
    await expect(page.getByTestId('console-chat-scroll')).toContainText('LAYOUT_SAVED_REPLY')
    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      await checkViewport('saved-conversation')
      const transcript = page.getByTestId('console-chat-scroll')
      expect(await transcript.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
      await transcript.evaluate(el => { el.scrollTop = 0 })
      await transcript.hover()
      await page.mouse.wheel(0, 500)
      await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
      if (viewport.width !== 1024) await page.screenshot({ path: info.outputPath(`${locale}-saved-${viewport.width}.png`), fullPage: true })
    }

    await page.setViewportSize({ width: 1366, height: 768 })
    await expect(grid).toHaveAttribute('data-history-collapsed', 'true')
    await trigger.click()
    await expect(grid).toHaveAttribute('data-history-collapsed', 'false')
    await expect.poll(async () => (await page.getByTestId('console-history-panel').boundingBox())!.width).toBeGreaterThan(200)
    const sidebar = await page.getByTestId('console-history-panel').boundingBox()
    const chat = await page.getByTestId('console-chat-panel').boundingBox()
    expect(chat!.x).toBeGreaterThanOrEqual(sidebar!.x + sidebar!.width)
    await page.getByRole('button', { name: labels.close, exact: true }).click()
    await page.setViewportSize(viewports[1])
    await trigger.click()
    await expect(drawer).toBeVisible()
    await page.setViewportSize({ width: 1366, height: 768 })
    await expect(drawer).toHaveCount(0)
    await expect(grid).toHaveAttribute('data-history-collapsed', 'true')
    await page.setViewportSize(viewports[1])
    await expect(drawer).toHaveCount(0)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('structureclaw.console.ui-preferences')!).historyCollapsed)).toBe(true)
    await trigger.click()
    await drawer.getByRole('button', { name: labels.settings, exact: true }).click()
    await expect(drawer).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: labels.settingsDialog, exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
    expect(pageErrors).toEqual([])
    const receipt = info.outputPath('layout-measurements.json')
    await fs.writeFile(receipt, JSON.stringify({ locale, pageErrors, measurements }, null, 2))
    await info.attach('layout-measurements', { path: receipt, contentType: 'application/json' })
  })
}
