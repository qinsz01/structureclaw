import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { config } from '../config/index.js';
import { resolveBackendAsset } from './bundled-paths.js';

const prismaSchemaDir = resolveBackendAsset('prisma');

function normalizeSqliteDatabaseUrl(databaseUrl: string) {
  if (!databaseUrl.startsWith('file:')) {
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
    : path.resolve(prismaSchemaDir, location);

  return `file:${normalizedPath}${query}`;
}

function ensureSqliteDatabaseDirectory(databaseUrl: string) {
  if (!databaseUrl.startsWith('file:')) {
    return;
  }

  const location = databaseUrl.slice('file:'.length).split('?')[0];
  if (!location) {
    return;
  }

  const databasePath = path.isAbsolute(location)
    ? location
    : path.resolve(prismaSchemaDir, location);

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
}

const normalizedDatabaseUrl = normalizeSqliteDatabaseUrl(
  config.databaseUrl,
);
ensureSqliteDatabaseDirectory(normalizedDatabaseUrl);

const adapter = new PrismaBetterSqlite3({ url: normalizedDatabaseUrl });

export const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
});
