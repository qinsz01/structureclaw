import { test, expect, type Page } from '@playwright/test'
import { startLlmFixture, configureFixtureLlm, toolCall } from '../fixtures/llm-server'
import { beamModel, beamAnalysis } from '../fixtures/engineering-beam'

const draft = { inferredType: 'unknown', engineeringDraft: {
  coordinateSystem: beamModel.coordinate_system,
  topology: { nodes: beamModel.nodes, members: beamModel.elements },
  materials: beamModel.materials, sectionRecords: beamModel.sections, loadCases: beamModel.load_cases,
  analysisControl: beamModel.analysis_control,
} }

async function send(page: Page, text: string, sendLabel: string) {
  const response = page.waitForResponse(value => value.url().endsWith('/api/v1/chat/stream'), { timeout: 120_000 })
  await page.locator('textarea[placeholder]').fill(text)
  await page.getByRole('button', { name: sendLabel, exact: true }).click()
  const stream = await response
  await stream.text()
  return stream.request().postDataJSON().conversationId as string
}

test.describe('Allowed and actually used modelling skills', () => {
  let llm: Awaited<ReturnType<typeof startLlmFixture>>
  test.beforeAll(async ({ request }) => {
    llm = await startLlmFixture()
    await configureFixtureLlm(request, llm)
  })
  test.afterAll(async () => { await llm?.close() })

  for (const locale of ['en', 'zh'] as const) {
    test(`generic modelling and a zero-skill model import have distinct execution records: ${locale}`, async ({ page, request }, info) => {
      test.setTimeout(240_000)
      const zh = locale === 'zh'
      const labels = {
        conversation: zh ? '新建对话' : 'New Conversation', settings: zh ? '会话设置' : 'Conversation settings',
        scope: zh ? '结构技能' : 'Structure skills', generic: zh ? '通用结构类型' : 'Generic Structure Type',
        send: zh ? '发送' : 'Send', allowed: zh ? '允许使用的技能' : 'Allowed skills',
        actual: zh ? '本轮实际使用' : 'Used this run', unused: zh ? '未调用建模技能' : 'No modelling skill invoked',
      }
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.context().addCookies([{ name: 'structureclaw.locale', value: locale, url: String(info.project.use.baseURL) }])
      await page.addInitScript(locale => { localStorage.setItem('structureclaw.locale', locale); localStorage.setItem('theme', 'light') }, locale)
      await page.goto('/')
      await page.getByRole('button', { name: labels.conversation, exact: true }).click()
      const settings = page.locator('summary').filter({ hasText: new RegExp(`^${labels.settings}$`) })
      await settings.click()
      await page.getByLabel(labels.scope, { exact: true }).selectOption('restricted')
      for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.uncheck()
      await page.getByLabel(labels.generic, { exact: true }).check()
      await settings.click()
      llm.enqueue(toolCall('extract_draft_params', { locale }), JSON.stringify(draft),
        toolCall('build_model', {}), JSON.stringify(beamModel), toolCall('validate_model', {}),
        toolCall('run_analysis', beamAnalysis), 'GENERIC_USAGE_DONE')
      const prompt = zh
        ? '仅使用允许的建模技能，计算二维X-Z平面10m简支钢梁，A=(0,0,0)铰支，B=(10,0,0)滚支，跨中全局Z向下1kN。钢材E=206000MPa、nu=0.3、rho=7850kg/m³，实心矩形宽100mm、高200mm。用OpenSees线弹性静力分析，不计自重和其他荷载。'
        : 'Use the allowed modelling skill to analyze a 10m simply supported steel beam in the X-Z plane. A=(0,0,0) is pinned and B=(10,0,0) is a roller; apply 1kN down global Z at midspan. E=206000MPa, nu=0.3, rho=7850kg/m³; solid rectangular section 100mm wide and 200mm deep. Run OpenSees linear static analysis without self-weight or other loads.'
      const id = await send(page, prompt, labels.send)
      const runtime = await (await request.get(`/api/v1/chat/conversation/${id}/session`)).json()
      expect(runtime.analysis.current).toBe(true)
      expect(runtime.modeling).toMatchObject({ usedSkillIds: ['generic'], builder: 'llm' })
      expect(llm.failures).toEqual([])
      expect(llm.pending()).toBe(0)
      const summary = page.getByTestId('run-skill-summary')
      await expect(summary).toContainText(`${labels.allowed}: ${labels.generic}`)
      await expect(page.getByTestId('run-used-skills')).toContainText(`${labels.actual}: ${labels.generic}`)
      const run = await (await request.get(`/runs/${runtime.analysis.runId}`)).json()
      const verticalReaction = Object.values(run.data.reactions as Record<string, { fz?: number }>).reduce((sum, row) => sum + (row.fz ?? 0), 0)
      expect(verticalReaction).toBeCloseTo(1, 6)

      for (const theme of ['light', 'dark']) {
        await page.getByRole('button', { name: zh ? '打开设置' : 'Open settings', exact: true }).click()
        await page.getByRole('tab', { name: zh ? '外观' : 'Appearance', exact: true }).click()
        await page.getByLabel(zh ? '主题' : 'Theme', { exact: true }).selectOption(theme)
        await page.keyboard.press('Escape')
        for (const width of [1440, 768]) {
          await page.setViewportSize({ width, height: 1000 })
          expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
          const bounds = await summary.boundingBox()
          expect(bounds).not.toBeNull()
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
          await page.screenshot({ path: info.outputPath(`${locale}-${theme}-${width}.png`), fullPage: true })
        }
      }

      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.getByRole('button', { name: labels.conversation, exact: true }).click()
      await settings.click()
      await page.getByLabel(labels.scope, { exact: true }).selectOption('restricted')
      for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.uncheck()
      await settings.click()
      await page.getByRole('button', { name: zh ? '工程上下文' : 'Context', exact: true }).click()
      await page.getByPlaceholder(/StructureModel v2 JSON/).fill(JSON.stringify(beamModel))
      await page.keyboard.press('Escape')
      llm.enqueue(toolCall('run_analysis', beamAnalysis), 'EXPLICIT_USAGE_DONE')
      const importedId = await send(page, 'Analyze the supplied complete model without a modelling skill.', labels.send)
      const imported = await (await request.get(`/api/v1/chat/conversation/${importedId}/session`)).json()
      expect(imported.policy.activeSkillIds).toEqual([])
      expect(imported.analysis.current).toBe(true)
      expect(imported.modeling.usedSkillIds).toEqual([])
      await expect(page.getByTestId('run-used-skills')).toContainText(labels.unused)
      expect(llm.failures).toEqual([])
      expect(errors).toEqual([])
    })
  }
})
