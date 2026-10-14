import { test, expect } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalysisExecutionService } from '../dist/services/analysis-execution.js';
import { loadAnalysisRun } from '../dist/engineering/analysis-runs.js';

const hostFile = fileURLToPath(new URL('./fixtures/analysis-request-host.mjs', import.meta.url));
async function fixture(body) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sclaw-request-recovery-'));
  let solverCalls = 0;
  const service = new AnalysisExecutionService({ invoke: async () => { solverCalls++; throw new Error('Must never reissue'); } },
    undefined, path.join(directory, 'analysis-requests'), id => loadAnalysisRun(id, path.join(directory, 'runs')));
  try { await body({ directory, service, calls: () => solverCalls }); }
  finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }
}
async function completedHost(directory, mode = 'after-archive') {
  const input = { requestId: randomUUID(), type: 'static', engineId: 'builtin-opensees',
    model: { nodes: [], elements: [], materials: [], sections: [], load_cases: [] }, parameters: {} };
  const inputFile = path.join(directory, `${input.requestId}-input.json`);
  await writeFile(inputFile, JSON.stringify(input));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostFile, inputFile, mode], {
      env: { ...process.env, SCLAW_DATA_DIR: directory }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => code === (mode === 'before-archive' ? 75 : 76) ? resolve() : reject(new Error(`${code}: ${stderr}`)));
  });
  return input;
}

test('a real stopped process recovers its bound archive without rerunning or publishing a current model', async () => fixture(async ({ directory, service, calls }) => {
  const input = await completedHost(directory);
  const inspected = await service.getRequest(input.requestId);
  expect(inspected).toMatchObject({ status: 'outcome_unknown', ownerAlive: false, cancellationAvailable: false });
  expect(inspected.runId).toEqual(expect.any(String));
  await expect(service.analyze(input)).rejects.toThrow('ANALYSIS_REQUEST_OUTCOME_UNKNOWN');
  await expect(service.recoverRequest(input.requestId, '0'.repeat(64))).rejects.toThrow('STATE_CHANGED');
  const restored = await service.recoverRequest(input.requestId, inspected.stateHash);
  expect(restored).toMatchObject({ status: 'completed', executionStatus: 'completed', runId: inspected.runId,
    recoverySource: 'bound-run-archive', requestHash: inspected.requestHash });
  const result = await service.analyze(input);
  expect(result).toMatchObject({ requestId: input.requestId, runId: inspected.runId, data: { marker: 'completed-once' } });
  expect(calls()).toBe(0);
  await expect(service.analyze({ ...input, parameters: { numModes: 2 } })).rejects.toThrow('ID_CONFLICT');
}), 45000);

test('a stopped process with no archive stays unknown and cannot retry through recovery', async () => fixture(async ({ directory, service, calls }) => {
  const input = await completedHost(directory, 'before-archive');
  const inspected = await service.getRequest(input.requestId);
  await expect(service.recoverRequest(input.requestId, inspected.stateHash)).rejects.toThrow('ARCHIVE_UNAVAILABLE');
  expect(await service.getRequest(input.requestId)).toEqual(inspected);
  expect(calls()).toBe(0);
}), 45000);

test('another request archive, modified settings, and a live owner cannot authorize recovery', async () => fixture(async ({ directory, service, calls }) => {
  const first = await completedHost(directory), second = await completedHost(directory);
  const firstRequest = path.join(directory, 'analysis-requests', `${first.requestId}.json`);
  const original = JSON.parse(await readFile(firstRequest, 'utf8'));
  const other = await service.getRequest(second.requestId);
  await writeFile(firstRequest, JSON.stringify({ ...original, runId: other.runId }));
  let inspected = await service.getRequest(first.requestId);
  await expect(service.recoverRequest(first.requestId, inspected.stateHash)).rejects.toThrow('ARCHIVE_MISMATCH');
  await writeFile(firstRequest, JSON.stringify({ ...original, ownerPid: process.pid }));
  inspected = await service.getRequest(first.requestId);
  expect(inspected.status).toBe('running');
  expect(inspected.cancellationAvailable).toBe(false);
  await expect(service.recoverRequest(first.requestId, inspected.stateHash)).rejects.toThrow('OWNER_UNVERIFIED_OR_RUNNING');
  await writeFile(firstRequest, JSON.stringify(original));
  const archiveFile = path.join(directory, 'runs', original.runId, 'run.json');
  const archive = JSON.parse(await readFile(archiveFile, 'utf8'));
  archive.request.parameters.numModes = 2;
  await writeFile(archiveFile, JSON.stringify(archive));
  inspected = await service.getRequest(first.requestId);
  await expect(service.recoverRequest(first.requestId, inspected.stateHash)).rejects.toThrow('RUN_ARCHIVE_INVALID');
  expect((await service.getRequest(first.requestId)).status).toBe('outcome_unknown');
  expect(calls()).toBe(0);
}), 60000);
