import { expect, test } from '@jest/globals';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ensureRegressionSqliteDatabaseUrl } = require('../../tests/regression/shared.js');
// The child is a fresh Node process (so config/database modules bind the regression DATABASE_URL)
// that cold-imports the whole backend dist graph (agent-service alone takes about 3 s idle). It
// starts no network or subprocess work, but cold module loading slows sharply under CPU contention.
const CHILD_TIMEOUT_MS = 90_000;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = fn => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-regression-isolation-'));
  try { return fn(directory); }
  finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())
      || !path.basename(directory).startsWith('sclaw-regression-isolation-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

test('regression database selection never inherits a valid user SQLite URL', () => fixture(directory => {
  const previous = process.env.DATABASE_URL;
  const context = { rootDir: directory, env: { DATABASE_URL: 'file:/user/live-conversations.db' } };
  try {
    ensureRegressionSqliteDatabaseUrl(context);
    const expected = `file:${path.join(directory, '.structureclaw', 'data', 'structureclaw-regression.db').replace(/\\/g, '/')}`;
    expect(context.env.DATABASE_URL).toBe(expected);
    expect(process.env.DATABASE_URL).toBe(expected);
    ensureRegressionSqliteDatabaseUrl(context);
    expect(context.env.DATABASE_URL).toBe(expected);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
}));

test('standalone chat regressions use complete persistence fixtures and leave inherited data untouched', () => fixture(directory => {
  const inheritedDatabase = path.join(directory, 'user-database-sentinel.db');
  const sentinel = 'Do not open or modify the user database';
  fs.writeFileSync(inheritedDatabase, sentinel);
  const script = `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const { pathToFileURL } = require('node:url');
    const { runBackendValidation } = require('./tests/regression/backend-validations.js');
    (async () => {
      const rootDir = process.cwd();
      const context = { rootDir, backendBuildReady: true, env: { DATABASE_URL: process.env.DATABASE_URL } };
      await runBackendValidation('validate-chat-stream-contract', context);
      await runBackendValidation('validate-chat-message-routing', context);
      const { config } = await import(pathToFileURL(path.join(rootDir, 'backend/dist/config/index.js')).href);
      assert.equal(config.databaseUrl, context.env.DATABASE_URL);
      assert.ok(config.databaseUrl.endsWith('/.structureclaw/data/structureclaw-regression.db'));
      const { prisma } = await import(pathToFileURL(path.join(rootDir, 'backend/dist/utils/database.js')).href);
      await prisma.$disconnect();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: rootDir, encoding: 'utf8', windowsHide: true, timeout: CHILD_TIMEOUT_MS,
    env: { ...process.env, SCLAW_DATA_DIR: path.join(directory, 'runtime'), DATABASE_URL: `file:${inheritedDatabase.replace(/\\/g, '/')}` } });
  expect({ status: result.status, error: result.error?.code, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
  expect(result.stdout).toContain('[ok] chat stream contract regression');
  expect(result.stdout).toContain('[ok] chat message routing contract');
  expect(fs.readFileSync(inheritedDatabase, 'utf8')).toBe(sentinel);
}), CHILD_TIMEOUT_MS + 10_000);
