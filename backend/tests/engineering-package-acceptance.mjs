// Opt-in real tarball installation. No benchmark checkout or model calls.
// node backend/tests/engineering-package-acceptance.mjs package.tgz /path/to/python
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const tarball = path.resolve(process.argv[2] || '');
const python = path.resolve(process.argv[3] || '');
assert.ok(fs.statSync(tarball).isFile(), 'Provide the packed .tgz');
assert.ok(fs.statSync(python).isFile(), 'Provide the configured analysis Python');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-package-acceptance-'));
const host = path.join(root, 'host');
const workspace = path.join(root, 'unrelated-cwd');
const data = path.join(root, 'runtime');
for (const dir of [host, workspace, data]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(host, 'package.json'), JSON.stringify({ name: 'sclaw-private-install-check', version: '1.0.0', private: true }));
const npmEntry = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(file => file && fs.existsSync(file));
assert.ok(npmEntry, 'npm CLI unavailable');
const env = { ...process.env, SCLAW_DATA_DIR: data };
for (const key of ['SCLAW_PROJECT_ROOT', 'DATABASE_URL', 'NODE_OPTIONS', 'SCLAW_FRONTEND_DIR', 'LLM_API_KEY']) delete env[key];
const receipt = { status: 'running', root, tarball, sha256: createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'), steps: [] };
function run(name, args, cwd = workspace) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 600000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  fs.writeFileSync(path.join(root, `${name}.log`), `${result.stdout || ''}\n${result.stderr || ''}`);
  receipt.steps.push({ name, exitCode: result.status, durationMs: Date.now() - started });
  if (result.status !== 0) receipt.status = 'failed';
  fs.writeFileSync(path.join(root, 'acceptance.json'), JSON.stringify(receipt, null, 2));
  console.log(`${name}: ${result.status} (${root})`);
  assert.equal(result.status, 0, `${name}: ${result.error?.message || result.stderr}\n${result.stdout?.slice(-3000)}`);
  return result.stdout;
}
run('install', [npmEntry, 'install', '--omit=dev', '--no-audit', '--no-fund', tarball], host);
const installed = path.join(host, 'node_modules/@structureclaw/structureclaw');
assert.equal(fs.existsSync(path.join(installed, 'tests/llm-benchmark')), false);
assert.equal(fs.existsSync(path.join(installed, 'backend/node_modules')), false);
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const database = path.join(data, 'explicit-database.sqlite');
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ server: { port, host: '127.0.0.1' }, database: { url: `file:${database}` },
  analysis: { pythonBin: python }, logging: { level: 'warn', llmLogEnabled: false } }, null, 2));
const cli = path.join(installed, 'sclaw');
try {
  run('doctor', [cli, 'doctor']);
  assert.ok(fs.existsSync(database));
  assert.equal(fs.existsSync(path.join(data, 'data/structureclaw.doctor.db')), false);
  run('start', [cli, 'start', '--no-open']);
  run('health', [cli, 'health']);
  const ui = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(ui.status, 200);
  assert.ok((await ui.text()).includes('<html'));
  const probe = path.join(path.dirname(fileURLToPath(import.meta.url)), 'package-runtime-probe.mjs');
  run('runtime-probe', [probe, installed, `http://127.0.0.1:${port}`]);
  receipt.status = 'passed';
} finally {
  try { run('stop', [cli, 'stop']); } catch (error) { receipt.status = 'failed'; throw error; }
  finally { fs.writeFileSync(path.join(root, 'acceptance.json'), JSON.stringify(receipt, null, 2)); }
}
console.log(JSON.stringify(receipt, null, 2));
