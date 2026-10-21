import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beamModel } from '../fixtures/engineering-beam';
import { startLlmFixture, configureFixtureLlm, toolCall, type LlmFixture } from '../fixtures/llm-server';

// Only LLM HTTP responses are scripted. UI requests, LangGraph execution,
// tool permissions, memory, model state and durable run ledgers are real.
for (const locale of ['en', 'zh'] as const) {
  test.describe(`Run controls through the product (${locale})`, () => {
    let llm: LlmFixture;
    let title: string;
    test.beforeEach(async ({ page, request, baseURL }) => {
      title = `E2E-${locale}-${randomUUID()}`;
      llm = await startLlmFixture();
      await configureFixtureLlm(request, llm);
      await page.context().addCookies([{ name: 'structureclaw.locale', value: locale, url: baseURL! }]);
      await page.addInitScript(value => localStorage.setItem('structureclaw.locale', value), locale);
      await page.goto('/');
      await page.getByRole('button', { name: /^(New Conversation|新建对话)$/ }).click();
    });
    test.afterEach(async () => {
      await llm?.close();
      expect(llm.failures).toEqual([]);
      expect(llm.pending()).toBe(0);
    });

    test('changed controls persist and actually alter guidance, history and memory permission', async ({ page, request }) => {
      llm.enqueue(toolCall('memory', { action: 'store', key: 'report_style', value: 'compact-e2e', scope: 'conversation' }),
        toolCall('calculate', { expression: '6 * 7' }), 'PRIOR_ANSWER_SENTINEL');
      const first = await send(page, `${title} PRIOR_DIALOGUE_SENTINEL`);
      const initial = await runtime(request, first.id);
      expect(initial.usage).toMatchObject({ toolCalls: 2, recoveries: 0 });
      expect(llm.requests[0].tools?.map(tool => tool.function.name)).toContain('memory');
      const initialSystem = llm.requests[0].messages[0].content ?? '';
      const beamGuidance = initialSystem.split('\n').find(line => line.startsWith('- beam ('));
      expect(beamGuidance).toBeTruthy();
      expect(llm.requests[2].messages.filter(message => message.role === 'tool').map(message => message.content).join(' ')).toContain('42');

      await settings(page);
      await page.getByRole('combobox', { name: /^(Engineering guidance|工程指导)$/ }).selectOption('disabled');
      await page.getByRole('combobox', { name: /^(Model builder|建模方式)$/ }).selectOption('llm');
      await page.getByRole('spinbutton', { name: /^(Recovery limit \(0 disables recovery\)|自动纠正次数（0 为关闭）)$/ }).fill('0');
      await page.getByRole('combobox', { name: /^(Conversation context|对话上下文)$/ }).selectOption('current-turn');
      await page.getByRole('spinbutton', { name: /^(Tool call limit|工具调用上限)$/ }).fill('8');
      await page.getByRole('combobox', { name: /^(Memory read and write scopes|记忆读写范围)$/ }).selectOption('');
      // Deliberately request a forbidden tool: a scripted model cannot bypass the server policy.
      llm.enqueue(toolCall('memory', { action: 'retrieve', key: 'report_style' }), 'CURRENT_ANSWER_SENTINEL');
      const changed = await send(page, 'CURRENT_DIALOGUE_SENTINEL');
      expect(changed.request.context.runPolicy).toMatchObject({ knowledge: 'disabled', builder: 'llm',
        repair: { enabled: false, maxRecoveriesPerTurn: 0 }, context: { history: 'current-turn', memoryScopes: [] } });
      const off = await runtime(request, first.id);
      expect(off.policy).toMatchObject({ knowledge: 'disabled', builder: 'llm', repair: { enabled: false, maxRecoveriesPerTurn: 0 },
        context: { history: 'current-turn', memoryScopes: [] }, budgets: { maxToolCallsPerTurn: 8 } });
      expect(off.policy.activeToolIds).not.toContain('memory');
      expect(off.usage.toolCalls).toBe(0);
      const offRequest = llm.requests[3];
      expect(JSON.stringify(offRequest.messages)).not.toContain('PRIOR_DIALOGUE_SENTINEL');
      expect(offRequest.messages[0].content).not.toContain(beamGuidance);
      expect(offRequest.tools?.map(tool => tool.function.name)).toContain('calculate');
      expect(offRequest.tools?.map(tool => tool.function.name)).not.toContain('memory');
      const deniedMemory = JSON.parse(llm.requests[4].messages.find(message => message.role === 'tool')!.content!);
      expect(deniedMemory).toMatchObject({ success: false, errorCode: 'UNKNOWN_TOOL', guard: 'unknown-tool' });
      expect(deniedMemory.availableTools).not.toContain('memory');

      await reopen(page, title, first.id);
      await settings(page);
      // Controls request overrides for the next turn; reopening leaves them at
      // "inherit" and displays the actual saved values in the server summary.
      await expect(page.getByRole('combobox', { name: /^(Engineering guidance|工程指导)$/ })).toHaveValue('disabled');
      expect((await runtime(request, first.id)).policy.policyHash).toBe(off.policy.policyHash);
      llm.enqueue('INHERITED_ANSWER_SENTINEL');
      await send(page, 'INHERITED_DIALOGUE_SENTINEL');
      const inherited = await runtime(request, first.id);
      expect(inherited.policy.policyHash).toBe(off.policy.policyHash);
      expect(inherited.policy.fieldSources.knowledge).toBe('session');
      expect(JSON.stringify(llm.requests.at(-1)?.messages)).not.toContain('CURRENT_DIALOGUE_SENTINEL');

      await settings(page);
      await page.getByRole('combobox', { name: /^(Engineering guidance|工程指导)$/ }).selectOption('enabled');
      await page.getByRole('combobox', { name: /^(Conversation context|对话上下文)$/ }).selectOption('full');
      await page.getByRole('combobox', { name: /^(Memory read and write scopes|记忆读写范围)$/ }).selectOption('conversation');
      llm.enqueue(toolCall('memory', { action: 'retrieve', key: 'report_style' }), 'RESTORED_ANSWER_SENTINEL');
      await send(page, 'RESTORED_DIALOGUE_SENTINEL');
      const restoredRequest = llm.requests.at(-2)!;
      expect(JSON.stringify(restoredRequest.messages)).toContain('PRIOR_DIALOGUE_SENTINEL');
      expect(restoredRequest.messages[0].content).toContain(beamGuidance);
      expect(restoredRequest.tools?.map(tool => tool.function.name)).toContain('memory');
      expect(JSON.stringify(llm.requests.at(-1)?.messages)).toContain('compact-e2e');
    });

    test('clarification survives refresh and resumes the same policy and budget', async ({ page, request }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await settings(page);
      await page.getByRole('spinbutton', { name: /^(Tool call limit|工具调用上限)$/ }).fill('4');
      llm.enqueue(toolCall('ask_user_clarification', { question: 'Choose a value / 请选择数值',
        optionsJson: JSON.stringify([{ label: 'Use 7 / 采用 7', value: '7' }]) }));
      const started = await send(page, `${title} Clarification fixture`);
      const waiting = await runtime(request, started.id);
      expect(waiting).toMatchObject({ waitingForReply: true, busy: false, usage: { toolCalls: 1, llmCalls: 1, recoveries: 0 } });
      await expect(page.getByTestId('pending-clarification')).toBeVisible();
      await reopen(page, title, started.id);
      await expect(page.getByTestId('pending-clarification')).toContainText('Choose a value');
      await settings(page);
      await expect(page.getByRole('spinbutton', { name: /^(Tool call limit|工具调用上限)$/ })).toBeDisabled();
      expect((await runtime(request, started.id)).usage).toEqual(waiting.usage);
      llm.enqueue(toolCall('calculate', { expression: '6 * 7' }), 'RESUME_DONE_42');
      const resumed = await send(page, '7', 'stream/resume');
      expect(resumed.request.conversationId).toBe(started.id);
      expect(resumed.request.context?.runPolicy).toBeUndefined();
      const done = await runtime(request, started.id);
      expect(done.waitingForReply).toBe(false);
      expect(done.policy.policyHash).toBe(waiting.policy.policyHash);
      expect(done.usage).toMatchObject({ runId: waiting.usage.runId, toolCalls: 2, llmCalls: 3, recoveries: 0 });
      expect(JSON.stringify(llm.requests.at(-1)?.messages)).toContain('42');
      await reopen(page, title, started.id);
      await expect(page.getByTestId('pending-clarification')).toHaveCount(0);
      expect((await runtime(request, started.id)).usage).toEqual(done.usage);
      expect(pageErrors).toEqual([]);
    });

    test('repair off blocks cross-tool model edits; ending a turn preserves ledger and model', async ({ page, request, baseURL }) => {
      await page.getByRole('button', { name: /^(Context|工程上下文)$/ }).click();
      await page.getByPlaceholder(/Paste StructureModel v2 JSON here|将 StructureModel v2 JSON 粘贴/).fill(JSON.stringify(beamModel));
      await page.keyboard.press('Escape');
      await settings(page);
      await page.getByRole('spinbutton', { name: /^(Recovery limit \(0 disables recovery\)|自动纠正次数（0 为关闭）)$/ }).fill('0');
      llm.enqueue(toolCall('query_results', { field: 'displacements', nodeId: 'A', component: 'uz', unit: 'mm' }),
        toolCall('edit_model', { baseRevision: 1, edits: [{ operation: 'update', collection: 'nodes', id: 'B', values: { x: 12 } }] }),
        toolCall('query_model', {}), toolCall('ask_user_clarification', { question: 'End this failed turn explicitly / 请结束本轮' }));
      const started = await send(page, `${title} Repair-disabled fixture`);
      const waiting = await runtime(request, started.id);
      expect(waiting).toMatchObject({ waitingForReply: true, usage: { toolCalls: 3, llmCalls: 4, recoveries: 0 } });
      expect(JSON.stringify(llm.requests.at(-1)?.messages)).toContain('RECOVERY_BUDGET_EXHAUSTED');
      const inputUrl = `/api/v1/agent/input-review/${started.id}`;
      const original = await (await request.get(inputUrl)).json();
      expect(original.model.nodes.find((node: { id: string }) => node.id === 'B').x).toBe(10);
      const receipt = JSON.parse(await readFile(new URL(`../../../../.tmp/playwright-server-${new URL(baseURL!).port}.json`, import.meta.url), 'utf8'));
      const ledgerPath = path.join(receipt.dataDir, 'run-records', `${waiting.usage.runId}.json`);
      const ledger = await readFile(ledgerPath, 'utf8');
      const calls = llm.requests.length;
      await reopen(page, title, started.id);
      await expect(page.getByTestId('pending-clarification')).toBeVisible();
      const endedResponse = page.waitForResponse(response => response.url().endsWith(`/conversation/${started.id}/turn/end`));
      await page.getByRole('button', { name: /^(End turn|结束本轮)$/ }).click();
      const ended = await endedResponse;
      expect(ended.request().postDataJSON()).toEqual({ expectedRunId: waiting.usage.runId });
      expect(ended.ok()).toBe(true);
      await expect(page.getByTestId('pending-clarification')).toHaveCount(0);
      const after = await runtime(request, started.id);
      expect(after.waitingForReply).toBe(false);
      expect(after.usage).toEqual(waiting.usage);
      expect(await readFile(ledgerPath, 'utf8')).toBe(ledger);
      expect(llm.requests).toHaveLength(calls);
      expect((await (await request.get(inputUrl)).json()).model).toEqual(original.model);
      await reopen(page, title, started.id);
      await expect(page.getByTestId('pending-clarification')).toHaveCount(0);
      llm.enqueue(toolCall('calculate', { expression: '6 * 7' }), 'FRESH_TURN_DONE_42');
      await send(page, 'Calculate on a new user turn');
      const fresh = await runtime(request, started.id);
      expect(fresh.usage.runId).not.toBe(waiting.usage.runId);
      expect(fresh.usage).toMatchObject({ toolCalls: 1, llmCalls: 2, recoveries: 0 });
      expect(fresh.policy.policyHash).toBe(waiting.policy.policyHash);
      expect((await (await request.get(inputUrl)).json()).model).toEqual(original.model);
      expect(await readFile(ledgerPath, 'utf8')).toBe(ledger);
    });

    test('a batched model response cannot exceed the tool limit selected in the UI', async ({ page, request, baseURL }) => {
      await settings(page);
      await page.getByRole('spinbutton', { name: /^(Tool call limit|工具调用上限)$/ }).fill('1');
      await page.getByRole('combobox', { name: /^(Structure skills|结构技能)$/ }).selectOption('fixed');
      await page.getByRole('combobox', { name: /^(Pinned skill|固定技能)$/ }).selectOption('beam');
      llm.enqueue({ content: '', tool_calls: [
        ...toolCall('calculate', { expression: '6 * 7' }).tool_calls!,
        ...toolCall('calculate', { expression: '999' }).tool_calls!,
      ] });
      const started = await send(page, `${title} Tool ceiling fixture`);
      const completed = await runtime(request, started.id);
      expect(completed.policy).toMatchObject({ budgets: { maxToolCallsPerTurn: 1 }, routing: { mode: 'fixed', skillId: 'beam' } });
      expect(completed.usage).toMatchObject({ toolCalls: 1, llmCalls: 1, recoveries: 0 });
      expect(llm.requests).toHaveLength(1);
      const receipt = JSON.parse(await readFile(new URL(`../../../../.tmp/playwright-server-${new URL(baseURL!).port}.json`, import.meta.url), 'utf8'));
      const record = JSON.parse(await readFile(path.join(receipt.dataDir, 'run-records', `${completed.usage.runId}.json`), 'utf8'));
      expect(record.usage.events.filter((event: { kind: string }) => event.kind === 'tool_started')).toEqual([
        expect.objectContaining({ name: 'calculate' }),
      ]);
      const persisted = await (await request.get(`/api/v1/chat/conversation/${started.id}`)).json();
      expect(JSON.stringify(persisted.messages)).toContain('TOOL_CALL_BUDGET_EXHAUSTED');
      await reopen(page, title, started.id);
      expect((await runtime(request, started.id)).usage).toEqual(completed.usage);
    });
  });
}

async function settings(page: Page) {
  const summary = page.locator('summary').filter({ hasText: /^(Conversation settings|会话设置)$/ });
  if (!(await summary.locator('..').evaluate(element => element.hasAttribute('open')))) await summary.click();
}

async function runtime(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/v1/chat/conversation/${id}/session`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function send(page: Page, message: string, endpoint = 'stream') {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/chat/${endpoint}`);
  await page.locator('textarea[placeholder]').fill(message);
  await page.getByRole('button', { name: /^(Send|发送)$/ }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => {
    try { return JSON.parse(line.slice(6)); } catch { return null; }
  }).filter(Boolean);
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  const body = response.request().postDataJSON();
  const id = events.find(event => event.type === 'start')?.content?.conversationId ?? body.conversationId;
  expect(typeof id).toBe('string');
  await expect(page.locator('[data-testid="console-composer"] textarea')).toBeEnabled();
  return { id, request: body, events };
}

async function reopen(page: Page, title: string, conversationId: string) {
  await page.reload();
  const item = page.getByTestId('console-history-panel').getByRole('button', { name: new RegExp(`^${title} `) });
  await expect(item).toHaveCount(1);
  // Check the actual browser requests, not a separate API read of the intended
  // conversation: a same-title selection or a failed refresh must fail here.
  const detailResponse = page.waitForResponse(response => response.request().method() === 'GET'
    && /^\/api\/v1\/chat\/conversation\/[^/]+$/.test(new URL(response.url()).pathname));
  const runtimeResponse = page.waitForResponse(response => response.request().method() === 'GET'
    && /^\/api\/v1\/chat\/conversation\/[^/]+\/session$/.test(new URL(response.url()).pathname));
  await item.click();
  const detail = await detailResponse;
  expect(new URL(detail.url()).pathname).toBe(`/api/v1/chat/conversation/${conversationId}`);
  expect(detail.status()).toBe(200);
  expect((await detail.json()).id).toBe(conversationId);
  const snapshot = await runtimeResponse;
  expect(new URL(snapshot.url()).pathname).toBe(`/api/v1/chat/conversation/${conversationId}/session`);
  expect(snapshot.status()).toBe(200);
  expect((await snapshot.json()).conversationId).toBe(conversationId);
  await expect(page.getByRole('button', { name: /^(Inputs and evidence|输入与证据)$/ })).toBeEnabled();
}
