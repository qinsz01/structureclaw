// Boots the real compiled backend (backend/dist/index.js) in a child process with an
// exclusively test-owned SCLAW_DATA_DIR, SQLite database and settings.json whose LLM points to
// the in-process fake provider. Mirrors frontend/tests/e2e/start-server.mjs without the frontend.
// The user's ~/.structureclaw and G:/StructureClaw-All/sclaw_data are never written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repositoryDir = path.resolve(backendDir, '..');
const TEMP_PREFIX = 'sclaw-characterization-';
const OPENSEES_PROBE = 'import fastapi; import openseespy.opensees';

let cachedPython;
/** Python that can run the OpenSees worker, or null. Read-only probe of known runtimes. */
export function resolveOpenSeesPython() {
  if (cachedPython !== undefined) return cachedPython;
  const suffix = process.platform === 'win32' ? ['.venv', 'Scripts', 'python.exe'] : ['.venv', 'bin', 'python'];
  const candidates = [process.env.SCLAW_TEST_PYTHON, process.env.SCLAW_E2E_PYTHON,
    path.resolve(repositoryDir, '..', 'sclaw_data', ...suffix), path.join(os.homedir(), '.structureclaw', ...suffix)];
  // An explicit SCLAW_TEST_PYTHON is authoritative: when it lacks OpenSees, OpenSees suites skip.
  if (process.env.SCLAW_TEST_PYTHON) candidates.splice(1);
  cachedPython = candidates.find(value => value && fs.existsSync(value)
    && spawnSync(value, ['-c', OPENSEES_PROBE], { stdio: 'ignore', windowsHide: true, timeout: 60_000 }).status === 0) ?? null;
  return cachedPython;
}

export function openSeesSkipReason() {
  return resolveOpenSeesPython() ? null
    : 'OpenSees unavailable: no Python with fastapi+openseespy (set SCLAW_TEST_PYTHON or run `./sclaw doctor`). Characterization tests skipped.';
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function assertSafeTempDir(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to touch non-test directory ${resolved}`);
  }
}

/**
 * Start an isolated backend. `llmBaseUrl` must be the fake provider.
 * Returns HTTP helpers plus the data dir for direct inspection of run-records.
 * `env` adds product environment variables (e.g. SCLAW_RUN_PROFILE) to the child process.
 */
export async function startBackend({ llmBaseUrl, llmModel = 'characterization-scripted', pythonBin, nativeSettings, env: extraEnv = {} }) {
  const entry = path.join(backendDir, 'dist', 'index.js');
  if (!fs.existsSync(entry)) throw new Error('CHARACTERIZATION_BUILD_REQUIRED: run npm run build --prefix backend');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  assertSafeTempDir(dataDir);
  const port = await freePort();
  const databasePath = path.join(dataDir, 'data', 'structureclaw.db');
  const databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
  const settings = {
    server: { port, host: '127.0.0.1', frontendPort: port },
    database: { url: databaseUrl },
    llm: { baseUrl: llmBaseUrl, model: llmModel, apiKey: 'characterization-fixture-not-a-secret', maxRetries: 0 },
    vision: { baseUrl: llmBaseUrl, model: 'characterization-scripted', apiKey: 'characterization-fixture-not-a-secret', maxRetries: 0 },
    analysis: { pythonBin },
    agent: { workspaceRoot: dataDir, checkpointDir: path.join(dataDir, 'checkpoints'), allowShell: false },
    logging: { level: 'warn', llmLogEnabled: false },
    ...(nativeSettings?.pkpm ? { pkpm: { ...nativeSettings.pkpm, workDir: path.join(dataDir, 'native-pkpm') } } : {}),
    ...(nativeSettings?.yjk ? { yjk: { ...nativeSettings.yjk, workDir: path.join(dataDir, 'native-yjk'), invisible: true } } : {}),
  };
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));
  const env = { ...process.env };
  // Legacy environment fallbacks must not import personal credentials or models.
  for (const key of Object.keys(env)) {
    if (key.startsWith('LLM_') || key === 'OPENAI_API_KEY' || key === 'ANTHROPIC_API_KEY') delete env[key];
  }
  delete env.NODE_OPTIONS; // Jest's --experimental-vm-modules is not needed by the product server.
  delete env.SCLAW_RUN_PROFILE; // A developer's ablation profile must not leak into characterization; pass it via `env`.
  Object.assign(env, { SCLAW_DATA_DIR: dataDir, DATABASE_URL: databaseUrl, PORT: String(port), NODE_ENV: 'test',
    SCLAW_INSTANCE_ID: `characterization-${randomUUID()}`, SCLAW_FRONTEND_DIR: path.join(dataDir, 'no-frontend') }, extraEnv);
  const sync = spawnSync(process.execPath, [path.join(backendDir, 'scripts', 'sync-sqlite-schema.mjs')], {
    cwd: backendDir, env, encoding: 'utf8', windowsHide: true, timeout: 120_000,
  });
  if (sync.status !== 0) throw new Error(`CHARACTERIZATION_DATABASE_INIT_FAILED: ${sync.stderr || sync.stdout}`);

  const child = spawn(process.execPath, [entry], { cwd: backendDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = chunk => { output = (output + chunk.toString()).slice(-20_000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      throw new Error(`Backend exited early (${child.exitCode}): ${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`Backend did not become healthy: ${output}`); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  const json = async (method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: response.status, body: parsed };
  };
  const sse = async (url, body) => {
    const response = await fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`SSE ${url} failed: ${response.status} ${text}`);
    const events = text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
    return turnFromEvents(events);
  };

  return {
    baseUrl,
    dataDir,
    logs: () => output,
    get: url => json('GET', url),
    post: (url, body) => json('POST', url, body),
    /** POST /api/v1/chat/stream and parse the SSE events of the completed turn. */
    stream: body => sse('/api/v1/chat/stream', body),
    /** POST /api/v1/chat/stream/resume. */
    resume: body => sse('/api/v1/chat/stream/resume', body),
    session: async conversationId => (await json('GET', `/api/v1/chat/conversation/${conversationId}/session`)).body,
    inputReview: async conversationId => (await json('GET', `/api/v1/agent/input-review/${conversationId}`)).body,
    runRecords: () => {
      const directory = path.join(dataDir, 'run-records');
      if (!fs.existsSync(directory)) return [];
      return fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()
        .map(name => ({ name, record: JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) }));
    },
    close: async () => {
      if (child.exitCode === null) {
        child.kill();
        let timer;
        await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 10_000); })]);
        clearTimeout(timer);
      }
      child.stdout.destroy();
      child.stderr.destroy();
      assertSafeTempDir(dataDir);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { fs.rmSync(dataDir, { recursive: true, force: true }); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 500)); } // Windows file locks after kill.
      }
    },
  };
}

export function turnFromEvents(events) {
  const start = events.find(event => event.type === 'start');
  return {
    events,
    steps: events.filter(event => event.type === 'step_upsert').map(event => event.step),
    conversationId: start?.content?.conversationId,
    errors: events.filter(event => event.type === 'error' || event.type === 'presentation_error'),
    interactions: events.filter(event => event.type === 'interaction_update'),
    result: [...events].reverse().find(event => event.type === 'result'),
  };
}
