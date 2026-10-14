import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Publish complete bytes after they have reached the filesystem. */
export function writeAtomicFile(file: string, value: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(handle, value); fs.fsyncSync(handle); }
  finally { fs.closeSync(handle); }
  fs.renameSync(temporary, file);
}

export function writeAtomicJson(file: string, value: unknown): void {
  writeAtomicFile(file, JSON.stringify(value));
}
