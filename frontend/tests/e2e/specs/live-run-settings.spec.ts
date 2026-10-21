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
    await page.getByLabel('Engineering guidance', { exact: true }).selectOption('disabled');
    await page.getByRole('combobox', { name: 'Model builder', exact: true }).selectOption('llm');
    await page.getByLabel('Recovery limit (0 disables recovery)', { exact: true }).fill('0');
    await page.getByRole('combobox', { name: 'Conversation context', exact: true }).selectOption('current-turn');
    await page.getByRole('spinbutton', { name: /^Tool call limit/ }).fill('24');
    await page.getByLabel('Structure skills', { exact: true }).selectOption('fixed');
    await page.getByLabel('Pinned skill', { exact: true }).selectOption('beam');
    await page.getByRole('combobox', { name: 'Memory read and write scopes', exact: true }).selectOption('');
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
    test(locale + ': conversation switches apply and persist without changing global defaults', async ({ page, request }, info) => {
      const zh = locale === 'zh';
      await page.context().addCookies([{ name: 'structureclaw.locale', value: locale, url: info.project.use.baseURL! }]);
      await page.addInitScript(value => localStorage.setItem('structureclaw.locale', value), locale);
      const defaults = await (await request.get('/api/v1/admin/settings')).json();
      await page.goto('/');
      await openRunSettings(page, zh);
      await page.getByLabel(zh ? '工程指导' : 'Engineering guidance', { exact: true }).selectOption('disabled');
      await page.getByLabel(zh ? '建模方式' : 'Model builder', { exact: true }).selectOption('llm');
      await page.getByLabel(zh ? '自动纠正次数（0 为关闭）' : 'Recovery limit (0 disables recovery)', { exact: true }).fill('0');
      await page.getByLabel(zh ? '对话上下文' : 'Conversation context', { exact: true }).selectOption('current-turn');
      await page.getByRole('spinbutton', { name: /^(Tool call limit|工具调用上限)/ }).fill('8');
      await page.getByLabel(zh ? '结构技能' : 'Structure skills', { exact: true }).selectOption('fixed');
      await page.getByLabel(zh ? '固定技能' : 'Pinned skill', { exact: true }).selectOption('beam');
      await page.getByLabel(zh ? '记忆读写范围' : 'Memory read and write scopes', { exact: true }).selectOption('');
      const firstPrompt = 'Switch ' + locale + ' ' + Date.now() + ': reply exactly SWITCH_OFF without calling tools.';
      const first = await send(page, request, info, firstPrompt, zh, 'switches-off');
      expect(first.session.policy).toMatchObject({ knowledge: 'disabled', builder: 'llm', routing: { mode: 'fixed', skillId: 'beam' },
        repair: { enabled: false, maxRecoveriesPerTurn: 0 }, context: { history: 'current-turn', memoryScopes: [] }, budgets: { maxToolCallsPerTurn: 8 } });
      expect(first.session.policy.activeToolIds).not.toContain('memory');
      expect(first.session.policy.activeSkillIds).not.toContain('code-check-gb50017');
      expect(first.session.usage.toolCalls).toBe(0);
      await openRunSettings(page, zh);
      await page.getByLabel(zh ? '工程指导' : 'Engineering guidance', { exact: true }).selectOption('enabled');
      await page.getByLabel(zh ? '建模方式' : 'Model builder', { exact: true }).selectOption('auto');
      await page.getByLabel(zh ? '自动纠正次数（0 为关闭）' : 'Recovery limit (0 disables recovery)', { exact: true }).fill('2');
      await page.getByLabel(zh ? '对话上下文' : 'Conversation context', { exact: true }).selectOption('full');
      await page.getByLabel(zh ? '结构技能' : 'Structure skills', { exact: true }).selectOption('auto');
      await page.getByLabel(zh ? '记忆读写范围' : 'Memory read and write scopes', { exact: true }).selectOption('conversation');
      const second = await send(page, request, info, zh ? '请调用 calculate 工具计算 2+3，再回复结果。' : 'Call calculate to evaluate 2+3, then reply with the result.', zh, 'switches-on');
      expect(second.id).toBe(first.id);
      expect(second.session.policy).toMatchObject({ knowledge: 'enabled', builder: 'auto', routing: { mode: 'auto' },
        repair: { enabled: true, maxRecoveriesPerTurn: 2 }, context: { history: 'full', memoryScopes: ['conversation'] } });
      expect(second.session.usage.toolCalls).toBeGreaterThan(0);
      const conversation = await (await request.get('/api/v1/chat/conversation/' + first.id)).json();
      expect(conversation.messages.some((message: { role: string; name: string }) => message.role === 'tool' && message.name === 'calculate')).toBe(true);
      await page.reload();
      await page.getByTestId('console-history-panel').getByRole('button').filter({ hasText: firstPrompt.slice(0, 25) }).click();
      await openRunSettings(page, zh);
      await expect(page.getByLabel(zh ? '工程指导' : 'Engineering guidance', { exact: true })).toHaveValue('enabled');
      const third = await send(page, request, info, 'Reply exactly SWITCH_RESTORED without calling a tool.', zh, 'switches-restored');
      expect(third.sent.context?.runPolicy).toBeUndefined();
      expect(third.sent.context?.skillIds).toBeUndefined();
      expect(third.session.policy.policyHash).toBe(second.session.policy.policyHash);
      expect((await (await request.get('/api/v1/admin/settings')).json()).agent.runPolicy).toEqual(defaults.agent.runPolicy);
      await retainAttachment(info, 'switches-browser', await page.screenshot(), 'image/png');
    });
  }
});

async function openRunSettings(page: Page, zh: boolean) {
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${zh ? '会话设置' : 'Conversation settings'}$`) });
  if (await summary.evaluate(node => !(node.parentElement as HTMLDetailsElement).open)) await summary.click();

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
