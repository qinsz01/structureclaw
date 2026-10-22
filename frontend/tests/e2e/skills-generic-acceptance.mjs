// Real frontend and real provider acceptance. Never uses response mocks or personal data directories.
// LLM_API_KEY is required in the parent environment and is never written to settings or evidence.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const phase = process.env.SCLAW_ACCEPTANCE_PHASE ?? 'phase1';
const evidence = path.resolve(process.env.SCLAW_ACCEPTANCE_OUT ?? path.join(repository, '.tmp', `${phase}-live-evidence`));
if (!process.env.LLM_API_KEY) throw new Error('LLM_API_KEY_REQUIRED');
fs.mkdirSync(evidence, { recursive: true });
const source = JSON.parse(fs.readFileSync(process.env.SCLAW_LIVE_SOURCE_SETTINGS
  ?? path.resolve(repository, '../sclaw_data/settings.json'), 'utf8').replace(/^\uFEFF/, ''));
const temporaryRoot = path.join(repository, '.tmp');
fs.mkdirSync(temporaryRoot, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(temporaryRoot, `playwright-${phase}-live-`));
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
});
if ([3000, 31415, 31416].includes(port)) throw new Error('LIVE_PORT_NOT_ISOLATED');
const databasePath = path.join(dataDir, 'data/structureclaw.db');
const databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
const pythonSuffix = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const pythonBin = [source.analysis?.pythonBin, path.resolve(repository, '../sclaw_data', pythonSuffix),
  path.join(os.homedir(), '.structureclaw', pythonSuffix)].find(value => value && fs.existsSync(value));
if (!pythonBin) throw new Error('ANALYSIS_PYTHON_REQUIRED');
const frontendDir = path.join(dataDir, 'frontend');
fs.cpSync(path.join(repository, 'frontend/out'), frontendDir, { recursive: true });
const settings = {
  server: { port, host: '127.0.0.1', frontendPort: port }, database: { url: databaseUrl },
  llm: { baseUrl: source.llm?.baseUrl ?? process.env.LLM_BASE_URL, model: source.llm?.model ?? process.env.LLM_MODEL,
    timeoutMs: 180000, maxRetries: 0 },
  analysis: { ...source.analysis, pythonBin },
  agent: { workspaceRoot: dataDir, checkpointDir: path.join(dataDir, 'checkpoints'), allowShell: false },
  storage: { reportsDir: path.join(dataDir, 'reports') },
  pkpm: { ...source.pkpm, workDir: path.join(dataDir, 'pkpm') },
  yjk: { ...source.yjk, workDir: path.join(dataDir, 'yjk') },
  logging: { level: 'info', llmLogEnabled: false },
};
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));
const env = { ...process.env, SCLAW_DATA_DIR: dataDir, DATABASE_URL: databaseUrl, PORT: String(port),
  SCLAW_FRONTEND_DIR: frontendDir, SCLAW_INSTANCE_ID: `playwright-${phase}-live`, NODE_ENV: 'test' };
delete env.SCLAW_RUN_PROFILE;
const databaseInit = spawnSync(process.execPath, [path.join(repository, 'backend/scripts/sync-sqlite-schema.mjs')],
  { cwd: path.join(repository, 'backend'), env, encoding: 'utf8', windowsHide: true });
fs.writeFileSync(path.join(evidence, 'database-init.log'), databaseInit.stdout + databaseInit.stderr);
if (databaseInit.status !== 0) throw new Error('LIVE_DATABASE_INIT_FAILED');
const log = fs.openSync(path.join(evidence, 'server.log'), 'a');
const server = spawn(process.execPath, [path.join(repository, 'backend/dist/index.js')],
  { cwd: repository, env, stdio: ['ignore', log, log], windowsHide: true });
const baseURL = `http://127.0.0.1:${port}`;
const receipt = { phase, baseURL, dataDir, databasePath, frontendDir, pid: server.pid, startedAt: new Date().toISOString(),
  model: settings.llm.model, baseUrl: settings.llm.baseUrl, keySource: 'environment only' };
fs.writeFileSync(path.join(evidence, 'instance.json'), JSON.stringify(receipt, null, 2));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function json(url) { const response = await fetch(baseURL + url); if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`); return response.json(); }
let browser;
const summaries = [];
try {
  for (let attempt = 0; ; attempt++) {
    try { await json('/health'); break; } catch { if (attempt >= 120 || server.exitCode !== null) throw new Error('LIVE_SERVER_START_FAILED'); await pause(500); }
  }
  fs.writeFileSync(path.join(evidence, 'providers.json'), JSON.stringify(await json('/api/v1/agent/providers'), null, 2));
  browser = await chromium.launch({ headless: true });
  const cases = phase === 'phase1' ? phaseOneCases() : [...genericCases(), ...phaseOneCases()];
  const requested = process.env.SCLAW_ACCEPTANCE_CASES?.split(',');
  async function runScenario(scenario) {
    const directory = path.join(evidence, scenario.id);
    fs.mkdirSync(directory, { recursive: true });
    const context = await browser.newContext({ baseURL, locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'structureclaw.locale', value: 'zh', url: baseURL }]);
    await context.addInitScript(() => localStorage.setItem('structureclaw.locale', 'zh'));
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    let conversationId;
    let session;
    let conversation;
    let failure;
    const captureWarnings = [];
    let turns = 0;
    const start = Date.now();
    try {
      await page.goto('/');
      if (scenario.generic) {
        const scope = page.locator('summary').filter({ hasText: /^会话设置$/ });
        await scope.click();
        await page.getByLabel('结构技能', { exact: true }).selectOption('restricted');
        for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.uncheck();
        await page.getByLabel('通用结构类型', { exact: true }).check();
        if (scenario.builder) await page.getByLabel('建模方式', { exact: true }).selectOption(scenario.builder);
        await scope.click();
      }
      for (const prompt of [scenario.prompt, ...(scenario.followups ?? [])]) {
        if (turns && !session?.waitingForReply) break;
        const responsePromise = page.waitForResponse(response => /\/api\/v1\/chat\/stream(?:\/resume)?$/.test(response.url())
          && response.request().method() === 'POST', { timeout: 600000 });
        await page.getByRole('textbox').fill(prompt);
        await page.getByRole('button', { name: '发送', exact: true }).click();
        turns++;
        const response = await responsePromise;
        conversationId = response.request().postDataJSON().conversationId ?? conversationId;
        let streamTimer;
        try {
          await Promise.race([response.finished(), new Promise((_, reject) => {
            streamTimer = setTimeout(() => reject(new Error('LIVE_STREAM_TIMEOUT: response exceeded 600 seconds')), 600000);
          })]);
        } finally { clearTimeout(streamTimer); }
        let stream = '';
        try { stream = await response.text(); } catch (error) { captureWarnings.push(String(error)); }
        fs.writeFileSync(path.join(directory, `turn-${turns}.sse`), stream);
        if (!conversationId) {
          for (const line of stream.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))) {
            const event = JSON.parse(line.slice(6));
            conversationId ??= event.content?.conversationId;
          }
        }
        session = await json(`/api/v1/chat/conversation/${conversationId}/session`);
        for (let attempt = 0; session.busy && attempt < 120; attempt++) {
          await pause(500);
          session = await json(`/api/v1/chat/conversation/${conversationId}/session`);
        }
        conversation = await json(`/api/v1/chat/conversation/${conversationId}`);
        fs.writeFileSync(path.join(directory, `turn-${turns}.json`), JSON.stringify({ prompt, session, conversation }, null, 2));
        console.log(JSON.stringify({ case: scenario.id, turn: turns, analysis: session.analysis?.current,
          waiting: session.waitingForReply, tools: session.usage?.toolCalls, seconds: (Date.now() - start) / 1000 }));
      }
    } catch (error) {
      failure = String(error);
      // Unload this test page to cancel its SSE request and the owned provider call.
      if (failure.includes('LIVE_STREAM_TIMEOUT')) await page.goto('about:blank').catch(() => {});
    }
    try {
      if (conversationId) {
        session = await json(`/api/v1/chat/conversation/${conversationId}/session`);
        conversation = await json(`/api/v1/chat/conversation/${conversationId}`);
      }
      await page.screenshot({ path: path.join(directory, 'browser.png'), fullPage: true });
    } catch (error) { failure ??= String(error); }
    const tools = conversation?.messages?.filter(message => message.role === 'tool') ?? [];
    const questionAttempts = (conversation?.messages ?? []).flatMap(message => message.toolCalls ?? [])
      .filter(call => call.name === 'ask_user_clarification');
    const refused = new Set(tools.filter(message => message.name === 'ask_user_clarification'
      && (/^Error:/.test(message.content) || parse(message.content)?.success === false)).map(message => message.toolCallId));
    const questions = questionAttempts.filter(call => !refused.has(call.id));
    let run;
    const uiSkillUsage = await page.getByTestId('run-used-skills').innerText().catch(() => '');
    if (session?.usage?.runId) {
      const ledger = path.join(dataDir, 'run-records', `${session.usage.runId}.json`);
      if (fs.existsSync(ledger)) fs.copyFileSync(ledger, path.join(directory, 'usage.json'));
    }
    if (scenario.generic && session?.analysis?.current && (!session.modeling?.usedSkillIds.includes('generic')
      || session.modeling.usedSkillIds.some(id => id !== 'generic')
      || !uiSkillUsage.includes('本轮实际使用') || !uiSkillUsage.includes('通用'))) {
      failure ??= 'Generic execution and the visible skill-usage record must agree.';
    }
    if (session?.analysis?.runId) {
      try { run = await json('/runs/' + session.analysis.runId); fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(run, null, 2)); }
      catch (error) { failure ??= String(error); }
    }
    const summary = { id: scenario.id, conversationId, seconds: (Date.now() - start) / 1000, turns,
      questionCalls: questions.length, questionAttempts: questionAttempts.length, rejectedQuestions: refused.size,
      toolCalls: session?.usage?.toolCalls ?? tools.length, usage: session?.usage, modeling: session?.modeling, uiSkillUsage, expected: scenario.expected,
      analysis: session?.analysis, waiting: session?.waitingForReply, policy: session?.policy,
      analysisResponses: tools.filter(message => message.name === 'run_analysis').map(message => parse(message.content)),
      questions: questions.map(call => call.args),
      toolErrors: tools.filter(message => /^Error:|"success":false|RECOVERY_BUDGET_EXHAUSTED/.test(message.content)),
      lastAssistant: conversation?.messages?.filter(message => message.role === 'assistant').at(-1)?.content,
      pageErrors, captureWarnings, failure };
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
    summaries.push(summary);
    fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(summaries, null, 2));
    console.log(JSON.stringify({ completed: scenario.id, seconds: summary.seconds, turns, questions: questions.length,
      toolCalls: summary.toolCalls, analysis: session?.analysis?.current, failure }));
    await context.close();
  }
  const pending = cases.filter(item => !requested || requested.includes(item.id));
  const concurrency = Number(process.env.SCLAW_ACCEPTANCE_CONCURRENCY ?? 2);
  if (![1, 2].includes(concurrency)) throw new Error('ACCEPTANCE_CONCURRENCY_MUST_BE_1_OR_2');
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (pending.length) await runScenario(pending.shift());
  }));
} finally {
  await browser?.close();
  server.kill();
  fs.closeSync(log);
}

function parse(value) { try { return JSON.parse(value); } catch { return value; } }
function phaseOneCases() {
  const concrete = '计算一个2*2的小混凝土框架，跨度5m，高度3米每层，一共两层，其他材料你自己安排，荷载除了地面外每个节点都有100N的x方向荷载';
  const concreteFollowup = '确认按三维X、Y各2跨、每跨5m、两层每层3m建模，底部9个节点全固定，上部18个节点各沿全局+x方向100N；不计自重及其他荷载。材料C30，E=30000MPa、泊松比0.2、密度2500kg/m³；梁矩形宽250mm高400mm、柱矩形400mm×400mm，刚接。只做OpenSees线弹性静力分析，核对总水平荷载与基底X反力，不做规范设计。';
  return [1, 2].map(attempt => ({ id: `concrete-${attempt}`, prompt: concrete, followups: [concreteFollowup], expected: { totalFxKN: 1.8, baseReactionFxKN: -1.8 } })).concat([
    { id: 'steel-frame', prompt: '计算二维两跨两层钢框架，X方向每跨5m，每层3m，X-Z平面；底部3节点全固定，所有梁柱刚接。上部6个节点各沿全局+x方向10kN，不计自重及其他荷载。钢材E=206000MPa、nu=0.3、rho=7850kg/m³，梁柱均用实心矩形200mm宽×300mm高。用OpenSees线弹性静力分析，给基底X反力总和，不做规范设计或报告。', expected: { totalFxKN: 60, baseReactionFxKN: -60 } },
    { id: 'truss', prompt: '用OpenSees计算二维X-Z平面三角桁架，节点A=(0,0,0)、B=(6,0,0)、C=(3,0,3)，构件AB、AC、BC全为纯轴力铰接杆。A铰支约束X/Y/Z平移，B滚支约束Y/Z平移，其余平移自由。C节点全局Z向下10kN，不计自重；所有杆E=206000MPa、nu=0.3、rho=7850kg/m³，截面面积A=0.002m²（纯轴力无需惯性矩）。只做线弹性静力分析，给支座竖向反力与杆轴力，不做规范设计。', expected: { reactionsZKN: [5, 5], chordTensionKN: 5, diagonalCompressionKN: 7.0710678119 } },
    { id: 'i20a', prompt: '计算4m水平简支I20a钢梁，左铰右滚，梁全跨全局Z向下均布5kN/m，不计自重。采用用户给定的截面数值作为本次证据：A=0.00355m²、Iy=0.0000237m⁴（强轴，竖向弯曲）、Iz=0.00000158m⁴、J=0.0000001m⁴；这些数值无需查表或推测。材料E=206000MPa、nu=0.3、rho=7850kg/m³。用OpenSees二维线弹性静力分析，给两端竖向反力、跨中弯矩和挠度；不做规范设计。', expected: { reactionsZKN: [10, 10], midspanMomentKNm: 10, midspanDeflectionMM: 5 * 5 * 4 ** 4 / (384 * 206000000 * 0.0000237) * 1000 } },
    { id: 'pkpm', prompt: '用PKPM算三维单跨单层混凝土框架，X、Y各1跨每跨5m，层高3m，底部4节点全固定，梁柱刚接。顶部4节点各沿全局+x施加10kN，不计自重及其他荷载。材料C30，E=30000MPa、nu=0.2、rho=2500kg/m³；梁宽250mm高400mm，柱400mm方形。只做静力分析，给基底X反力总和，不做规范设计。如果PKPM不可用请明确报告，不换其他引擎。', expected: { totalFxKN: 40, baseReactionFxKN: -40, provider: 'pkpm-static' } },
    { id: 'gb50017', prompt: '用OpenSees计算4m简支Q235钢梁并用GB50017-2017校核，无需生成报告。左铰右滚，全跨全局Z向下均布5kN/m，不计自重。材料E=206000MPa、nu=0.3、rho=7850kg/m³、fy=235MPa；实心矩形宽100mm高200mm。先核对两端10kN竖向反力和跨中10kNm弯矩，然后调用GB50017校核，缺少设计依据时明确列出，不得擅自判定通过。', expected: { designCode: 'GB50017', reactionsZKN: [10, 10], midspanMomentKNm: 10 } },
  ]);
}
function genericCases() {
  const steel = '所有材料Q235，E=206000MPa、nu=0.3、rho=7850kg/m³；除注明纯轴力杆外截面均为实心矩形宽200mm高300mm，高沿竖向。不计自重。只用OpenSees线弹性静力，不做规范设计或报告。';
  return [
    { id: 'generic-delegated-frame3d', generic: true, builder: 'llm',
      prompt: '你就计算一个3d的小混凝土框架，x，y方向各两跨，跨度5m，高度3米每层，一共两层，其他材料你自己安排，荷载除了地面外每个节点都有100N的x方向荷载',
      followups: ['同意按上述 C30 + 梁250×500 + 柱400×400 建模并计算'],
      expected: { totalFxKN: 1.8, baseReactionFxKN: -1.8, nodeCount: 27, memberCount: 42, loadCount: 18 } },
    { id: 'generic-frame', generic: true, prompt: '建立二维X-Z平面两跨两层刚接框架，跨度每跨5m、每层3m；底层3节点全固定，上方两层各3节点，每个上部节点全局+x方向10kN。给基底X反力总和。' + steel, expected: { totalFxKN: 60, baseReactionFxKN: -60 } },
    { id: 'generic-portal', generic: true, prompt: '建立二维坡屋面门式刚架：A=(0,0,0)、B=(0,0,3)、C=(3,0,4)、D=(6,0,3)、E=(6,0,0)。A、E全固定，AB、DE为柱，BC、CD为刚接屋面梁。C节点全局Z向下20kN。给两个基底竖向反力。' + steel, expected: { reactionsZKN: [10, 10], totalFzKN: -20 } },
    { id: 'generic-arch', generic: true, prompt: '建立二维X-Z平面上半圆拱，圆心(3,0,0)，半径3m，从A=(0,0,0)经冠点C=(3,0,3)到B=(6,0,0)，等分为12个直梁段近似。两端全固定，各段连续刚接，冠点全局Z向下10kN。给两端竖向反力，保留A、B、C的ID。' + steel, expected: { reactionsZKN: [5, 5], totalFzKN: -10 } },
    { id: 'generic-inclined-truss', generic: true, prompt: '建立倾斜下弦的二维三角桁架：A=(0,0,0)、B=(6,0,2)、C=(3,0,4)，AB、AC、BC纯轴力杆，全铰接，A约束X/Y/Z平移，B只约束Y/Z平移，C自由。C全局Z向下10kN。各杆截面面积0.002m²，E=206000MPa、nu=0.3、rho=7850kg/m³。用OpenSees线弹性静力，不计自重，不做规范设计或报告。给两端竖向反力与杆轴力。', expected: { reactionsZKN: [5, 5], totalFzKN: -10 } },
    { id: 'generic-grid3d', generic: true, prompt: '建立三维刚接框架，X、Y各2跨各跨5m，两层各高3m。底部9节点全固定，上部18节点各沿全局+x方向100N，不计其他荷载。C30材料E=30000MPa、nu=0.2、rho=2500kg/m³，梁250mm宽400mm高，柱400mm方形。只做OpenSees线弹性静力，不计自重，不做规范设计或报告。给基底X反力合计，核对节点与荷载数。', expected: { totalFxKN: 1.8, baseReactionFxKN: -1.8 } },
    { id: 'generic-scale-grid', generic: true, prompt: '建立三维规则刚接混凝土框架，X、Y各4跨、每跨5m，共4层，每层3m。基点A=(0,0,0)，请保留A的ID，其余节点自行命名；全部25个底部节点全固定，上部100个节点各沿全局+x施加100N。所有梁柱均用400mm方形实心截面，C30材料E=30000MPa、nu=0.2、rho=2500kg/m³。不计自重、无其他荷载。只用OpenSees线弹性静力，给节点、构件与荷载计数以及基底X反力合计，不做规范设计或报告。', expected: { totalFxKN: 10, baseReactionFxKN: -10, nodeCount: 125, memberCount: 260, loadCount: 100 } },
    { id: 'generic-cantilever-brace', generic: true, prompt: '建立无专用模板的二维框架加悬挑和斜撑：A=(0,0,0)、B=(5,0,0)、C=(0,0,3)、D=(5,0,3)、E=(7,0,3)。柱AC、BD，连续刚接梁CD和悬挑DE，AD为纯轴力铰接斜撑。A、B全固定。E全局Z向下10kN，D全局+x方向5kN，保留全部ID与两项荷载。给基底X/Z反力合计。' + steel,
      followups: ['补充：纯轴力斜撑AD的截面面积为0.002m²，材料与其他杆件相同；其余已给几何、梁柱截面、支承和两项节点荷载保持不变。'],
      expected: { totalFxKN: 5, totalFzKN: -10, baseReactionFxKN: -5, baseReactionFzKN: 10 } },
  ];
}
