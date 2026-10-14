// Start one product server with a new, exclusively test-owned runtime and database.
// Build first via `node sclaw build`; never regenerate Prisma or rebuild a running checkout here.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const frontend = path.join(repository, 'frontend');
const backend = path.join(repository, 'backend');
const port = Number(process.env.SCLAW_E2E_PORT ?? 31515);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [31415, 31416].includes(port)) {
  throw new Error('E2E_PORT_MUST_BE_ISOLATED');
}
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});

function newest(directory) {
  if (!fs.existsSync(directory)) return 0;
  if (!fs.statSync(directory).isDirectory()) return fs.statSync(directory).mtimeMs;
  return Math.max(0, ...fs.readdirSync(directory).filter(name => !['__tests__', 'regression', '__pycache__'].includes(name))
    .map(name => newest(path.join(directory, name))));
}
const { isFrontendBuildCurrent } = createRequire(import.meta.url)(path.join(repository, 'scripts/cli/frontend-build.js'));
const exportReady = isFrontendBuildCurrent({ frontendDir: frontend });
const backendEntry = path.join(backend, 'dist/index.js');
if (!exportReady || !fs.existsSync(backendEntry) || newest(path.join(backend, 'src')) > fs.statSync(backendEntry).mtimeMs) {
  throw new Error('E2E_BUILD_REQUIRED: run node sclaw build before starting browser tests.');
}

const temporaryRoot = path.join(repository, '.tmp');
fs.mkdirSync(temporaryRoot, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(temporaryRoot, 'playwright-'));
const instanceId = `playwright-${randomUUID()}`;
const databasePath = path.join(dataDir, 'data/structureclaw.db');
const databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
const pythonSuffix = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const pythonBin = [process.env.SCLAW_E2E_PYTHON, path.resolve(repository, '..', 'sclaw_data', pythonSuffix),
  path.join(os.homedir(), '.structureclaw', pythonSuffix)].find(value => value && fs.existsSync(value)
    && spawnSync(value, ['-c', 'import fastapi; import openseespy.opensees'], { stdio: 'ignore', windowsHide: true }).status === 0);
if (process.env.SCLAW_E2E_PYTHON && pythonBin !== process.env.SCLAW_E2E_PYTHON) {
  throw new Error('E2E_PYTHON_DEPENDENCIES_MISSING: explicit Python must provide fastapi and openseespy.');
}
if (!pythonBin) {
  throw new Error('E2E_PYTHON_DEPENDENCIES_MISSING: run node sclaw doctor or set SCLAW_E2E_PYTHON to a Python with fastapi and openseespy.');
}
const settings = {
  server: { port, host: '127.0.0.1', frontendPort: port },
  database: { url: databaseUrl },
  llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'e2e-unconfigured', apiKey: '', maxRetries: 0 },
  vision: { baseUrl: 'http://127.0.0.1:9/v1', model: 'e2e-unconfigured', apiKey: '', maxRetries: 0 },
  analysis: { pythonBin },
  agent: { workspaceRoot: dataDir, checkpointDir: path.join(dataDir, 'checkpoints'), allowShell: false },
  logging: { level: 'warn', llmLogEnabled: false },
};
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));
// Static files are immutable for this instance, including while another build runs.
const frontendDir = path.join(dataDir, 'frontend');
fs.cpSync(path.join(frontend, 'out'), frontendDir, { recursive: true });
// Legacy environment fallbacks must not import personal credentials or models.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('LLM_') || key === 'OPENAI_API_KEY') delete process.env[key];
}
Object.assign(process.env, { SCLAW_DATA_DIR: dataDir, DATABASE_URL: databaseUrl, PORT: String(port),
  SCLAW_FRONTEND_DIR: frontendDir, SCLAW_INSTANCE_ID: instanceId, NODE_ENV: 'test' });
const sync = spawnSync(process.execPath, [path.join(backend, 'scripts/sync-sqlite-schema.mjs')], {
  cwd: backend, env: process.env, stdio: 'inherit', windowsHide: true,
});
if (sync.status !== 0) throw new Error('E2E_DATABASE_INIT_FAILED');
fs.writeFileSync(path.join(temporaryRoot, `playwright-server-${port}.json`), JSON.stringify({
  instanceId, pid: process.pid, baseURL: `http://127.0.0.1:${port}`, dataDir, databasePath,
  frontendDir, createdAt: new Date().toISOString(),
}, null, 2));
console.log(`[e2e] Isolated instance ${instanceId} at http://127.0.0.1:${port}; data: ${dataDir}`);
await import(pathToFileURL(backendEntry).href);
