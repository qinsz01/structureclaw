#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { applyPreservingMigration } from './sqlite-migration.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..');
const prismaDir = path.join(backendDir, 'prisma');
const schemaPath = path.join(prismaDir, 'schema.prisma');
// Canonical data dir: SCLAW_DATA_DIR || ~/.structureclaw (see backend/src/config/index.ts)
const userDataDir = process.env.SCLAW_DATA_DIR || path.join(os.homedir(), '.structureclaw');
const defaultDatabasePath = path.join(userDataDir, 'data', 'structureclaw.db');
const prismaCliPath = createRequire(import.meta.url).resolve('prisma/build/index.js');

function normalizeDatabaseUrl(databaseUrl) {
  if (!databaseUrl || !databaseUrl.startsWith('file:')) {
    return databaseUrl;
  }

  const suffix = databaseUrl.slice('file:'.length);
  const queryIndex = suffix.indexOf('?');
  const location = queryIndex >= 0 ? suffix.slice(0, queryIndex) : suffix;
  const query = queryIndex >= 0 ? suffix.slice(queryIndex) : '';

  if (!location) {
    return databaseUrl;
  }

  const normalizedPath = path.isAbsolute(location)
    ? location
    : path.resolve(prismaDir, location);

  return `file:${normalizedPath}${query}`;
}

function runPrisma(args, databaseUrl) {
  const prismaArgs = args[0] === 'prisma' ? args.slice(1) : args;
  const result = spawnSync(process.execPath, [prismaCliPath, ...prismaArgs], {
    cwd: backendDir,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    if (result.error) {
      console.error(result.error.message);
    }
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }

  return result.stdout ?? '';
}

let settingsDatabaseUrl;
try {
  const settings = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'));
  if (typeof settings?.database?.url === 'string') settingsDatabaseUrl = settings.database.url.trim();
} catch { /* An unconfigured installation uses the canonical default path. */ }
const configuredUrl = process.env.DATABASE_URL || settingsDatabaseUrl || `file:${defaultDatabasePath}`;
const databaseUrl = normalizeDatabaseUrl(configuredUrl);

if (!databaseUrl.startsWith('file:')) {
  console.error(`[error] SQLite sync only supports file: DATABASE_URL values. Received: ${databaseUrl}`);
  process.exit(1);
}

const databasePath = databaseUrl.slice('file:'.length).split('?')[0];
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const useExistingDatabase = fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0;
const diffArgs = useExistingDatabase
  ? ['prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', schemaPath, '--script']
  : ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema', schemaPath, '--script'];

const migrationSql = runPrisma(diffArgs, databaseUrl);
const trimmedSql = migrationSql.trim();

if (!trimmedSql || trimmedSql === '-- This is an empty migration.') {
  console.log(`[ok] SQLite schema already in sync at ${databasePath}`);
  process.exit(0);
}

const { backupPath } = applyPreservingMigration(databasePath, migrationSql);
if (backupPath) console.log(`[ok] Preserved database backup / 已保留数据库备份: ${backupPath}`);

console.log(`[ok] SQLite schema synced at ${databasePath}`);
