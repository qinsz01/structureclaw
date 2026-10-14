import { test, expect } from '@jest/globals';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { runAgent } = createRequire(import.meta.url)('../../scripts/cli/run-agent.js');
const { analysisJob } = createRequire(import.meta.url)('../../scripts/cli/analysis-job.js');

test('CLI job actions inspect or settle the exact request without reanalysis or implicit recovery', async () => {
  const id = '05a02a2c-5ab2-4564-a773-36d84e87c3fa';
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.href, ...options });
    return { ok: true, json: async () => ({ requestId: id, status: 'outcome_unknown', stateHash: 'a'.repeat(64) }) };
  };
  await analysisJob(['status', id], { PORT: '5432' }, fetchImpl);
  expect(calls[0]).toEqual({ url: `http://127.0.0.1:5432/analysis-requests/${id}`, method: 'GET' });
  await expect(analysisJob(['recover', id], {}, fetchImpl)).rejects.toThrow('Usage');
  expect(calls).toHaveLength(1);
  await analysisJob(['recover', id, '--state-hash', 'a'.repeat(64)], {}, fetchImpl);
  expect(calls[1].url).toBe(`http://127.0.0.1:31415/analysis-requests/${id}/recover`);
  expect(JSON.parse(calls[1].body)).toEqual({ expectedStateHash: 'a'.repeat(64) });
  await analysisJob(['cancel', id], {}, fetchImpl);
  expect(calls[2].url.endsWith('/cancel')).toBe(true);
  let attempts = 0;
  await expect(analysisJob(['recover', id, '--state-hash', 'a'.repeat(64)], {}, async () => {
    attempts++; throw new Error('response lost');
  })).rejects.toThrow('response lost');
  expect(attempts).toBe(1);
});

test('CLI forwards the shared HTTP contract without hidden retry or policy defaults', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'sclaw-cli-request-'));
  const request = {message:'Calculate',conversationId:'c',context:{runPolicy:{skillIds:[],repair:{enabled:false}},model:{id:'source'}}};
  const file=path.join(dir,'request.json');
  await writeFile(file,JSON.stringify(request));
  try {
    let calls=0;
    const response = await runAgent(['--request',file],{PORT:'4321'},async (url,options) => {
      calls++;
      expect(url.href).toBe('http://127.0.0.1:4321/api/v1/agent/run');
      expect(JSON.parse(options.body)).toEqual(request);
      return {ok:true,json:async()=>({effectiveRunPolicy:{skillIds:[],repair:{enabled:false}}})};
    });
    expect(calls).toBe(1);
    expect(response.effectiveRunPolicy.skillIds).toEqual([]);
    calls=0;
    await expect(runAgent(['--request',file],{},async(url)=>{calls++;expect(url.port).toBe('31415');throw new Error('response lost')})).rejects.toThrow('response lost');
    expect(calls).toBe(1);
  } finally {
    if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('sclaw-cli-request-')) throw new Error('Invalid fixture directory');
    await rm(dir,{recursive:true,force:true});
  }
});
