import type { AnalysisEngineManifest } from './analysis-engine.js';
import {
  AnalysisRuntimeRunner,
  LOCAL_GET_ACTION_BY_PATH,
  LOCAL_POST_ACTION_BY_PATH,
} from '../agent-skills/analysis/entry.js';
import type { ExecutionRequestOptions, LocalAnalysisEngineClient } from '../agent-skills/analysis/types.js';
import { analysisRequestHash, executeAnalysisRun, loadAnalysisRun } from '../engineering/analysis-runs.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeBaseDir } from '../config/index.js';
import { contentHash, isRecord } from '../engineering/model-state.js';
import { processIsAlive, withAbandonedSessionRecovery } from '../engineering/persistent-session-lock.js';
import { writeAtomicJson } from '../engineering/atomic-json.js';
import { solveBeamEquilibrium } from '../engineering/beam-equilibrium.js';

const ownedRequests = new Map<string, AbortController>();
function requestOwnerAlive(record: Record<string, unknown>): boolean | null {
  return typeof record.ownerPid === 'number' && Number.isInteger(record.ownerPid) && record.ownerPid > 0
    ? processIsAlive(record.ownerPid) : null;
}

function buildError(message: string, statusCode = 500): Error & { statusCode?: number } {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  return error;
}

export class AnalysisExecutionService {
  constructor(
    private readonly runner = new AnalysisRuntimeRunner(),
    private readonly persistRun?: (id: string, record: Record<string, unknown>) => Promise<void>,
    private readonly requestsDirectory = path.join(runtimeBaseDir, 'analysis-requests'),
    private readonly readRun = loadAnalysisRun,
  ) {}

  async listEngines(): Promise<{ engines: AnalysisEngineManifest[]; defaultSelectionMode: 'auto' }> {
    return this.runner.invoke({ action: 'list_engines' });
  }

  async getEngine(id: string): Promise<AnalysisEngineManifest | null> {
    try {
      return await this.runner.invoke({ action: 'get_engine', engineId: id });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async checkEngine(id: string): Promise<Record<string, unknown>> {
    return this.runner.invoke({ action: 'check_engine', engineId: id });
  }

  async probeEngine(id: string): Promise<Record<string, unknown>> {
    return this.runner.invoke({ action: 'probe_engine', engineId: id });
  }

  async analyze(payload: Record<string, unknown>, requestOptions?: ExecutionRequestOptions): Promise<Record<string, unknown>> {
    const requestId = payload.requestId === undefined ? randomUUID() : String(payload.requestId);
    const file = this.requestFile(requestId);
    const requestHash = analysisRequestHash(payload);
    const runId = randomUUID();
    await mkdir(this.requestsDirectory, { recursive: true });
    const record: Record<string, unknown> = { requestId, requestHash, runId, status: 'running',
      engineId: payload.engineId, startedAt: new Date().toISOString(), ownerPid: process.pid };
    try { await writeFile(file, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' }); }
    catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error;
      const existing = await this.getRequest(requestId);
      if (existing.requestHash !== requestHash) throw buildError('ANALYSIS_REQUEST_ID_CONFLICT / 请求编号已用于不同输入', 409);
      if (existing.status === 'completed' && typeof existing.runId === 'string') return { ...await this.readRun(existing.runId), requestId };
      throw buildError(`ANALYSIS_REQUEST_${String(existing.status).toUpperCase()}: ${requestId}; query the existing job / 请先查询已有作业`, 409);
    }
    const controller = new AbortController();
    ownedRequests.set(file, controller);
    const signal = requestOptions?.signal ? AbortSignal.any([controller.signal, requestOptions.signal]) : controller.signal;
    const finish = async (updates: Record<string, unknown>) => {
      writeAtomicJson(file, { ...record, ...updates, completedAt: new Date().toISOString() });
    };
    try {
      const result = await executeAnalysisRun({ ...payload, requestId }, (input) => payload.engineId === 'builtin-equilibrium'
        ? Promise.resolve(solveBeamEquilibrium(input))
        : this.runner.invoke({ action: 'analyze', input }, { ...requestOptions, signal }), this.persistRun, runId);
      await finish({ status: signal.aborted ? 'cancelled' : 'completed', executionStatus: result.executionStatus, runId: result.runId });
      return { ...result, requestId };
    } catch (error) {
      await finish({ status: signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { ownedRequests.delete(file); }
  }

  private requestFile(requestId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw buildError('ANALYSIS_REQUEST_ID_INVALID', 400);
    return path.join(this.requestsDirectory, `${requestId}.json`);
  }

  async getRequest(requestId: string): Promise<Record<string, unknown>> {
    const file = this.requestFile(requestId);
    let record: Record<string, unknown>;
    try { record = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (isRecord(error) && error.code === 'ENOENT') throw buildError('ANALYSIS_REQUEST_NOT_FOUND', 404); throw error; }
    const ownerAlive = requestOwnerAlive(record);
    return { ...record, stateHash: contentHash(record), ownerAlive, cancellationAvailable: ownedRequests.has(file),
      ...(record.status === 'running' && !ownedRequests.has(file) && ownerAlive !== true ? { status: 'outcome_unknown',
        message: 'Inspect native job output before submitting again / 请先核查原生作业输出，再决定后续操作' } : {}) };
  }

  /** Recover only a complete, bound archive. No solver or model publication occurs here. */
  async recoverRequest(requestId: string, expectedStateHash: string): Promise<Record<string, unknown>> {
    if (!/^[a-f0-9]{64}$/.test(expectedStateHash)) throw buildError('ANALYSIS_REQUEST_STATE_HASH_INVALID', 400);
    const file = this.requestFile(requestId);
    const inspected = await this.getRequest(requestId);
    if (inspected.stateHash !== expectedStateHash) throw buildError('ANALYSIS_REQUEST_STATE_CHANGED', 409);
    if (inspected.ownerAlive !== false || ownedRequests.has(file)) {
      throw buildError('ANALYSIS_REQUEST_OWNER_UNVERIFIED_OR_RUNNING / 原作业所属进程尚未确认结束', 409);
    }
    if (inspected.status !== 'outcome_unknown' || typeof inspected.runId !== 'string') {
      throw buildError('ANALYSIS_REQUEST_RECOVERY_UNAVAILABLE / 该作业没有可恢复的运行身份', 409);
    }
    let archived: Record<string, unknown>;
    try { archived = await this.readRun(inspected.runId); }
    catch (error) { throw buildError(`ANALYSIS_REQUEST_ARCHIVE_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`, 409); }
    const meta = isRecord(archived.meta) ? archived.meta : {};
    if (archived.runId !== inspected.runId || archived.requestId !== requestId || archived.requestHash !== inspected.requestHash
      || !['completed', 'incomplete'].includes(String(archived.executionStatus))
      || typeof meta.completedAt !== 'string' || !Number.isFinite(Date.parse(meta.completedAt))) {
      throw buildError('ANALYSIS_REQUEST_ARCHIVE_MISMATCH / 归档与原请求不匹配', 409);
    }
    await withAbandonedSessionRecovery(file, null, () => {
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (contentHash(current) !== expectedStateHash) throw buildError('ANALYSIS_REQUEST_STATE_CHANGED', 409);
      if (requestOwnerAlive(current) !== false || ownedRequests.has(file)) throw buildError('ANALYSIS_REQUEST_OWNER_UNVERIFIED_OR_RUNNING', 409);
      writeAtomicJson(file, { ...current, status: 'completed', executionStatus: archived.executionStatus,
        completedAt: meta.completedAt, recoveredAt: new Date().toISOString(), recoverySource: 'bound-run-archive' });
    });
    return this.getRequest(requestId);
  }

  async cancelRequest(requestId: string): Promise<Record<string, unknown>> {
    const controller = ownedRequests.get(this.requestFile(requestId));
    if (!controller) throw buildError('ANALYSIS_REQUEST_NOT_OWNED / 本服务未持有此作业，不能终止进程', 409);
    controller.abort(new Error('ANALYSIS_REQUEST_CANCELLED'));
    return { requestId, status: 'cancellation_requested' };
  }

  async getRun(id: string): Promise<Record<string, unknown>> {
    return loadAnalysisRun(id);
  }
}

export function createLocalAnalysisEngineClient(
  service = new AnalysisExecutionService(),
): LocalAnalysisEngineClient {
  return {
    async get<T = unknown>(path: string): Promise<{ data: T }> {
      if (path.startsWith('/runs/')) return { data: await service.getRun(decodeURIComponent(path.slice('/runs/'.length))) as T };
      if (path.startsWith('/engines/')) {
        const engineId = decodeURIComponent(path.slice('/engines/'.length));
        return { data: await service.getEngine(engineId) as T };
      }
      const action = LOCAL_GET_ACTION_BY_PATH[path];
      if (!action) {
        throw buildError(`Unsupported local GET path: ${path}`, 400);
      }
      switch (action) {
        case 'list_engines':
          return { data: await service.listEngines() as T };
        default:
          throw buildError(`Unsupported local GET action: ${action}`, 400);
      }
    },
    async post<T = unknown>(path: string, payload: Record<string, unknown> = {}, requestOptions?: ExecutionRequestOptions): Promise<{ data: T }> {
      if (path.startsWith('/engines/') && path.endsWith('/check')) {
        const engineId = decodeURIComponent(path.slice('/engines/'.length, -'/check'.length));
        return { data: await service.checkEngine(engineId) as T };
      }
      if (path.startsWith('/engines/') && path.endsWith('/probe')) {
        const engineId = decodeURIComponent(path.slice('/engines/'.length, -'/probe'.length));
        return { data: await service.probeEngine(engineId) as T };
      }
      const action = LOCAL_POST_ACTION_BY_PATH[path];
      if (!action) {
        throw buildError(`Unsupported local POST path: ${path}`, 400);
      }
      switch (action) {
        case 'analyze':
          return { data: await service.analyze(payload, requestOptions) as T };
        default:
          throw buildError(`Unsupported local POST action: ${action}`, 400);
      }
    },
  };
}
