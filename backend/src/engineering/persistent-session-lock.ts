import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

/** An abandoned claim requires inspection, never an elapsed-time takeover. */
export async function acquirePersistentSessionLock(sessionFile: string): Promise<() => Promise<void>> {
  const claimPath = `${sessionFile}.claim`;
  await mkdir(path.dirname(claimPath), { recursive: true });
  const owner = JSON.stringify({ token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() });
  let handle;
  try { handle = await open(claimPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(`PUBLIC_SESSION_BUSY_OR_OUTCOME_UNKNOWN: ${claimPath}; another host owns this session or stopped before releasing it. Inspect the claim and pending operation before recovery / 会话被其他宿主占用，或上次退出前未释放；恢复前须核查占用记录及待完成操作`, { cause: error });
  }
  try { await handle.writeFile(owner, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  let released = false;
  return async () => {
    if (released) return;
    // A replaced/missing claim is not ours to clean up. Keep the evidence and
    // fail rather than removing another host's ownership after manual recovery.
    if (await readFile(claimPath, 'utf8') !== owner) {
      throw new Error('PUBLIC_SESSION_CLAIM_CHANGED / 会话占用记录已变化，未清理其他宿主的记录');
    }
    await unlink(claimPath);
    released = true;
  };
}
