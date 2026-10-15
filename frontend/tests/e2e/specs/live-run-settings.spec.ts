import { test, expect, type Page, type APIRequestContext, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// No route mocks or scripted LLM responses: browser controls, live provider and
// persisted server policy are exercised together on the isolated E2E instance.
test.describe('Live provider: capability and run switches', () => {
  test.skip(process.env.SCLAW_E2E_LIVE !== '1', 'Requires a configured isolated live provider');
  test.describe.configure({ retries: 0, timeout: 360_000 });
  test.use({ actionTimeout: 15_000 });
  const conversationIds = new Map<string, Set<string>>();
  test.beforeEach(async ({ page }, info) => {
    const ids = new Set<string>();
    conversationIds.set(info.testId, ids);
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/v1/chat/stream')) {
        const id = request.postDataJSON()?.conversationId;
        if (typeof id === 'string') ids.add(id);
      }
    });
  });
  test.afterEach(async ({ request }, info) => {
    // Preserve authoritative state even if a live provider times out mid-stream.
    for (const id of conversationIds.get(info.testId) ?? []) {
      const evidence: Record<string, unknown> = { id };
      for (const [name, suffix] of [['session', '/session'], ['conversation', '']] as const) {
        try {
          const response = await request.get(`/api/v1/chat/conversation/${id}${suffix}`, { timeout: 10_000 });
          evidence[name] = await response.json();
        } catch (error) {
          evidence[name] = { collectionError: String(error) };
        }
      }
      await retainAttachment(info, 'live-server-evidence', JSON.stringify(evidence, null, 2), 'application/json');
    }
    conversationIds.delete(info.testId);
  });

  test('beam calculation with guidance and repair off and generic model building', async ({ page, request }, info) => {
    test.setTimeout(720_000); // A complete live model/solver/report chain uses several provider calls.
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'structureclaw.locale', value: 'en', url: info.project.use.baseURL! }]);
    await page.addInitScript(() => localStorage.setItem('structureclaw.locale', 'en'));
    await page.goto('/');
    await openRunSettings(page, false);
    await page.getByRole('combobox', { name: 'Professional guidance', exact: true }).selectOption('disabled');
    await page.getByRole('combobox', { name: 'Model builder', exact: true }).selectOption('llm');
    await page.getByRole('combobox', { name: 'Automatic correction after failure', exact: true }).selectOption('0');
    await page.getByRole('combobox', { name: 'Conversation context', exact: true }).selectOption('current-turn');
    await page.getByLabel('Tool call limit', { exact: true }).fill('24');
    await page.getByRole('combobox', { name: 'Skill routing', exact: true }).selectOption('skill:beam');
    await page.getByRole('combobox', { name: 'Memory read and write scope', exact: true }).selectOption('');
    await page.getByLabel('Internal LLM call limit', { exact: true }).fill('30');
    const result = await send(page, request, info,
      'Switch acceptance: actually analyze a 4 m simply supported beam, pinned at the left end and roller-supported at the right end, with a 1 kN downward point load at midspan. Use elastic steel E=200000 MPa, Poisson ratio 0.3 and density 7850 kg/m³. The solid rectangular section is 100 mm wide and 200 mm high, height vertical. Disable self-weight. Use OpenSees 2D linear elastic statics. Query both vertical reactions, midspan bending moment and vertical deflection, then generate an analysis report. No code design.',
      false, 'beam-alternative-policy');
    expect(result.session.policy).toMatchObject({ knowledge: 'disabled', builder: 'llm', routing: { mode: 'fixed', skillId: 'beam' },
      repair: { enabled: false, maxRecoveriesPerTurn: 0 }, context: { history: 'current-turn', memoryScopes: [] } });
    expect(result.session.policy.activeToolIds).not.toContain('memory');
    expect(result.session.analysis.current, 'A clarification is not a completed analysis').toBe(true);
    expect(result.session.report.current).toBe(true);
    expect(result.session.report.runId).toBe(result.session.analysis.runId);
    expect(result.session.usage.recoveries).toBe(0);
    const conversation = await (await request.get(`/api/v1/chat/conversation/${result.id}`)).json();
    await retainAttachment(info, 'beam-alternative-conversation', JSON.stringify(conversation, null, 2), 'application/json');
    const tools = conversation.messages.filter((message: { role: string }) => message.role === 'tool');
    expect(tools.filter((message: { content: string }) => /^Error:|RECOVERY_BUDGET_EXHAUSTED|"success":false/.test(message.content))).toEqual([]);
    const analyses = tools.filter((message: { name: string }) => message.name === 'run_analysis');
    expect(analyses.length).toBeGreaterThan(0);
    for (const message of analyses) {
      const analysis = JSON.parse(message.content);
      expect(analysis.success).toBe(true);
      expect(analysis.keyMetrics.maxAbsReaction).toBeCloseTo(0.5, 8);
      expect(analysis.keyMetrics.maxAbsMoment).toBeCloseTo(1, 8);
      expect(analysis.keyMetrics.maxAbsDisplacement * 1000).toBeCloseTo(0.1, 8);
    }
    await retainAttachment(info, 'beam-alternative-browser', await page.screenshot(), 'image/png');
    expect(errors).toEqual([]);
  });

  for (const locale of ['en', 'zh'] as const) {
    test(`${locale}: switches apply, stay disabled, and persist across reload`, async ({ page, request }, info) => {
      const zh = locale === 'zh';
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.context().addCookies([{ name: 'structureclaw.locale', value: locale, url: info.project.use.baseURL! }]);
      await page.addInitScript(value => localStorage.setItem('structureclaw.locale', value), locale);
      const skillsResponse = await request.get('/api/v1/agent/skills');
      expect(skillsResponse.ok()).toBe(true);
      const skillPayload = await skillsResponse.json();
      const skills = Array.isArray(skillPayload) ? skillPayload : skillPayload.skills;
      const matrixResponse = await request.get('/api/v1/agent/capability-matrix');
      expect(matrixResponse.ok()).toBe(true);
      const matrix = await matrixResponse.json();
      const label = (tool: { id: string; displayName?: Record<string, string> }) => tool.displayName?.[locale] ?? tool.id;
      const steel = skills.find((skill: { id: string }) => skill.id === 'code-check-gb50017');
      const concrete = skills.find((skill: { id: string }) => skill.id === 'code-check-gb50010');
      const calculate = matrix.tools.find((tool: { id: string }) => tool.id === 'calculate');
      expect(steel).toBeTruthy(); expect(concrete).toBeTruthy(); expect(calculate).toBeTruthy();

      await page.goto('/capabilities');
      for (const skill of [steel, concrete]) {
        const toggle = page.getByRole('button', { name: skill.name[locale], exact: true });
        await expect(toggle).toBeEnabled();
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      }
      for (const tool of matrix.tools) {
        const toggle = page.getByRole('button', { name: label(tool), exact: true }).and(page.locator('button[title]'));
        if (await toggle.getAttribute('aria-pressed') === 'true') await toggle.click();
      }
      await page.reload();
      await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('structureclaw.console.capabilities')!).toolIds)).toEqual([]);
      await page.goto('/');
      await openRunSettings(page, zh);
      const routing = page.getByRole('combobox', { name: zh ? '技能路由' : 'Skill routing', exact: true });
      await expect(routing.locator('option[value="skill:beam"]')).toHaveCount(1);
      for (const id of ['code-check-gb50017', 'code-check-gb50010', 'opensees-static', 'report-export-builtin', 'validation-structure-model']) {
        await expect(routing.locator(`option[value="skill:${id}"]`)).toHaveCount(0);
      }
      await page.getByRole('combobox', { name: zh ? '专业指导' : 'Professional guidance', exact: true }).selectOption('disabled');
      await page.getByRole('combobox', { name: zh ? '建模方式' : 'Model builder', exact: true }).selectOption('llm');
      await page.getByRole('combobox', { name: zh ? '失败后自动纠正' : 'Automatic correction after failure', exact: true }).selectOption('0');
      await page.getByRole('combobox', { name: zh ? '对话上下文' : 'Conversation context', exact: true }).selectOption('current-turn');
      await page.getByLabel(zh ? '工具调用上限' : 'Tool call limit', { exact: true }).fill('8');
      await page.getByRole('combobox', { name: zh ? '技能路由' : 'Skill routing', exact: true }).selectOption('skill:beam');
      await page.getByRole('combobox', { name: zh ? '记忆读取与写入范围' : 'Memory read and write scope', exact: true }).selectOption('');
      await page.getByLabel(zh ? '内部 LLM 调用上限' : 'Internal LLM call limit', { exact: true }).fill('4');
      const firstPrompt = `Switch ${locale} ${Date.now()}: reply exactly SWITCH_OFF. No tools are enabled.`;
      const first = await send(page, request, info, firstPrompt, zh, 'switches-off');
      expect(first.session.policy).toMatchObject({ knowledge: 'disabled', builder: 'llm', routing: { mode: 'fixed', skillId: 'beam' },
        repair: { enabled: false, maxRecoveriesPerTurn: 0 }, context: { history: 'current-turn', memoryScopes: [] },
        budgets: { maxToolCallsPerTurn: 8, maxLlmCallsPerTurn: 4 }, activeToolIds: [] });
      expect(first.session.policy.activeSkillIds).toEqual(expect.arrayContaining(['code-check-gb50017', 'code-check-gb50010']));
      expect(first.session.usage.toolCalls).toBe(0);
      expect(first.session.usage.llmCalls).toBeGreaterThan(0);

      await page.getByRole('button', { name: /skills · .*tools|技能 · .*工具/i }).click();
      const settings = page.getByRole('dialog');
      await expect(settings.getByRole('button', { name: label(calculate), exact: true }).and(page.locator('button[title]'))).toBeEnabled();
      await settings.getByRole('button', { name: label(calculate), exact: true }).and(page.locator('button[title]')).click();
      await settings.getByRole('button', { name: steel.name[locale], exact: true }).click();
      await page.keyboard.press('Escape');
      await openRunSettings(page, zh);
      await page.getByRole('combobox', { name: zh ? '专业指导' : 'Professional guidance', exact: true }).selectOption('enabled');
      await page.getByRole('combobox', { name: zh ? '建模方式' : 'Model builder', exact: true }).selectOption('auto');
      await page.getByRole('combobox', { name: zh ? '失败后自动纠正' : 'Automatic correction after failure', exact: true }).selectOption('2');
      await page.getByRole('combobox', { name: zh ? '对话上下文' : 'Conversation context', exact: true }).selectOption('full');
      await page.getByLabel(zh ? '工具调用上限' : 'Tool call limit', { exact: true }).fill('12');
      await page.getByRole('combobox', { name: zh ? '技能路由' : 'Skill routing', exact: true }).selectOption('auto');
      await page.getByRole('combobox', { name: zh ? '记忆读取与写入范围' : 'Memory read and write scope', exact: true }).selectOption('conversation');
      await page.getByLabel(zh ? '不申请 LLM 调用上限' : 'Do not request an LLM call limit', { exact: true }).check();
      const second = await send(page, request, info, zh ? '请调用 calculate 工具计算 2+3，再回复结果。' : 'Call calculate to evaluate 2+3, then reply with the result.', zh, 'switches-on');
      expect(second.id).toBe(first.id);
      expect(second.session.policy).toMatchObject({ knowledge: 'enabled', builder: 'auto', routing: { mode: 'auto' },
        repair: { enabled: true, maxRecoveriesPerTurn: 2 }, context: { history: 'full', memoryScopes: ['conversation'] },
        budgets: { maxToolCallsPerTurn: 12, maxLlmCallsPerTurn: null }, activeToolIds: ['calculate'] });
      expect(second.session.policy.activeSkillIds).not.toContain('code-check-gb50017');
      expect(second.session.usage.toolCalls).toBeGreaterThan(0);
      const conversation = await (await request.get(`/api/v1/chat/conversation/${first.id}`)).json();
      const tools = conversation.messages.filter((message: { role: string }) => message.role === 'tool');
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((message: { name: string }) => message.name === 'calculate')).toBe(true);

      await page.reload();
      await page.getByTestId('console-history-panel').getByRole('button').filter({ hasText: firstPrompt.slice(0, 25) }).click();
      await openRunSettings(page, zh);
      const third = await send(page, request, info, 'Reply exactly SWITCH_RESTORED without calling a tool.', zh, 'switches-restored');
      expect(third.id).toBe(first.id);
      expect(third.sent.context?.runPolicy).toBeUndefined();
      expect(third.sent.context?.skillIds).toBeUndefined();
      expect(third.sent.context?.enabledToolIds).toBeUndefined();
      expect(third.session.policy.policyHash).toBe(second.session.policy.policyHash);
      await retainAttachment(info, 'switches-browser', await page.screenshot(), 'image/png');
      expect(errors).toEqual([]);
    });
  }
});

async function openRunSettings(page: Page, zh: boolean) {
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${zh ? '运行设置' : 'Run settings'}$`) });
  if (await summary.evaluate(node => !(node.parentElement as HTMLDetailsElement).open)) await summary.click();
  const advanced = page.locator('summary').filter({ hasText: new RegExp(`^${zh ? '高级设置' : 'Advanced settings'}$`) });
  if (await advanced.evaluate(node => !(node.parentElement as HTMLDetailsElement).open)) await advanced.click();
}

async function send(page: Page, request: APIRequestContext, info: TestInfo, message: string, zh: boolean, name: string) {
  const response = page.waitForResponse(value => value.url().endsWith('/api/v1/chat/stream') && value.request().method() === 'POST');
  await page.getByRole('textbox').fill(message);
  await page.getByRole('button', { name: zh ? '发送' : 'Send', exact: true }).click();
  const stream = await response;
  expect(stream.status()).toBe(200);
  const sent = stream.request().postDataJSON();
  const id = sent.conversationId as string;
  await retainAttachment(info, `${name}-request`, JSON.stringify(sent, null, 2), 'application/json');
  expect(await stream.finished()).toBeNull();
  const events = (await stream.text()).split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
  await retainAttachment(info, `${name}-events`, JSON.stringify(events, null, 2), 'application/json');
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  await expect.poll(async () => (await (await request.get(`/api/v1/chat/conversation/${id}/session`)).json()).busy).toBe(false);
  const session = await (await request.get(`/api/v1/chat/conversation/${id}/session`)).json();
  expect(session.waitingForReply).toBe(false);
  await retainAttachment(info, name, JSON.stringify({ sent, session, events }, null, 2), 'application/json');
  return { id, sent, session };
}

async function retainAttachment(info: TestInfo, name: string, body: string | Buffer, contentType: string) {
  // Body-only attachments disappear with the line reporter; write evidence first.
  const output = info.outputPath(`${name}.${contentType === 'image/png' ? 'png' : 'json'}`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, body);
  await info.attach(name, { path: output, contentType });
}
