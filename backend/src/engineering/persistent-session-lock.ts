import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Reuse the installed SQLite driver solely for short cross-process ownership
// transactions. OS locks release on a crash; no second persistent claim to orphan.
const Database = createRequire(import.meta.url)('better-sqlite3') as new (
  file: string, options: { timeout: number },
) => { exec(sql: string): unknown; close(): void };

function withClaimMutex<T>(sessionFile: string, action: () => T): T {
  const directory = path.dirname(sessionFile);
  fs.mkdirSync(directory, { recursive: true });
  const database = new Database(path.join(directory, '.ownership.sqlite'), { timeout: 3000 });
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      if (result instanceof Promise) throw new Error('SESSION_OWNERSHIP_ACTION_MUST_BE_SYNCHRONOUS');
      database.exec('COMMIT');
      return result;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  } finally { database.close(); }
}

function readOptional(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Permission failures conservatively mean alive; only ESRCH establishes death. */
export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function inspectPersistentSessionLock(sessionFile: string) {
  const raw = readOptional(sessionFile + '.claim');
  if (raw === undefined) return null;
  const claim = JSON.parse(raw) as { token: string; pid: number; createdAt?: string };
  if (typeof claim.token !== 'string' || !claim.token || !Number.isInteger(claim.pid) || claim.pid <= 0) {
    throw new Error('PUBLIC_SESSION_CLAIM_INVALID / 会话占用记录无效');
  }
  return { ...claim, alive: processIsAlive(claim.pid) };
}

/** Prevent a new host claim while taking a read-only session snapshot. */
export function readPersistentSession<T>(sessionFile: string,
  read: (claim: ReturnType<typeof inspectPersistentSessionLock>) => T): T {
  return withClaimMutex(sessionFile, () => read(inspectPersistentSessionLock(sessionFile)));
}

/** An abandoned claim requires inspection, never an elapsed-time takeover. */
export async function acquirePersistentSessionLock(sessionFile: string): Promise<() => Promise<void>> {
  const claimPath = sessionFile + '.claim';
  const owner = JSON.stringify({ token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() });
  withClaimMutex(sessionFile, () => {
    let handle: number;
    try { handle = fs.openSync(claimPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error('PUBLIC_SESSION_BUSY_OR_OUTCOME_UNKNOWN: ' + claimPath +
        '; inspect the claim and original operation before recovery / 恢复前须核查会话占用记录及原操作', { cause: error });
    }
    try { fs.writeFileSync(handle, owner, 'utf8'); fs.fsyncSync(handle); }
    finally { fs.closeSync(handle); }
  });
  let released = false;
  return async () => {
    if (released) return;
    withClaimMutex(sessionFile, () => {
      if (readOptional(claimPath) !== owner) {
        throw new Error('PUBLIC_SESSION_CLAIM_CHANGED / 会话占用记录已变化，未清理其他宿主的记录');
      }
      fs.unlinkSync(claimPath);
      released = true;
    });
  };
}

/** An explicit, synchronous state commit; this cannot launch or await a solver. */
export async function withAbandonedSessionRecovery<T>(sessionFile: string, expectedToken: string | null,
  action: () => T): Promise<T> {
  return withClaimMutex(sessionFile, () => {
    const claim = inspectPersistentSessionLock(sessionFile);
    if ((claim?.token ?? null) !== expectedToken) throw new Error('PUBLIC_SESSION_CLAIM_CHANGED');
    if (claim?.alive) throw new Error('PUBLIC_SESSION_OWNER_RUNNING / 会话所属进程仍在运行');
    const result = action();
    if (result instanceof Promise) throw new Error('SESSION_OWNERSHIP_ACTION_MUST_BE_SYNCHRONOUS');
    const after = inspectPersistentSessionLock(sessionFile);
    if ((after?.token ?? null) !== expectedToken) throw new Error('PUBLIC_SESSION_CLAIM_CHANGED');
    if (claim) fs.unlinkSync(sessionFile + '.claim');
    return result;
  });
}
