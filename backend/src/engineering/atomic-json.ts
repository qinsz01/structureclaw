import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Publish a complete record after its bytes have reached the filesystem. */
export function writeAtomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(handle, JSON.stringify(value)); fs.fsyncSync(handle); }
  finally { fs.closeSync(handle); }
  fs.renameSync(temporary, file);
}
