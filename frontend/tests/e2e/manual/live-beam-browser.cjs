#!/usr/bin/env node
// Independent live browser probe. No mocked transport/solver and no settings writes.
// From the repository: node frontend/tests/e2e/manual/live-beam-browser.cjs [--config=<path>] [--run]
// Without --run this only opens the UI, selects browser-local capabilities, and records readiness.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { validateModelExpectations, checkModelValues } = require('./model-value-checks.cjs');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node frontend/tests/e2e/manual/live-beam-browser.cjs [--config=<JSON path>] [--run] [--manual]\nWithout --run: prepare browser only. With --run: real model requests to a verified isolated instance.\nManual replies: create the pending reply-N.json with {"text":"reviewed reply"}; {"finish":true} ends the run.');
  process.exit(0);
}
const configPath = path.resolve(args.find(value => value.startsWith('--config='))?.slice(9) ?? path.join(__dirname, 'beam-design.example.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
validateModelExpectations(config.expectedModelValues);
const sutRoot = config.sutRoot ? path.resolve(path.dirname(configPath), config.sutRoot) : path.resolve(__dirname, '../../../..');
const requireSut = createRequire(path.join(sutRoot, 'frontend/package.json'));
const { chromium, expect } = requireSut('@playwright/test');
const baseURL = config.baseURL ?? 'http://127.0.0.1:31515';
const locale = config.locale ?? 'zh';
const timeLimit = config.turnTimeoutMs ?? 600000;
const out = path.resolve(sutRoot, config.outputDirectory ?? '.tmp/manual-live-beam', new Date().toISOString().replace(/[:.]/g, '-') + '-' + locale);
fs.mkdirSync(out, { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
const log = value => console.log(new Date().toISOString() + ' ' + JSON.stringify(value));
const errors = { console: [], page: [], network: [], http: [] };
const records = [];
let browser, context, page, conversationId, heartbeat;
let summary = { status: 'preparing', locale, baseURL, out, realModelRequested: args.includes('--run'), turns: records };
const safeURL = url => { try { const value = new URL(url); return value.origin + value.pathname; } catch { return url; } };
const streamURL = url => /\/api\/v1\/chat\/stream(?:\/resume)?$/.test(new URL(url).pathname);

async function getJSON(endpoint) {
  const response = await context.request.get(endpoint);
  if (!response.ok()) throw new Error(`GET ${endpoint}: HTTP ${response.status()}`);
  return response.json();
}

async function capture(label) {
  if (!conversationId) return null;
  const session = await getJSON(`/api/v1/chat/conversation/${conversationId}/session`);
  const conversation = await getJSON(`/api/v1/chat/conversation/${conversationId}`);
  const inputReview = await getJSON(`/api/v1/agent/input-review/${conversationId}`);
  const tools = (conversation.messages ?? []).filter(message => message.role === 'tool');
  save(`${label}-session.json`, session);
  save(`${label}-conversation.json`, conversation);
  save(`${label}-input-review.json`, inputReview);
  save(`${label}-tool-trace.json`, tools);
  if (session.analysis?.runId) save(`${label}-analysis-run.json`, await getJSON(`/runs/${session.analysis.runId}`));
  await page.screenshot({ path: path.join(out, `${label}.png`), fullPage: true });
  return { session, conversation, tools, inputReview };
}

async function chooseCapabilities() {
  await page.goto('/capabilities');
  const skills = (await getJSON('/api/v1/agent/skills')).skills;
  const tools = (await getJSON('/api/v1/agent/tools')).tools;
  const wantedSkills = config.skillIds ?? ['beam', 'generic', 'opensees-static', 'validation-structure-model', 'report-export-builtin', 'code-check-gb50017'];
  const wantedTools = config.toolIds ?? ['review_input', 'query_model', 'edit_model', 'undo_model', 'query_results', 'detect_structure_type', 'extract_draft_params', 'build_model', 'validate_model', 'run_analysis', 'run_code_check', 'generate_report', 'ask_user_clarification', 'set_session_config', 'calculate'];
  for (const [items, wanted, key] of [[skills, wantedSkills, 'skillIds'], [tools, wantedTools, 'toolIds']]) {
    for (const id of wanted) if (!items.some(item => (item.id ?? item.name) === id)) throw new Error(`Missing catalog ${key}: ${id}`);
    for (const item of items) {
      const id = item.id ?? item.name;
      const label = key === 'skillIds' ? (item.name[locale] || id) : (item.displayName?.[locale] || id);
      // Skill and tool labels can be identical (e.g. shell); tool chips alone have a title.
      const button = page.getByRole('button', { name: label, exact: true })
        .and(page.locator(key === 'skillIds' ? 'button:not([title])' : 'button[title]'));
      await expect(button).toBeEnabled({ timeout: 30000 });
      if ((await button.getAttribute('aria-pressed') === 'true') !== wanted.includes(id)) await button.click();
    }
  }
  const selected = await page.evaluate(() => JSON.parse(localStorage.getItem('structureclaw.console.capabilities') ?? '{}'));
  expect([...selected.skillIds].sort()).toEqual([...wantedSkills].sort());
  expect([...selected.toolIds].sort()).toEqual([...wantedTools].sort());
  save('capabilities.json', selected);
}

async function selectPolicy() {
  const policy = config.runPolicy;
  if (!policy) return;
  await page.locator('summary').filter({ hasText: /^(运行设置|Run settings)$/ }).click();
  for (const [field, label] of [['knowledge', /^(专业指导|Professional guidance)$/], ['builder', /^(建模方式|Model builder)$/]]) {
    if (policy[field] !== undefined) await page.getByRole('combobox', { name: label }).selectOption(policy[field]);
  }
  if (policy.repair) await page.getByRole('combobox', { name: /^(失败后自动纠正|Automatic correction after failure)$/ }).selectOption(policy.repair.enabled ? '2' : '0');
  if (policy.context?.history) await page.getByRole('combobox', { name: /^(对话上下文|Conversation context)$/ }).selectOption(policy.context.history);
  if (policy.budgets?.maxToolCallsPerTurn) await page.getByRole('spinbutton', { name: /^(工具调用上限|Tool call limit)$/ }).fill(String(policy.budgets.maxToolCallsPerTurn));
  if (policy.routing || policy.context?.memoryScopes) {
    await page.locator('summary').filter({ hasText: /^(高级设置|Advanced settings)$/ }).click();
    if (policy.routing) await page.getByRole('combobox', { name: /^(技能路由|Skill routing)$/ }).selectOption(policy.routing.mode === 'auto' ? 'auto' : `skill:${policy.routing.skillId}`);
    if (policy.context?.memoryScopes) await page.getByRole('combobox', { name: /^(记忆读取与写入范围|Memory read and write scope)$/ }).selectOption([...policy.context.memoryScopes].sort().join(','));
  }
}

async function sendTurn(text, number) {
  const label = `turn-${number}`;
  save(`${label}-input.json`, { text, suppliedBy: number === 1 ? (config.initialPromptSource ?? 'original-user-reproduction') : 'explicit-test-fixture-config' });
  const requestPromise = page.waitForRequest(request => request.method() === 'POST' && streamURL(request.url()), { timeout: 30000 });
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && streamURL(response.url()), { timeout: timeLimit });
  // The initial landing composer precedes the console-composer test ID.
  const composer = page.locator('textarea[placeholder]');
  await expect(composer).toBeEnabled({ timeout: 30000 });
  await composer.fill(text);
  await page.getByRole('button', { name: /^(发送|Send)$/ }).click();
  const request = await requestPromise;
  const payload = request.postDataJSON();
  conversationId = payload.conversationId || conversationId;
  summary.conversationId = conversationId;
  save(`${label}-request.json`, payload); // Body only; never save request headers or LLM credentials.
  save('summary.json', summary);
  log({ event: 'submitted', number, conversationId, endpoint: safeURL(request.url()) });
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`Chat HTTP ${response.status()}`);
  const finishError = await Promise.race([response.finished(), new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`TURN_TIMEOUT_${timeLimit}ms`)), timeLimit); timer.unref();
  })]);
  if (finishError) throw finishError;
  const body = await response.text();
  fs.writeFileSync(path.join(out, `${label}-stream.sse`), body);
  const events = body.split(/\r?\n/).filter(line => line.startsWith('data: ') && line.slice(6) !== '[DONE]').map(line => {
    try { return JSON.parse(line.slice(6)); } catch { return { unparsed: line.slice(6) }; }
  });
  conversationId ||= events.find(event => event.type === 'start')?.content?.conversationId;
  if (!conversationId) throw new Error('NO_CONVERSATION_ID');
  await expect.poll(async () => (await getJSON(`/api/v1/chat/conversation/${conversationId}/session`)).busy, { timeout: 30000 }).toBe(false);
  const captured = await capture(label);
  const toolErrors = captured.tools.filter(message => {
    if (/^Error:|RECOVERY_BUDGET_EXHAUSTED/.test(message.content ?? '')) return true;
    try { return JSON.parse(message.content).success === false; } catch { return false; }
  });
  const row = { number, conversationId, waitingForReply: captured.session.waitingForReply, question: captured.session.question,
    analysis: captured.session.analysis, report: captured.session.report, usage: captured.session.usage,
    streamErrors: events.filter(event => event.type === 'error'), toolErrorCount: toolErrors.length };
  records.push(row);
  save('summary.json', summary);
  log(row);
  if (number <= (config.designUnconfirmedThroughTurn ?? 0)) {
    const premature = ['materials', 'elements'].flatMap(collection => (captured.inputReview?.model?.[collection] ?? [])
      .filter(item => item.design && Object.keys(item.design).length > 0).map(item => ({ collection, id: item.id, design: item.design })));
    expect(premature, 'Design conditions must be explicitly confirmed before being written').toEqual([]);
  }
  return captured;
}

async function waitForReviewedReply(result, number) {
  const replyPath = path.join(out, `reply-${number}.json`);
  const pending = { conversationId, completedTurns: records.length, waitingForReply: result.session.waitingForReply,
    actualQuestion: result.session.question, analysis: result.session.analysis, report: result.session.report,
    replyPath, format: '{"text":"Explicitly reviewed next user message"} or {"finish":true}',
    note: 'No inferred clarification reply is sent. Inspect the saved session/tool trace, then create the reply file.' };
  save('pending-reply.json', pending);
  log({ event: 'awaiting-reviewed-reply', ...pending });
  const deadline = Date.now() + (config.manualReplyTimeoutMs ?? 7200000);
  while (Date.now() < deadline) {
    if (fs.existsSync(replyPath)) {
      let reply;
      try { reply = JSON.parse(fs.readFileSync(replyPath, 'utf8').replace(/^\uFEFF/, '')); }
      catch { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
      if (reply.finish === true || reply.stop === true) return null;
      if (typeof reply.text !== 'string' || !reply.text.trim()) throw new Error(`Reviewed reply must contain nonempty text: ${replyPath}`);
      save(`reviewed-reply-${number}.json`, { ...reply, consumedAt: new Date().toISOString() });
      return reply.text;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('MANUAL_REPLY_TIMEOUT: saved state retained; no additional model call was made.');
}

(async () => {
  log({ event: 'evidence-directory', out, manual: args.includes('--manual') || config.manual === true });
  browser = await chromium.launch({ headless: config.headless !== false });
  context = await browser.newContext({ baseURL, viewport: { width: 1600, height: 1100 }, locale: locale === 'zh' ? 'zh-CN' : 'en-US' });
  await context.addCookies([{ name: 'structureclaw.locale', value: locale, url: baseURL }]);
  await context.addInitScript(value => localStorage.setItem('structureclaw.locale', value), locale);
  // Preflight reads only, and saves only the non-secret model identity.
  const server = new URL(baseURL);
  if (server.hostname !== '127.0.0.1' || ['31415', '31416'].includes(server.port)) throw new Error('MANUAL_LIVE_REQUIRES_ISOLATED_INSTANCE');
  const receipt = JSON.parse(fs.readFileSync(path.join(sutRoot, '.tmp', `playwright-server-${server.port}.json`), 'utf8'));
  const relative = path.relative(path.join(sutRoot, '.tmp'), receipt.dataDir);
  if (!relative.startsWith('playwright-') || relative.includes('..') || path.isAbsolute(relative)
    || receipt.baseURL !== baseURL || !receipt.instanceId.startsWith('playwright-')) throw new Error('ISOLATION_RECEIPT_INVALID');
  const health = await getJSON('/health');
  const database = await getJSON('/api/v1/admin/database/status');
  if (health.instanceId !== receipt.instanceId || !health.services?.database
    || path.resolve(database.database?.databasePath ?? '') !== path.resolve(receipt.databasePath)
    || path.resolve(receipt.databasePath) !== path.resolve(receipt.dataDir, 'data/structureclaw.db')) throw new Error('ISOLATION_SERVER_MISMATCH');
  summary.isolatedDataDir = receipt.dataDir;
  const llm = await getJSON('/api/v1/admin/llm');
  summary.instanceId = health.instanceId;
  summary.providerModel = llm.model;
  if (/^e2e-(scripted|unconfigured)$/.test(llm.model ?? '')) throw new Error('REFUSE_SCRIPTED_OR_UNCONFIGURED_PROVIDER');
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') errors.console.push({ text: message.text(), at: new Date().toISOString() }); });
  page.on('pageerror', error => errors.page.push({ message: error.message, at: new Date().toISOString() }));
  page.on('requestfailed', request => errors.network.push({ url: safeURL(request.url()), error: request.failure()?.errorText, at: new Date().toISOString() }));
  page.on('response', response => { if (response.status() >= 400) errors.http.push({ url: safeURL(response.url()), status: response.status(), at: new Date().toISOString() }); });
  heartbeat = setInterval(() => { save('browser-errors.json', errors); log({ event: 'alive', conversationId, completedTurns: records.length }); }, 30000);
  heartbeat.unref();
  await chooseCapabilities();
  await page.goto('/');
  if (config.resumeConversationId) {
    const saved = await getJSON(`/api/v1/chat/conversation/${config.resumeConversationId}`);
    const session = await getJSON(`/api/v1/chat/conversation/${config.resumeConversationId}/session`);
    if (session.busy) throw new Error('REFUSE_BUSY_CONVERSATION');
    // The landing-page suggested prompt may have exactly the conversation title.
    const button = page.locator('button.min-w-0').filter({ has: page.getByText(saved.title, { exact: true }) });
    await expect(button).toHaveCount(1);
    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/chat/conversation/${config.resumeConversationId}` && response.ok());
    await button.click();
    await loaded;
    conversationId = config.resumeConversationId;
    summary.resumedConversationId = conversationId;
    await capture('before-resume');
  } else {
    const newButtons = page.getByRole('button', { name: /^(新建对话|New Conversation)$/ });
    for (let i = 0; i < await newButtons.count(); i++) if (await newButtons.nth(i).isVisible()) { await newButtons.nth(i).click(); break; }
  }
  await selectPolicy();
  await expect(page.locator('textarea[placeholder]')).toBeEnabled({ timeout: 30000 });
  await page.screenshot({ path: path.join(out, 'ready.png'), fullPage: true });
  if (!args.includes('--run')) {
    summary.status = 'browser-ready-no-model-call';
    return;
  }
  let result = await sendTurn(config.initialPrompt ?? '设计一个简支梁，跨度10m，梁中间荷载1kN', 1);
  if (args.includes('--manual') || config.manual === true) {
    for (let number = 2; number <= (config.maxUserTurns ?? 8); number++) {
      const text = await waitForReviewedReply(result, number);
      if (text === null) break;
      result = await sendTurn(text, number);
    }
  } else {
    for (const [index, answer] of (config.clarificationAnswers ?? []).entries()) {
      if (!result.session.waitingForReply) break;
      result = await sendTurn(answer, index + 2);
    }
  }
  const checks = result.tools.filter(message => message.name === 'run_code_check').map(message => { try { return JSON.parse(message.content); } catch { return null; } }).filter(Boolean);
  const lastCheck = checks.at(-1);
  const analysisTools = result.tools.filter(message => message.name === 'run_analysis').map(message => { try { return JSON.parse(message.content); } catch { return null; } }).filter(Boolean);
  const metricChecks = analysisTools.flatMap((value, analysisIndex) => Object.entries(config.expectedAnalysis?.metrics ?? {}).map(([key, expected]) => ({
    analysisIndex, key, expected, actual: value.keyMetrics?.[key],
    pass: Number.isFinite(value.keyMetrics?.[key]) && Math.abs(value.keyMetrics[key] - expected) <= (config.expectedAnalysis.absoluteTolerance ?? 1e-8),
  })));
  const modelValueChecks = checkModelValues(result.inputReview?.model, config.expectedModelValues);
  const pass = !result.session.waitingForReply && result.session.analysis?.current === true && result.session.report?.current === true
    && result.session.report.runId === result.session.analysis.runId
    && (!config.requireCodeCheck || (lastCheck?.completionStatus === 'complete' && lastCheck?.complianceStatus === 'pass' && lastCheck?.conclusionEligible === true))
    && analysisTools.length > 0 && analysisTools.every(value => value.success === true) && metricChecks.every(row => row.pass)
    && modelValueChecks.every(row => row.pass)
    && records.every(row => row.toolErrorCount === 0 && row.streamErrors.length === 0)
    && errors.page.length === 0 && errors.console.length === 0 && errors.http.length === 0 && errors.network.length === 0;
  summary.status = pass ? 'live-product-workflow-passed' : 'live-product-workflow-incomplete-or-failed';
  summary.pass = pass;
  summary.modelValueChecks = modelValueChecks;
  summary.finalCheck = lastCheck && { completionStatus: lastCheck.completionStatus, complianceStatus: lastCheck.complianceStatus, conclusionEligible: lastCheck.conclusionEligible, missingInputs: lastCheck.missingInputs, summary: lastCheck.summary };
  summary.analysisToolResults = analysisTools;
  summary.independentMetricChecks = metricChecks;
  summary.finalPolicy = result.session.policy;
  summary.remainingQuestion = result.session.question;
  if (!pass) process.exitCode = 1;
})().catch(async error => {
  summary.status = 'probe-error';
  summary.pass = false;
  summary.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  if (page) { try { await capture('failure'); await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); } catch (captureError) { summary.captureError = captureError.message; } }
}).finally(async () => {
  clearInterval(heartbeat);
  save('browser-errors.json', errors);
  save('summary.json', summary);
  if (context) { try { await context.tracing.stop({ path: path.join(out, 'trace.zip') }); } catch {} }
  if (browser) await browser.close();
  log(summary);
});
