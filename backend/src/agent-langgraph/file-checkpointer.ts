/** Durable LangGraph checkpoints. The empty namespace retains the historical layout. */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual, promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver, WRITES_IDX_MAP, TASKS, maxChannelVersion,
  type Checkpoint, type CheckpointMetadata, type CheckpointTuple,
  type CheckpointListOptions, type CheckpointPendingWrite, type PendingWrite,
} from '@langchain/langgraph-checkpoint';

const SAFE_ID_RE = /^(?!\.\.?$)[a-zA-Z0-9._-]+$/;
function validateId(id: string, label: string): void {
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) throw new Error('Invalid ' + label + ': contains unsafe characters');
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
const compress = promisify(gzip), decompress = promisify(gunzip);
type Serialized = { type: string; data: string; encoding?: 'gzip-base64' };
interface StoredCheckpoint {
  checkpoint: Serialized | string;
  metadata: Serialized | string;
  namespace?: string;
  parentCheckpointId?: string;
  identity?: { id: string; ts: string; sha256: string };
}
type StoredWrites = { version: 2; entries: Record<string, { channel: string; value: Serialized | string }> };

export class FileCheckpointer extends BaseCheckpointSaver {
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(private readonly dataDir: string) {
    super();
    for (const kind of ['checkpoints', 'writes']) fsSync.mkdirSync(path.join(dataDir, kind), { recursive: true });
  }

  private directory(kind: 'checkpoints' | 'writes', thread: string, namespace = ''): string {
    validateId(thread, 'thread_id');
    const root = path.join(this.dataDir, kind, thread);
    return namespace ? path.join(root, 'namespaces', createHash('sha256').update(namespace).digest('hex')) : root;
  }

  private async serialize(value: unknown): Promise<Serialized> {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    if (bytes.length >= 32768) {
      const compressed = await compress(bytes);
      if (compressed.length < bytes.length) return { type, data: compressed.toString('base64'), encoding: 'gzip-base64' };
    }
    return { type, data: Buffer.from(bytes).toString('base64') };
  }

  private async deserialize(value: Serialized | string): Promise<unknown> {
    if (typeof value === 'string') return this.serde.loadsTyped('json', value);
    if (value.encoding !== undefined && value.encoding !== 'gzip-base64') throw new Error('CHECKPOINT_ENCODING_INVALID');
    const bytes = Buffer.from(value.data, 'base64');
    return this.serde.loadsTyped(value.type, value.encoding === 'gzip-base64' ? await decompress(bytes) : bytes);
  }

  private identityHash(stored: StoredCheckpoint, id: string, ts: string): string {
    return createHash('sha256').update(JSON.stringify([id, ts, stored.namespace ?? '', stored.checkpoint])).digest('hex');
  }

  private async identity(stored: StoredCheckpoint): Promise<{ id: string; ts: string }> {
    if (stored.identity === undefined) return this.deserialize(stored.checkpoint) as Promise<Checkpoint>;
    const { id, ts, sha256 } = stored.identity;
    if (typeof id !== 'string' || typeof ts !== 'string' || !Number.isFinite(Date.parse(ts))
      || sha256 !== this.identityHash(stored, id, ts)) throw new Error('CHECKPOINT_IDENTITY_INVALID');
    return { id, ts };
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
    catch (error) {
      if (missing(error)) return undefined;
      // A corrupt current state must never silently become an older/new conversation.
      throw new Error('CHECKPOINT_READ_FAILED: ' + file, { cause: error });
    }
  }

  private async files(directory: string): Promise<string[]> {
    try { return (await fs.readdir(directory)).filter(file => file.endsWith('.json')).sort(); }
    catch (error) { if (missing(error)) return []; throw error; }
  }

  private async atomicWrite(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.rename(temporary, file); }
    finally { await fs.unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }

  private async readWrites(file: string): Promise<StoredWrites> {
    const stored = await this.readJson<StoredWrites | [string, string][]>(file);
    if (!stored) return { version: 2, entries: {} };
    if (!Array.isArray(stored)) {
      if (stored.version !== 2 || !stored.entries) throw new Error('CHECKPOINT_WRITES_INVALID: ' + file);
      return stored;
    }
    // Old files stored channel/JSON pairs without serializer type or write indices.
    return { version: 2, entries: Object.fromEntries(stored.map(([channel, value], i) =>
      [String(WRITES_IDX_MAP[channel] ?? i), { channel, value }])) };
  }

  private async pendingWrites(thread: string, namespace: string, id: string): Promise<CheckpointPendingWrite[]> {
    validateId(id, 'checkpoint_id');
    const directory = path.join(this.directory('writes', thread, namespace), id);
    const pending: CheckpointPendingWrite[] = [];
    for (const file of await this.files(directory)) {
      const taskId = file.slice(0, -5);
      validateId(taskId, 'task_id');
      const stored = await this.readWrites(path.join(directory, file));
      for (const { channel, value } of Object.values(stored.entries)) pending.push([taskId, channel, await this.deserialize(value)]);
    }
    return pending;
  }

  private async tuple(thread: string, namespace: string, id: string): Promise<CheckpointTuple | undefined> {
    validateId(id, 'checkpoint_id');
    const stored = await this.readJson<StoredCheckpoint>(path.join(this.directory('checkpoints', thread, namespace), id + '.json'));
    if (!stored) return undefined;
    if ((stored.namespace ?? '') !== namespace) throw new Error('CHECKPOINT_NAMESPACE_MISMATCH');
    if (stored.identity !== undefined) await this.identity(stored);
    const checkpoint = await this.deserialize(stored.checkpoint) as Checkpoint;
    if (checkpoint.id !== id || !Number.isFinite(Date.parse(checkpoint.ts))) throw new Error('CHECKPOINT_ID_OR_TIME_INVALID');
    if (stored.identity && (checkpoint.id !== stored.identity.id || checkpoint.ts !== stored.identity.ts)) throw new Error('CHECKPOINT_IDENTITY_INVALID');
    const metadata = await this.deserialize(stored.metadata) as CheckpointMetadata;
    const config = { configurable: { thread_id: thread, checkpoint_ns: namespace, checkpoint_id: id } };
    let parentConfig: RunnableConfig | undefined;
    if (stored.parentCheckpointId) {
      validateId(stored.parentCheckpointId, 'parent_checkpoint_id');
      parentConfig = { configurable: { ...config.configurable, checkpoint_id: stored.parentCheckpointId } };
      if (checkpoint.v < 4) {
        const parentWrites = await this.pendingWrites(thread, namespace, stored.parentCheckpointId);
        checkpoint.channel_values[TASKS] = parentWrites.filter(([, channel]) => channel === TASKS).map(([, , value]) => value);
        const versions = Object.values(checkpoint.channel_versions);
        checkpoint.channel_versions[TASKS] = versions.length ? maxChannelVersion(...versions) : this.getNextVersion(undefined);
      }
    }
    return { config, checkpoint, metadata, parentConfig, pendingWrites: await this.pendingWrites(thread, namespace, id) };
  }

  private async orderedIds(thread: string, namespace: string): Promise<string[]> {
    const directory = this.directory('checkpoints', thread, namespace);
    const entries: Array<{ id: string; ts: string }> = [];
    // Read historical legacy payloads sequentially; large result sets must not all
    // be inflated at once. New checkpoints sort by their payload-bound identity.
    for (const file of await this.files(directory)) {
      const stored = await this.readJson<StoredCheckpoint>(path.join(directory, file));
      if (!stored) continue;
      if ((stored.namespace ?? '') !== namespace) throw new Error('CHECKPOINT_NAMESPACE_MISMATCH');
      const checkpoint = await this.identity(stored);
      if (checkpoint.id !== file.slice(0, -5) || !Number.isFinite(Date.parse(checkpoint.ts))) throw new Error('CHECKPOINT_ID_OR_TIME_INVALID');
      entries.push({ id: checkpoint.id, ts: checkpoint.ts });
    }
    return entries
      .sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id)).map(entry => entry.id);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const thread = config.configurable?.thread_id as string | undefined;
    if (!thread) return undefined;
    const namespace = config.configurable?.checkpoint_ns ?? '';
    const id = config.configurable?.checkpoint_id as string | undefined
      ?? (await this.orderedIds(thread, namespace))[0];
    return id ? this.tuple(thread, namespace, id) : undefined;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const thread = config.configurable?.thread_id as string | undefined;
    if (!thread) return;
    const namespace = config.configurable?.checkpoint_ns ?? '';
    const ids = await this.orderedIds(thread, namespace);
    const before = options?.before?.configurable?.checkpoint_id;
    const start = before ? ids.indexOf(before) + 1 : 0;
    if (before && start === 0) return;
    let count = 0;
    for (const id of ids.slice(start)) {
      if (count >= (options?.limit ?? Infinity)) break;
      if (config.configurable?.checkpoint_id && id !== config.configurable.checkpoint_id) continue;
      const entry = await this.tuple(thread, namespace, id);
      if (!entry) continue;
      const metadata = entry.metadata as Record<string, unknown> | undefined;
      if (options?.filter && !Object.entries(options.filter).every(([key, value]) => isDeepStrictEqual(metadata?.[key], value))) continue;
      yield entry;
      count++;
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata,
    _newVersions: Record<string, string | number>): Promise<RunnableConfig> {
    const thread = config.configurable?.thread_id as string;
    const namespace = config.configurable?.checkpoint_ns ?? '';
    validateId(checkpoint.id, 'checkpoint_id');
    const parentCheckpointId = config.configurable?.checkpoint_id as string | undefined;
    if (parentCheckpointId) validateId(parentCheckpointId, 'parent_checkpoint_id');
    const file = path.join(this.directory('checkpoints', thread, namespace), checkpoint.id + '.json');
    const stored: StoredCheckpoint = { checkpoint: await this.serialize(checkpoint), metadata: await this.serialize(metadata), namespace, parentCheckpointId };
    stored.identity = { id: checkpoint.id, ts: checkpoint.ts, sha256: this.identityHash(stored, checkpoint.id, checkpoint.ts) };
    await this.atomicWrite(file, stored);
    return { configurable: { thread_id: thread, checkpoint_ns: namespace, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const thread = config.configurable?.thread_id as string;
    const id = config.configurable?.checkpoint_id as string;
    const namespace = config.configurable?.checkpoint_ns ?? '';
    validateId(id, 'checkpoint_id');
    validateId(taskId, 'task_id');
    const file = path.join(this.directory('writes', thread, namespace), id, taskId + '.json');
    // Merge concurrent task writes, retaining the first committed normal write.
    const pending = (this.writes.get(file) ?? Promise.resolve()).then(async () => {
      const stored = await this.readWrites(file);
      for (const [i, [channel, value]] of writes.entries()) {
        const index = WRITES_IDX_MAP[channel] ?? i;
        if (index >= 0 && stored.entries[index]) continue;
        stored.entries[index] = { channel, value: await this.serialize(value) };
      }
      await this.atomicWrite(file, stored);
    });
    this.writes.set(file, pending);
    try { await pending; }
    finally { if (this.writes.get(file) === pending) this.writes.delete(file); }
  }

  async deleteThread(thread: string): Promise<void> {
    validateId(thread, 'thread_id');
    for (const kind of ['checkpoints', 'writes'] as const) await fs.rm(this.directory(kind, thread), { recursive: true, force: true });
  }
}
