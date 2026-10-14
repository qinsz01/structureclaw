import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';

export default async function verifyIsolation(config: FullConfig) {
  const baseURL = String(config.projects[0].use.baseURL);
  const url = new URL(baseURL);
  if (url.hostname !== '127.0.0.1' || ['31415', '31416'].includes(url.port)) throw new Error('E2E_NOT_ISOLATED');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.tmp', `playwright-server-${url.port}.json`), 'utf8'));
  const relative = path.relative(path.join(root, '.tmp'), receipt.dataDir);
  if (!relative.startsWith('playwright-') || relative.includes('..') || path.isAbsolute(relative)
    || receipt.baseURL !== baseURL || !receipt.instanceId.startsWith('playwright-')
    || path.resolve(receipt.databasePath) !== path.resolve(receipt.dataDir, 'data/structureclaw.db')) throw new Error('E2E_RECEIPT_INVALID');
  const health = await fetch(`${baseURL}/health`).then(response => response.json());
  const database = await fetch(`${baseURL}/api/v1/admin/database/status`).then(response => response.json());
  if (health.instanceId !== receipt.instanceId || !health.services?.database
    || path.resolve(database.database?.databasePath ?? '') !== path.resolve(receipt.databasePath)) {
    throw new Error('E2E_SERVER_IDENTITY_MISMATCH: refusing to test an unrelated service.');
  }
}
