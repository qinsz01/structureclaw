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
  llm: { baseUrl: process.env.LLM_BASE_URL ?? source.llm?.baseUrl, model: process.env.LLM_MODEL ?? source.llm?.model,
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
  const cases = phase === 'phase1' ? phaseOneCases() : genericCases();
  const requested = process.env.SCLAW_ACCEPTANCE_CASES?.split(',');
  for (const scenario of cases.filter(item => !requested || requested.includes(item.id))) {
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
    let turns = 0;
    const start = Date.now();
    try {
      await page.goto('/');
      if (scenario.generic) {
        await page.getByRole('button', { name: '运行设置', exact: true }).click();
        await page.getByLabel('结构技能', { exact: true }).selectOption('restricted');
        await page.getByLabel('通用结构类型', { exact: true }).check();
        await page.getByRole('button', { name: '运行设置', exact: true }).click();
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
        const stream = await response.text();
        fs.writeFileSync(path.join(directory, `turn-${turns}.sse`), stream);
        if (!conversationId) {
          for (const line of stream.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))) {
            const event = JSON.parse(line.slice(6));
            conversationId ??= event.content?.conversationId;
          }
        }
        session = await json(`/api/v1/chat/conversation/${conversationId}/session`);
        conversation = await json(`/api/v1/chat/conversation/${conversationId}`);
        fs.writeFileSync(path.join(directory, `turn-${turns}.json`), JSON.stringify({ prompt, session, conversation }, null, 2));
        console.log(JSON.stringify({ case: scenario.id, turn: turns, analysis: session.analysis?.current,
          waiting: session.waitingForReply, tools: session.usage?.toolCalls, seconds: (Date.now() - start) / 1000 }));
      }
    } catch (error) { failure = String(error); }
    try {
      if (conversationId) {
        session = await json(`/api/v1/chat/conversation/${conversationId}/session`);
        conversation = await json(`/api/v1/chat/conversation/${conversationId}`);
      }
      await page.screenshot({ path: path.join(directory, 'browser.png'), fullPage: true });
    } catch (error) { failure ??= String(error); }
    const tools = conversation?.messages?.filter(message => message.role === 'tool') ?? [];
    const questions = tools.filter(message => message.name === 'ask_user_clarification');
    let run;
    if (session?.analysis?.runId) {
      try { run = await json('/runs/' + session.analysis.runId); fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(run, null, 2)); }
      catch (error) { failure ??= String(error); }
    }
    const summary = { id: scenario.id, conversationId, seconds: (Date.now() - start) / 1000, turns,
      questionCalls: questions.length, toolCalls: tools.length, usage: session?.usage, expected: scenario.expected,
      analysis: session?.analysis, waiting: session?.waitingForReply, policy: session?.policy,
      analysisResponses: tools.filter(message => message.name === 'run_analysis').map(message => parse(message.content)),
      questions: questions.map(message => parse(message.content)),
      toolErrors: tools.filter(message => /^Error:|"success":false|RECOVERY_BUDGET_EXHAUSTED/.test(message.content)),
      lastAssistant: conversation?.messages?.filter(message => message.role === 'assistant').at(-1)?.content,
      pageErrors, failure };
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
    summaries.push(summary);
    fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(summaries, null, 2));
    console.log(JSON.stringify({ completed: scenario.id, seconds: summary.seconds, turns, questions: questions.length,
      toolCalls: tools.length, analysis: session?.analysis?.current, failure }));
    await context.close();
  }
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
    { id: 'i20a', prompt: '计算4m水平简支I20a钢梁，左铰右滚，梁全跨全局Z向下均布5kN/m，不计自重。采用用户给定的截面数值作为本次证据：A=0.00355m²、Iy=0.0000237m⁴（强轴，竖向弯曲）、Iz=0.00000158m⁴、J=0.0000001m⁴；这些数值无需查表或推测。材料E=206000MPa、nu=0.3、rho=7850kg/m³。用OpenSees二维线弹性静力分析，给两端竖向反力、跨中弯矩和挠度；不做规范设计。', expected: { reactionsZKN: [10, 10], midspanMomentKNm: 10, midspanDeflectionMM: 3.4153973006 } },
    { id: 'pkpm', prompt: '用PKPM算三维单跨单层混凝土框架，X、Y各1跨每跨5m，层高3m，底部4节点全固定，梁柱刚接。顶部4节点各沿全局+x施加10kN，不计自重及其他荷载。材料C30，E=30000MPa、nu=0.2、rho=2500kg/m³；梁宽250mm高400mm，柱400mm方形。只做静力分析，给基底X反力总和，不做规范设计。如果PKPM不可用请明确报告，不换其他引擎。', expected: { totalFxKN: 40, baseReactionFxKN: -40, provider: 'pkpm-static' } },
    { id: 'gb50017', prompt: '用OpenSees计算4m简支Q235钢梁并用GB50017-2017校核，无需生成报告。左铰右滚，全跨全局Z向下均布5kN/m，不计自重。材料E=206000MPa、nu=0.3、rho=7850kg/m³、fy=235MPa；实心矩形宽100mm高200mm。先核对两端10kN竖向反力和跨中10kNm弯矩，然后调用GB50017校核，缺少设计依据时明确列出，不得擅自判定通过。', expected: { designCode: 'GB50017', reactionsZKN: [10, 10], midspanMomentKNm: 10 } },
  ]);
}
function genericCases() {
  // Filled by phase 2 alongside its physics checklist and independent hand checks.
  throw new Error('GENERIC_ACCEPTANCE_CASES_NOT_IMPLEMENTED');
}
