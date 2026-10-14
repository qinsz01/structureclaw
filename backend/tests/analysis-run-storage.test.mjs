import { test, expect } from '@jest/globals';
import { mkdtemp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { executeAnalysisRun, saveAnalysisRun, loadAnalysisRun } from '../dist/engineering/analysis-runs.js';

async function inDirectory(body) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sclaw-run-storage-'));
  try { await body(directory); }
  finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('sclaw-run-storage-')) throw new Error('Unsafe cleanup');
    await rm(directory, {recursive:true,force:true});
  }
}

function payload() {
  return { type:'static',engineId:'builtin-yjk',parameters:{},requestId:randomUUID(),model:{
    nodes:[],elements:[],materials:[],sections:[],load_cases:[{id:'D',loads:[]},{id:'L',loads:[]}] } };
}
function nativeResponse() {
  const raw = {source:'official-readback',signed:Array.from({length:250},(_,i) => ({node:`n${i}`,force:-i/1000,rotation:i/30000}))};
  return {success:true,meta:{engineId:'builtin-yjk'},data:{nativeResultSet:{schema:'sclaw-native-result-set/v1',results:
    Object.fromEntries(['D','L'].map((id,i) => [`case:${id}`,{success:true,data:{selectedResult:{kind:'case',id},
      displacements:{n1:{uz:-(i+1)/1000}}, nativeDesignResults:raw, nativeContext:{settingsHash:'frozen'}}}]))}}};
}

test('compressed immutable runs retain every signed case, source and request on reload', async () => inDirectory(async directory => {
  const input = payload(), native = nativeResponse(), before = structuredClone(native);
  let recorded, calls = 0;
  const run = await executeAnalysisRun(input, async () => {calls++;return native;}, async (id, record) => {
    recorded=record; await saveAnalysisRun(id,record,directory);
  });
  const compressed = await readFile(path.join(directory,run.runId,'run.json.gz'));
  expect(await readdir(path.join(directory,run.runId))).toEqual(['run.json.gz']);
  expect(JSON.parse(gunzipSync(compressed))).toEqual(JSON.parse(JSON.stringify(recorded)));
  expect(compressed.length).toBeLessThan(JSON.stringify(recorded).length/3);
  const restored = await loadAnalysisRun(run.runId,directory);
  expect(restored.results).toEqual(JSON.parse(JSON.stringify(run.results)));
  expect(restored.modelSnapshot).toEqual(input.model);
  expect(restored.requestId).toBe(input.requestId);
  expect(restored.requestHash).toBe(run.requestHash);
  expect(restored.data.displacements.n1.uz).toBe(-.001);
  expect(restored.results['case:L'].data.displacements.n1.uz).toBe(-.002);
  expect(native).toEqual(before); expect(calls).toBe(1);
  await expect(saveAnalysisRun(run.runId,recorded,directory)).rejects.toThrow();
  expect(await readFile(path.join(directory,run.runId,'run.json.gz'))).toEqual(compressed);
  await expect(saveAnalysisRun('../escaped',recorded,directory)).rejects.toThrow('RUN_ID_INVALID');
}));

test('historical JSON stays readable and cannot be silently replaced by a compressed run', async () => inDirectory(async directory => {
  let record;
  const run = await executeAnalysisRun(payload(),async () => nativeResponse(),async (_id,value) => {record=value;});
  const folder=path.join(directory,run.runId); await mkdir(folder);
  const bytes=JSON.stringify(record,null,2); await writeFile(path.join(folder,'run.json'),bytes);
  expect((await loadAnalysisRun(run.runId,directory)).results).toEqual(JSON.parse(JSON.stringify(run.results)));
  await expect(saveAnalysisRun(run.runId,record,directory)).rejects.toThrow();
  expect(await readFile(path.join(folder,'run.json'),'utf8')).toBe(bytes);
}));

test('truncation and ambiguous archives fail instead of starting another calculation', async () => inDirectory(async directory => {
  let record;
  const run = await executeAnalysisRun(payload(),async () => nativeResponse(),async (id,value) => {record=value;await saveAnalysisRun(id,value,directory);});
  const folder=path.join(directory,run.runId), file=path.join(folder,'run.json.gz');
  const bytes=await readFile(file);
  await writeFile(file,bytes.subarray(0,bytes.length/2));
  await expect(loadAnalysisRun(run.runId,directory)).rejects.toThrow();
  await writeFile(file,bytes); await writeFile(path.join(folder,'run.json'),JSON.stringify(record));
  await expect(loadAnalysisRun(run.runId,directory)).rejects.toThrow('RUN_ARCHIVE_AMBIGUOUS');
  await expect(loadAnalysisRun(randomUUID(),directory)).rejects.toThrow('RUN_NOT_FOUND');
}));
