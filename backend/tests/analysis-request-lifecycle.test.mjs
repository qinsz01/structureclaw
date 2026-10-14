import { test, expect } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnalysisExecutionService } from '../dist/services/analysis-execution.js';

async function fixture(body) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'sclaw-requests-'));
  try { await body(dir); } finally {
    if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('sclaw-requests-')) throw new Error('Unsafe test directory');
    await rm(dir,{recursive:true,force:true});
  }
}
const payload = requestId => ({requestId,type:'static',engineId:'builtin-opensees',
  model:{nodes:[],elements:[],materials:[],sections:[],load_cases:[]},parameters:{}});

test('duplicate and lost-response analysis requests never submit the same job again', async()=>fixture(async dir=>{
  const archives=new Map(); let calls=0, finish, entered;
  const ready=new Promise(resolve=>{entered=resolve});
  const service=new AnalysisExecutionService({invoke:async()=>{calls++;entered();await new Promise(resolve=>{finish=resolve});return {success:true,data:{}}}},
    async(id,record)=>archives.set(id,record),dir,async id=>archives.get(id));
  const input=payload(randomUUID());
  const pending=service.analyze(input); await ready;
  expect((await service.getRequest(input.requestId)).status).toBe('running');
  await expect(service.analyze(input)).rejects.toThrow('ANALYSIS_REQUEST_RUNNING');
  await expect(service.analyze({...input,parameters:{numModes:2}})).rejects.toThrow('ANALYSIS_REQUEST_ID_CONFLICT');
  finish();const first=await pending;
  const replay=await service.analyze(input);
  expect(replay.runId).toBe(first.runId);expect(calls).toBe(1);
}));

test('cancellation only signals a worker owned by this service and unknown jobs cannot restart', async()=>fixture(async dir=>{
  let entered;const ready=new Promise(resolve=>{entered=resolve});
  const service=new AnalysisExecutionService({invoke:async(_request,options)=>{entered();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))}},
    async()=>{},dir);
  const input=payload(randomUUID());const pending=service.analyze(input);await ready;
  expect((await service.cancelRequest(input.requestId)).status).toBe('cancellation_requested');
  await pending;
  expect((await service.getRequest(input.requestId)).status).toBe('cancelled');
  await expect(service.cancelRequest(input.requestId)).rejects.toThrow('NOT_OWNED');
  const orphan=randomUUID();
  await writeFile(path.join(dir,`${orphan}.json`),JSON.stringify({requestId:orphan,status:'running',ownerPid:1234}));
  expect(await service.getRequest(orphan)).toMatchObject({status:'outcome_unknown',cancellationAvailable:false});
  await expect(service.cancelRequest(orphan)).rejects.toThrow('NOT_OWNED');
}));
