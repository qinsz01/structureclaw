import { test, expect } from '@playwright/test';

// Real-provider smoke is opt-in. Ordinary E2E replaces only the LLM transport.
test.describe('Live provider: browser analysis delivery', () => {
  test.skip(process.env.SCLAW_E2E_LIVE !== '1', 'Requires an explicitly configured isolated live-provider instance');
  test.describe.configure({ retries: 0, timeout: 360_000 });
  test.beforeEach(async ({ request }) => {
    const response = await request.get('/api/v1/admin/llm');
    expect(response.ok()).toBe(true);
    const settings = await response.json();
    expect(settings.model, 'Configure the isolated instance with a live provider before running this file')
      .not.toMatch(/^e2e-(scripted|unconfigured)$/);
  });

  for (const locale of ['en', 'zh'] as const) {
    test(locale + ': complete beam request reaches saved report and full result viewer', async ({ page, request }, testInfo) => {
      const zh = locale === 'zh';
      const errors: string[] = [];
      const failedAssets: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => {
        if (response.url().includes('/_next/') && response.status() >= 400) failedAssets.push(response.status() + ' ' + response.url());
      });
      await page.goto('/');
      await page.getByRole('button', { name: zh ? /Switch language to Chinese|切换语言为中文/ : /Switch language to English|切换语言为英文/ }).click();
      const prompt = zh
        ? '网页验收：实际计算10 m简支梁，左端铰支、右端滚支，跨中向下集中力1 kN。弹性钢材E=206000 MPa、泊松比0.3、密度7850 kg/m³；实心矩形截面宽100 mm、高200 mm，高沿竖向。不计自重，使用OpenSees二维线弹性静力。请查询两端竖向反力、跨中弯矩和竖向挠度，并生成分析报告；不做规范设计。'
        : 'Browser acceptance: actually analyze a 3 m cantilever beam, fixed at the left end and free at the right end, with a downward 2 kN point load at the free end. Elastic steel E=200000 MPa, Poisson ratio 0.3, density 7850 kg/m³. Solid rectangular section 200 mm wide and 300 mm high, height vertical. Disable self-weight. Use OpenSees 2D linear elastic statics. Query the fixed-end vertical reaction, fixed-end reaction moment and free-end vertical deflection, and generate an analysis report. No code design.';
      const sent = page.waitForRequest(value => value.url().endsWith('/api/v1/chat/stream') && value.method() === 'POST');
      const response = page.waitForResponse(value => value.url().endsWith('/api/v1/chat/stream') && value.request().method() === 'POST');
      await page.getByRole('textbox').fill(prompt);
      await page.getByRole('button', { name: zh ? '发送' : 'Send', exact: true }).click();
      const conversationId = (await sent).postDataJSON().conversationId as string;
      expect(conversationId).toBeTruthy();
      const stream = await response;
      expect(stream.status()).toBe(200);
      expect(await stream.finished()).toBeNull();
      const sessionUrl = '/api/v1/chat/conversation/' + conversationId + '/session';
      await expect.poll(async () => (await (await request.get(sessionUrl)).json()).busy, { timeout: 15_000 }).toBe(false);
      const session = await (await request.get(sessionUrl)).json();
      await testInfo.attach('live-session-summary', { body: JSON.stringify({ conversationId, modelRevision: session.modelRevision,
        analysis: session.analysis, report: session.report }, null, 2), contentType: 'application/json' });
      expect(session.analysis?.current, 'Clarification or final prose alone is not completed calculation').toBe(true);
      expect(session.report?.current, 'The saved analysis report must be current').toBe(true);
      expect(session.report.runId).toBe(session.analysis.runId);

      // Counting sidebar rows cannot prove that the calculation was persisted.
      await page.reload();
      await page.getByTestId('console-history-panel').getByRole('button').filter({ hasText: prompt.slice(0, 25) }).click();
      await page.getByRole('button', { name: zh ? '结果与历史' : 'Results and history', exact: true }).click();
      const workspace = page.getByRole('dialog', { name: zh ? '结果工作区' : 'Result workspace' });
      await expect(workspace.getByRole('combobox', { name: zh ? '运行' : 'Run', exact: true })).toHaveValue(session.analysis.runId);
      await expect(workspace.getByRole('combobox', { name: zh ? '工况／组合' : 'Case / combination' })).toHaveValue(session.analysis.resultKey);
      const queryResponse = page.waitForResponse(value => value.url().includes('/result-review/' + conversationId + '/tools') && value.request().postDataJSON()?.tool === 'query_results');
      await workspace.getByRole('button', { name: zh ? '查询所选结果' : 'Query selected result', exact: true }).click();
      const query = await (await queryResponse).json();
      expect(query.success).toBe(true);
      expect(query.result.runId).toBe(session.analysis.runId);
      expect(Number.isFinite(query.result.quantity?.value)).toBe(true);
      expect(query.result.quantity?.unit).toBe('mm');

      await workspace.getByRole('button', { name: zh ? '查看所选图形' : 'View selected figure', exact: true }).click();
      const viewer = page.getByRole('dialog');
      for (const view of zh ? ['变形', '内力', '反力'] : ['Deformed', 'Forces', 'Reactions']) {
        await expect(viewer.getByRole('button', { name: view, exact: true })).toBeVisible();
      }
      await expect(viewer.getByTestId('visualization-modal-scene')).toBeVisible();
      await expect(viewer).not.toContainText(zh ? '当前没有可用的可视化数据' : 'No visualization data');
      await testInfo.attach('live-result-viewer', { body: await page.screenshot(), contentType: 'image/png' });
      expect(errors).toEqual([]);
      expect(failedAssets).toEqual([]);
    });
  }
});
