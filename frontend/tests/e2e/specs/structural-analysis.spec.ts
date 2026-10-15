import { test, expect } from '@playwright/test';

for (const attempt of [1, 2]) {
  test(`Live provider: original short beam request has no extraction-format retry (${attempt})`, async ({ page, request }, info) => {
    test.skip(process.env.SCLAW_E2E_LIVE !== '1', 'Requires a configured isolated live provider');
    test.setTimeout(360_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: /Switch language to Chinese|切换语言为中文/ }).click();
    const sent = page.waitForRequest(r => r.url().endsWith('/api/v1/chat/stream') && r.method() === 'POST');
    const response = page.waitForResponse(r => r.url().endsWith('/api/v1/chat/stream') && r.request().method() === 'POST');
    await page.getByRole('textbox').fill('设计一个简支梁，跨度10m，梁中间荷载1kN');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const id = (await sent).postDataJSON().conversationId;
    expect(await (await response).finished()).toBeNull();
    const session = await (await request.get(`/api/v1/chat/conversation/${id}/session`)).json();
    const conversation = await (await request.get(`/api/v1/chat/conversation/${id}`)).json();
    await info.attach('original-short-request', { body: JSON.stringify({ conversation, session }, null, 2), contentType: 'application/json' });
    await info.attach('original-short-browser', { body: await page.screenshot(), contentType: 'image/png' });
    const toolMessages = conversation.messages.filter((m: { role: string }) => m.role === 'tool');
    expect(toolMessages.filter((m: { content: string }) => /^Error:|RECOVERY_BUDGET_EXHAUSTED|"success":false/.test(m.content))).toEqual([]);
    const extractions = toolMessages.filter((m: { name: string }) => m.name === 'extract_draft_params');
    expect(extractions).toHaveLength(1);
    const extracted = JSON.parse(extractions[0].content);
    expect(extracted.nextState.engineeringDraft.geometry.lengthM).toBe(10);
    expect(extracted.nextState.engineeringDraft.loads).toHaveLength(1);
    expect(extracted.nextState.engineeringDraft.loads[0].magnitude).toBe(1);
    expect(session.usage.recoveries).toBe(0);
    expect(session.waitingForReply || session.analysis.current, 'Reach calculation or specific engineering clarification').toBe(true);
    expect(pageErrors).toEqual([]);
  });
}

test('Live provider: omitted properties pause, supplied properties resume and calculate', async ({ page, request }, info) => {
  test.skip(process.env.SCLAW_E2E_LIVE !== '1', 'Requires a configured isolated live provider');
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Switch language to Chinese|切换语言为中文/ }).click();
  const sent = page.waitForRequest(r => r.url().endsWith('/api/v1/chat/stream') && r.method() === 'POST');
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/chat/stream') && r.request().method() === 'POST');
  await page.getByRole('textbox').fill('设计一个简支梁，跨度10m，梁中间荷载1kN');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const id = (await sent).postDataJSON().conversationId;
  expect(await (await response).finished()).toBeNull();
  const url = '/api/v1/chat/conversation/' + id + '/session';
  await expect.poll(async () => (await (await request.get(url)).json()).busy).toBe(false);
  const paused = await (await request.get(url)).json();
  await info.attach('clarification-session', { body: JSON.stringify(paused, null, 2), contentType: 'application/json' });
  expect(paused.waitingForReply).toBe(true);
  expect(paused.analysis.current).toBe(false);
  expect(paused.usage.recoveries).toBe(0);
  const resumed = page.waitForResponse(r => r.url().endsWith('/api/v1/chat/stream/resume') && r.request().method() === 'POST');
  await page.getByRole('textbox').fill('明确采用弹性钢材，E=206000 MPa、泊松比0.3、密度7850 kg/m³；单根梁使用实心矩形截面，宽100mm、高200mm，200mm沿竖向。左端铰支、右端滚支，跨中1kN向下，不计自重。使用OpenSees二维线弹性静力。先只做分析，不做规范设计；查询两端竖向反力、跨中弯矩和竖向挠度，生成分析报告。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  expect(await (await resumed).finished()).toBeNull();
  await expect.poll(async () => (await (await request.get(url)).json()).busy).toBe(false);
  const finished = await (await request.get(url)).json();
  const conversation = await (await request.get('/api/v1/chat/conversation/' + id)).json();
  await info.attach('live-conversation', { body: JSON.stringify(conversation, null, 2), contentType: 'application/json' });
  await info.attach('live-final-session', { body: JSON.stringify(finished, null, 2), contentType: 'application/json' });
  await info.attach('live-clarification-browser', { body: await page.screenshot(), contentType: 'image/png' });
  expect(finished.waitingForReply, 'Repeated clarification is not completed calculation').toBe(false);
  expect(finished.analysis.current).toBe(true);
  expect(finished.report.current).toBe(true);
  expect(errors).toEqual([]);
  // Final success must not conceal an earlier wrong calculation or tool error.
  const analyses = conversation.messages.filter((m: { role: string; name: string }) => m.role === 'tool' && m.name === 'run_analysis');
  expect(analyses.length).toBeGreaterThan(0);
  for (const message of analyses) {
    const result = JSON.parse(message.content);
    expect(result.success).toBe(true);
    expect(result.keyMetrics.maxAbsReaction).toBeCloseTo(0.5, 8);
    expect(result.keyMetrics.maxAbsMoment).toBeCloseTo(2.5, 8);
    expect(result.keyMetrics.maxAbsDisplacement * 1000).toBeCloseTo(1.516990291262136, 8);
  }
  const toolErrors = conversation.messages.filter((m: { role: string; content: string }) => m.role === 'tool' && /^Error:|RECOVERY_BUDGET_EXHAUSTED|"success":false/.test(m.content));
  expect(toolErrors, 'Preserve real failures rather than silently retry the test').toEqual([]);
});

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

for (const locale of ['zh', 'en'] as const) {
  test(`Live provider: scoped force calculation without stiffness (${locale})`, async ({ page, request }, info) => {
    test.skip(process.env.SCLAW_E2E_LIVE !== '1', 'Requires configured isolated live provider');
    test.setTimeout(360_000);
    const zh=locale==='zh', errors:string[]=[];
    page.on('pageerror', e=>errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button',{name:zh?/Switch language to Chinese|切换语言为中文/:/Switch language to English|切换语言为英文/}).click();
    const prompt=zh?'只求内力：10m水平简支梁，左铰右滚，跨中向下1kN集中力，仅考虑这个荷载，不计自重。告诉我跨中弯矩和两端竖向反力，不求变形，不做规范设计，不生成计算书。'
      :'Forces only: horizontal 3 m cantilever, fixed at the left and free at the right, downward 2 kN concentrated force at the free end, no self-weight. Find the fixed-end bending moment and vertical reaction. No deformation, code design or report.';
    const sent=page.waitForRequest(r=>r.url().endsWith('/api/v1/chat/stream')&&r.method()==='POST');
    const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/chat/stream')&&r.request().method()==='POST');
    await page.getByRole('textbox').fill(prompt);
    await page.getByRole('button',{name:zh?'发送':'Send',exact:true}).click();
    const id=(await sent).postDataJSON().conversationId;
    expect(await (await response).finished()).toBeNull();
    const session=await (await request.get(`/api/v1/chat/conversation/${id}/session`)).json();
    const conversation=await (await request.get(`/api/v1/chat/conversation/${id}`)).json();
    await info.attach('live-scoped-conversation',{body:JSON.stringify(conversation,null,2),contentType:'application/json'});
    await info.attach('live-scoped-session',{body:JSON.stringify(session,null,2),contentType:'application/json'});
    await info.attach('live-scoped-browser',{body:await page.screenshot(),contentType:'image/png'});
    expect(session.waitingForReply,'Must not request material, section or design conditions for determinate force calculation').toBe(false);
    expect(session.analysis.current).toBe(true);
    expect(session.report.current).toBe(false);
    const run=await (await request.get('/runs/'+session.analysis.runId)).json();
    expect(run.meta.engineId).toBe('builtin-equilibrium');
    expect(run.modelSnapshot.materials).toEqual([]);expect(run.modelSnapshot.sections).toEqual([]);
    const data=run.results[session.analysis.resultKey].data;
    expect(data.reactions.A.fz).toBeCloseTo(zh?0.5:2,8);
    expect(data.envelope.maxAbsMoment).toBeCloseTo(zh?2.5:6,8);
    expect(data.displacements).toBeUndefined();
    await page.getByRole('button', { name: zh ? '结果与历史' : 'Results and history', exact: true }).click();
    const workspace = page.getByRole('dialog', { name: zh ? '结果工作区' : 'Result workspace' });
    const selectedQuery = page.waitForResponse(r => r.url().includes('/result-review/' + id + '/tools') && r.request().postDataJSON()?.tool === 'query_results');
    await workspace.getByRole('button', { name: zh ? '查询所选结果' : 'Query selected result', exact: true }).click();
    const queried = await (await selectedQuery).json();
    expect(queried.success).toBe(true);
    expect(queried.result.quantity.unit).toBe('kN');
    await workspace.getByRole('button', { name: zh ? '查看所选图形' : 'View selected figure', exact: true }).click();
    const viewer = page.getByRole('dialog');
    for (const view of zh ? ['内力', '反力'] : ['Forces', 'Reactions']) {
      await expect(viewer.getByRole('button', { name: view, exact: true })).toBeVisible();
    }
    await expect(viewer.getByRole('button', { name: zh ? '变形' : 'Deformed', exact: true })).toHaveCount(0);
    await expect(viewer.getByTestId('visualization-modal-scene')).toBeVisible();
    await info.attach('live-force-viewer', { body: await page.screenshot(), contentType: 'image/png' });
    expect(conversation.messages.filter((m:{role:string;name:string;content:string})=>m.role==='tool'&&/^Error:|"success":false/.test(m.content))).toEqual([]);
    expect(conversation.messages.filter((m:{role:string;name:string})=>m.role==='tool'&&m.name==='ask_user_clarification')).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('Live provider: missing stiffness delivers forces before requesting deflection inputs', async ({ page, request }, info) => {
  test.skip(process.env.SCLAW_E2E_LIVE !== '1', 'Requires configured isolated live provider');
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Switch language to Chinese|切换语言为中文/ }).click();
  const sent = page.waitForRequest(r => r.url().endsWith('/api/v1/chat/stream') && r.method() === 'POST');
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/chat/stream') && r.request().method() === 'POST');
  await page.getByRole('textbox').fill('10m水平简支梁，左铰右滚，跨中向下1kN集中力，仅考虑这个荷载，不计自重。请告诉我跨中弯矩、两端竖向反力和跨中竖向挠度。不做规范设计，不生成计算书。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const id = (await sent).postDataJSON().conversationId;
  expect(await (await response).finished()).toBeNull();
  const session = await (await request.get(`/api/v1/chat/conversation/${id}/session`)).json();
  const conversation = await (await request.get(`/api/v1/chat/conversation/${id}`)).json();
  await info.attach('live-partial-conversation', { body: JSON.stringify(conversation, null, 2), contentType: 'application/json' });
  await info.attach('live-partial-session', { body: JSON.stringify(session, null, 2), contentType: 'application/json' });
  await info.attach('live-partial-browser', { body: await page.screenshot(), contentType: 'image/png' });
  expect(session.analysis.current, 'Independent force results must be delivered before clarification').toBe(true);
  expect(session.report.current).toBe(false);
  const run = await (await request.get('/runs/' + session.analysis.runId)).json();
  const data = run.results[session.analysis.resultKey].data;
  expect(run.meta.engineId).toBe('builtin-equilibrium');
  expect(data.status).toBe('partial');
  expect(data.missingRequestedResponses).toContain('displacements');
  expect(data.displacements).toBeUndefined();
  expect(data.reactions.A.fz).toBeCloseTo(0.5, 8);
  expect(data.reactions.B.fz).toBeCloseTo(0.5, 8);
  expect(data.envelope.maxAbsMoment).toBeCloseTo(2.5, 8);
  expect(conversation.messages.filter((m: { role: string; content: string }) => m.role === 'tool' && /^Error:|"success":false/.test(m.content))).toEqual([]);
  expect(conversation.messages.filter((m: { role: string; name: string }) => m.role === 'tool' && m.name === 'run_code_check')).toEqual([]);
  expect(conversation.messages.filter((m: { role: string; name: string }) => m.role === 'tool' && m.name === 'generate_report')).toEqual([]);
  const final = conversation.messages.filter((m: { role: string }) => m.role === 'assistant').at(-1)?.content ?? '';
  expect(final).toMatch(/刚度|弹性模量|材料|截面/);
  expect(errors).toEqual([]);
});
