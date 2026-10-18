import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('Live provider: confirmed design inputs survive edit, check and report', async ({ page, request }, info) => {
  test.skip(process.env.SCLAW_E2E_LIVE !== '1', 'Requires a configured isolated live provider');
  test.setTimeout(900_000);
  const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '../backend/tests/fixtures/design-edit-boundary-20261015.json'), 'utf8').replace(/^\uFEFF/, ''));
  fixture.model.analysis_control = { self_weight: false, rigid_floor: false, rigid_offsets: false, p_delta: false, construction_stage: false };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().addCookies([{ name: 'structureclaw.locale', value: 'zh', url: info.project.use.baseURL! }]);
  await page.addInitScript(() => localStorage.setItem('structureclaw.locale', 'zh'));
  await page.goto('/capabilities');
  await page.waitForLoadState('networkidle');
  const { skills } = await (await request.get('/api/v1/agent/skills')).json();
  for (const id of ['beam', 'opensees-static', 'validation-structure-model', 'report-export-builtin', 'code-check-gb50017']) {
    const skill = skills.find((item: { id: string }) => item.id === id);
    expect(skill).toBeTruthy();
    const selected = await page.evaluate(() => JSON.parse(localStorage.getItem('structureclaw.console.capabilities') ?? '{}').skillIds ?? []);
    if (!selected.includes(id)) await page.getByRole('button', { name: skill.name.zh, exact: true }).click();
  }
  await page.goto('/');
  await page.getByRole('button', { name: /^(Context|工程上下文)$/ }).click();
  await page.getByPlaceholder(/Paste StructureModel v2 JSON here|将 StructureModel v2 JSON 粘贴/).fill(JSON.stringify(fixture.model));
  await page.keyboard.press('Escape');
  const send = async (text: string) => {
    const response = page.waitForResponse(r => /\/api\/v1\/chat\/stream(?:\/resume)?$/.test(r.url()) && r.request().method() === 'POST');
    await page.getByRole('textbox').fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const stream = await response;
    expect(await stream.finished()).toBeNull();
    const events = (await stream.text()).split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    const id = events.find(event => event.type === 'start')?.content?.conversationId ?? stream.request().postDataJSON().conversationId;
    const conversation = await (await request.get(`/api/v1/chat/conversation/${id}`)).json();
    const session = await (await request.get(`/api/v1/chat/conversation/${id}/session`)).json();
    await info.attach(`design-turn-${session.modelRevision}`, { body: JSON.stringify({ conversation, session }, null, 2), contentType: 'application/json' });
    const failures = conversation.messages.filter((m: { role: string; content: string }) => m.role === 'tool' && /^Error:|RECOVERY_BUDGET_EXHAUSTED|"success":false/.test(m.content));
    expect(failures, 'A final success must not conceal edit format errors').toEqual([]);
    expect(session.usage.recoveries).toBe(0);
    return { id, conversation, session };
  };
  const first = await send('请在已提供的10m简支梁模型上进行OpenSees计算和GB50017-2017校核，不计自重。已确认条件：Q235（t≤16mm）f=215MPa、fv=125MPa、beta1=1.1；I20a补充属性S≈104cm³、tw=5.2mm、Wnx=237cm³、imin≈21mm；跨中设侧向支承；挠度限值L/250。只把已给定的条件写入模型，不要自行补造未给定的系数或限值。用原有LC1作为使用工况，保留原组合，并明确剩余缺项。');
  const checks = first.conversation.messages.filter((m: { role: string; name: string }) => m.role === 'tool' && m.name === 'run_code_check');
  expect(checks.length).toBeGreaterThan(0);
  const partial = JSON.parse(checks.at(-1).content);
  expect(partial).toMatchObject({ completionStatus: 'incomplete', complianceStatus: 'incomplete' });
  const missing = partial.missingInputs.map((row: { field: string }) => row.field);
  for (const field of ['material.design.f', 'material.design.fv', 'member.design.beta1', 'member.design.deflectionLimitN', 'section.S', 'section.tw', 'section.Wnx', 'section.imin', 'response.deflection']) expect(missing).not.toContain(field);
  const second = await send('补充明确的本次测试条件（不是让你推定标准值）：两个构件均取phi_b=0.9、btLimit=13、lambdaLimit=250、计算长度l0=5000mm；截面板件计算宽度b=40mm、板厚t=8.4mm。保留前面全部条件与工况组合。更新现有模型后重新计算、完成内置GB50017校核、查询跨中节点竖向挠度并生成中文报告；报告说明这些是用户给定条件。');
  const finalChecks = second.conversation.messages.filter((m: { role: string; name: string }) => m.role === 'tool' && m.name === 'run_code_check');
  expect(JSON.parse(finalChecks.at(-1).content)).toMatchObject({ completionStatus: 'complete', complianceStatus: 'pass', conclusionEligible: true });
  expect(second.session.analysis.current).toBe(true);
  expect(second.session.report.current).toBe(true);
  await info.attach('confirmed-design-browser', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

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
    // Forces come from the solver on labelled unit stiffness; its displacements are never presented.
    const run=await (await request.get('/runs/'+session.analysis.runId)).json();
    expect(run.modelSnapshot.metadata.stiffnessPlaceholder).toBeTruthy();
    const data=run.results[session.analysis.resultKey].data;
    const verticalReaction=Object.values(data.reactions as Record<string,{fz:number}>).reduce((sum,reaction)=>sum+reaction.fz,0);
    expect(verticalReaction).toBeCloseTo(zh?1:2,8);
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

test('Live provider: a deflection request without stiffness asks for the material and section', async ({ page, request }, info) => {
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
  // Deflection needs the real stiffness, so the agent asks before analysing; nothing is presented on placeholder stiffness.
  expect(session.waitingForReply, 'A deflection request must ask for the material and section').toBe(true);
  expect(session.report.current).toBe(false);
  expect(conversation.messages.filter((m: { role: string; content: string }) => m.role === 'tool' && /^Error:|"success":false/.test(m.content))).toEqual([]);
  expect(conversation.messages.filter((m: { role: string; name: string }) => m.role === 'tool' && m.name === 'run_code_check')).toEqual([]);
  expect(conversation.messages.filter((m: { role: string; name: string }) => m.role === 'tool' && m.name === 'generate_report')).toEqual([]);
  expect(JSON.stringify(conversation.messages)).toMatch(/刚度|弹性模量|材料|截面/);
  expect(errors).toEqual([]);
});
