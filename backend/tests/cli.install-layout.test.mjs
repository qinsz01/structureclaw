import { test, expect, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const runtime = require('../../scripts/cli/runtime.js');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function fixture(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sclaw-install-layout-'));
  const put = (file, text = '') => { const target = path.join(dir, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); };
  try { fn(dir, put); } finally {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('sclaw-install-layout-')) throw new Error('Invalid fixture');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the actual published layout works with the retained backend manifest; a checkout stays a checkout', () => fixture((dir, put) => {
  for (const file of ['backend/package.json', 'backend/prisma/schema.prisma', 'dist/backend/index.js', 'dist/frontend/index.html', 'scripts/cli/main.js']) put(file);
  expect(runtime.resolveProjectRoot(dir)).toBe(dir);
  expect(runtime.resolvePaths(dir)).toMatchObject({ installedMode: true, backendDir: path.join(dir, 'dist/backend') });
  put('frontend/package.json');
  expect(runtime.resolvePaths(dir).installedMode).toBe(false);
}));

test('doctor and start preserve explicit settings and an existing legacy database', () => fixture((dir, put) => {
  const saved = process.env.SCLAW_DATA_DIR;
  process.env.SCLAW_DATA_DIR = dir;
  try {
    const explicit = { DATABASE_URL: `file:${path.join(dir, 'chosen.sqlite')}` };
    const doctor = runtime.ensureLocalSqliteConfig(repo, explicit, () => {}, { profileName: 'doctor' });
    expect(runtime.ensureLocalSqliteConfig(repo, explicit)).toBe(doctor);
    expect(doctor).toContain('chosen.sqlite');
    put('data/structureclaw.start.db', 'historical fixture');
    expect(runtime.ensureLocalSqliteConfig(repo, {})).toContain('structureclaw.start.db');
    put('data/structureclaw.db', 'canonical fixture');
    expect(runtime.ensureLocalSqliteConfig(repo, {})).toContain('/data/structureclaw.db');
  } finally { if (saved === undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR = saved; }
}));

test('published dependencies cover backend runtime imports, including parsers and model providers', () => {
  const root = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const backend = JSON.parse(readFileSync(path.join(repo, 'backend/package.json'), 'utf8'));
  for (const [name, version] of Object.entries(backend.dependencies)) expect(root.dependencies[name]).toBe(version);
  expect(root.scripts.prepack).toBe('node scripts/prepare-package.js');
});

test('postinstall validates compiled assets without a compiler or writes into the installed source tree', () => fixture((dir, put) => {
  put('scripts/postinstall.js');
  copyFileSync(path.join(repo, 'scripts/postinstall.js'), path.join(dir, 'scripts/postinstall.js'));
  const run = () => spawnSync(process.execPath, [path.join(dir, 'scripts/postinstall.js')], { cwd: os.tmpdir(), encoding: 'utf8' });
  expect(run().status).not.toBe(0);
  for (const file of ['dist/backend/index.js', 'dist/backend/generated/prisma/client.js', 'dist/frontend/index.html', 'backend/prisma/schema.prisma']) put(file);
  expect(run().status).toBe(0);
  expect(existsSync(path.join(dir, 'backend/src/generated'))).toBe(false);
}));

test('readiness requires this instance and a working database, not just HTTP 200', async () => {
  let body = { status: 'ok', instanceId: 'mine', services: { database: true } };
  const server = createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/health`;
    expect(await runtime.requestHealth(url, 'mine')).toBe(true);
    expect(await runtime.requestHealth(url, 'another')).toBe(false);
    body.services.database = false;
    expect(await runtime.requestHealth(url, 'mine')).toBe(false);
    body = { status: 'ok' };
    expect(await runtime.requestHealth(url)).toBe(false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('cold startup can take over 30 seconds without a duplicate launch or a false success', async () => {
  jest.useFakeTimers();
  const started = Date.now();
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true, json: async () => ({ status: 'ok', instanceId: 'mine', services: { database: Date.now() - started >= 45000 } }),
  }));
  const progress = jest.fn();
  try {
    const ready = runtime.waitForHealth('http://localhost/health', 'mine', () => true, progress);
    await jest.advanceTimersByTimeAsync(46000);
    expect(await ready).toBe(true);
    expect(progress.mock.calls.map(([seconds]) => seconds)).toEqual([10, 20, 30, 40]);
    expect(await runtime.waitForHealth('http://localhost/health', 'mine', () => false)).toBe(false);
    fetch.mockImplementation(async () => ({ ok: false }));
    const failed = runtime.waitForHealth('http://localhost/health', 'mine', () => true, () => {}, 1000);
    await jest.advanceTimersByTimeAsync(1250);
    expect(await failed).toBe(false);
  } finally { fetch.mockRestore(); jest.useRealTimers(); }
});
