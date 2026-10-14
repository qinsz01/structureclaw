import { test, expect, afterEach, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { AIMessage } from '@langchain/core/messages';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { emptyCheckpoint, INTERRUPT, RESUME } from '@langchain/langgraph-checkpoint';
import { FileCheckpointer } from '../dist/agent-langgraph/file-checkpointer.js';

const roots = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sclaw-checkpoint-'));
  roots.push(root);
  return { root, saver: new FileCheckpointer(root) };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('sclaw-checkpoint-')) throw new Error('Invalid fixture root');
    await fs.rm(root, { recursive: true, force: true });
  }
});
const config = { configurable: { thread_id: 'conversation' } };
const metadata = { source: 'loop', step: 1, parents: {} };

test('real process restart preserves clarification and never repeats a committed model write', async () => {
  const { root } = await fixture();
  const script = fileURLToPath(new URL('./fixtures/checkpoint-process.mjs', import.meta.url));
  for (const phase of ['pause', 'resume', 'inspect']) {
    const result = spawnSync(process.execPath, [script, phase, root], {
      env: { ...process.env, SCLAW_DATA_DIR: root }, encoding: 'utf8', timeout: 60000, windowsHide: true,
    });
    expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
    expect(result.stdout).toContain('"committedWrites":1');
  }
}, 180000);

test('nested graph interrupts survive a new saver without namespace collisions', async () => {
  const { root } = await fixture();
  const State = Annotation.Root({ value: Annotation() });
  const build = () => {
    const child = new StateGraph(State).addNode('ask', () => ({ value: interrupt('child confirmation') }))
      .addEdge(START, 'ask').addEdge('ask', END).compile();
    return new StateGraph(State).addNode('child', child).addEdge(START, 'child').addEdge('child', END)
      .compile({ checkpointer: new FileCheckpointer(root) });
  };
  expect((await build().invoke({ value: 'draft' }, config)).__interrupt__).toHaveLength(1);
  expect((await build().invoke(new Command({ resume: 'confirmed' }), config)).value).toBe('confirmed');
});

test('pending write indices merge retries and special channels without erasing successful writes', async () => {
  const { root, saver } = await fixture();
  const saved = await saver.put(config, emptyCheckpoint(), metadata, {});
  const message = new AIMessage('retained');
  await saver.putWrites(saved, [['messages', message]], 'task');
  await Promise.all([
    saver.putWrites(saved, [['messages', new AIMessage('duplicate')]], 'task'),
    saver.putWrites(saved, [[INTERRUPT, [{ value: 'question', id: 'interrupt' }]]], 'task'),
    saver.putWrites(saved, [[RESUME, ['confirmed']]], 'task'),
  ]);
  const fresh = new FileCheckpointer(root);
  const tuple = await fresh.getTuple(saved);
  expect(tuple.pendingWrites).toHaveLength(3);
  expect(tuple.pendingWrites.find(([, channel]) => channel === 'messages')[2].getType()).toBe('ai');
  expect(tuple.pendingWrites.find(([, channel]) => channel === 'messages')[2].content).toBe('retained');
  const listed = []; for await (const entry of fresh.list(config)) listed.push(entry);
  expect(listed[0].pendingWrites).toEqual(tuple.pendingWrites);
  expect((await fs.readdir(path.join(root, 'writes/conversation', tuple.checkpoint.id))).some(file => file.endsWith('.tmp'))).toBe(false);
});

test('legacy JSON checkpoints and task writes remain readable, including message identity', async () => {
  const { root, saver } = await fixture();
  const checkpoint = emptyCheckpoint();
  checkpoint.channel_values = { message: new AIMessage('legacy model') };
  const encode = async value => { const [, data] = await saver.serde.dumpsTyped(value); return Buffer.from(data).toString('utf8'); };
  await fs.mkdir(path.join(root, 'checkpoints/conversation'), { recursive: true });
  await fs.mkdir(path.join(root, 'writes/conversation', checkpoint.id), { recursive: true });
  await fs.writeFile(path.join(root, 'checkpoints/conversation', `${checkpoint.id}.json`), JSON.stringify({ checkpoint: await encode(checkpoint), metadata: await encode(metadata) }));
  await fs.writeFile(path.join(root, 'writes/conversation', checkpoint.id, 'task.json'), JSON.stringify([[INTERRUPT, await encode([{ value: 'legacy question' }])]]));
  const tuple = await saver.getTuple(config);
  expect(tuple.checkpoint.channel_values.message.getType()).toBe('ai');
  expect(tuple.pendingWrites[0][2][0].value).toBe('legacy question');
});

test('namespace, chronological history, before and metadata filters are preserved', async () => {
  const { saver } = await fixture();
  const first = { ...emptyCheckpoint(), id: 'z-old', ts: '2026-10-13T00:00:00.000Z' };
  const last = { ...emptyCheckpoint(), id: 'a-new', ts: '2026-10-14T00:00:00.000Z' };
  const saved = await saver.put(config, first, metadata, {});
  const current = await saver.put(saved, last, { ...metadata, step: 2 }, {});
  const nested = { configurable: { ...config.configurable, checkpoint_ns: 'child:abc|nested:123' } };
  await saver.put(nested, { ...last, channel_values: { nested: true } }, metadata, {});
  expect((await saver.getTuple(config)).checkpoint.id).toBe('a-new');
  expect((await saver.getTuple(nested)).checkpoint.channel_values.nested).toBe(true);
  const listed = []; for await (const entry of saver.list(config, { before: current, filter: { step: 1 }, limit: 1 })) listed.push(entry);
  expect(listed.map(entry => entry.checkpoint.id)).toEqual(['z-old']);
  expect((await saver.getTuple(current)).parentConfig).toEqual(saved);
});

test('corruption and unsafe explicit identities fail instead of silently losing history', async () => {
  const { root, saver } = await fixture();
  const saved = await saver.put(config, emptyCheckpoint(), metadata, {});
  await expect(saver.getTuple({ configurable: { ...config.configurable, checkpoint_id: '../../outside' } })).rejects.toThrow('Invalid checkpoint_id');
  const id = saved.configurable.checkpoint_id;
  await fs.mkdir(path.join(root, 'writes/conversation', id), { recursive: true });
  await fs.writeFile(path.join(root, 'writes/conversation', id, 'task.json'), '{partial');
  await expect(saver.getTuple(config)).rejects.toThrow('CHECKPOINT_READ_FAILED');
  await fs.writeFile(path.join(root, 'checkpoints/conversation', `${id}.json`), '{partial');
  await expect(saver.getTuple(config)).rejects.toThrow('CHECKPOINT_READ_FAILED');
});

test('large engineering state and pending messages survive lossless compression and only the selected state is deserialized', async () => {
  const { root, saver } = await fixture();
  const responses=Array.from({length:2000},(_,i)=>({elementId:`beam-${i}`,x:i/357,force:-i/91,
    displacement:[i/7331,-i/3111,i/8191],source:{kind:'native',caseId:'D'}}));
  // Compare to the existing JSON serializer semantics (including -0 -> 0).
  const expectedResponses=JSON.parse(JSON.stringify(responses));
  let saved;
  for(let i=0;i<4;i++) {
    const checkpoint={...emptyCheckpoint(),id:`step-${i}`,ts:`2026-10-14T01:00:0${i}.000Z`,
      channel_values:{analysisRuns:{run:{responses}},message:new AIMessage(`step ${i}`)}};
    saved=await saver.put(saved??config,checkpoint,{...metadata,step:i},{});
  }
  await saver.putWrites(saved,[['analysisResult',{responses}]],'pending-result');
  const file=path.join(root,'checkpoints/conversation',`${saved.configurable.checkpoint_id}.json`);
  const stored=JSON.parse(await fs.readFile(file,'utf8'));
  expect(stored.checkpoint.encoding).toBe('gzip-base64');
  expect((await fs.stat(file)).size).toBeLessThan(JSON.stringify(responses).length*.6);
  const fresh=new FileCheckpointer(root);
  const loads=jest.spyOn(fresh.serde,'loadsTyped');
  try {
    const tuple=await fresh.getTuple(config);
    expect(tuple.checkpoint.channel_values.analysisRuns.run.responses).toEqual(expectedResponses);
    expect(tuple.checkpoint.channel_values.message.getType()).toBe('ai');
    expect(tuple.checkpoint.channel_values.message.content).toBe('step 3');
    expect(tuple.pendingWrites[0][2]).toEqual({responses:expectedResponses});
    // Checkpoint, metadata and one pending write only; no previous engineering states.
    expect(loads).toHaveBeenCalledTimes(3);
  } finally { loads.mockRestore(); }
});

test('typed historical base64 remains readable alongside compressed indexed checkpoints', async () => {
  const { root, saver }=await fixture();
  const checkpoint={...emptyCheckpoint(),id:'old-typed',ts:'2026-10-13T01:00:00.000Z',channel_values:{message:new AIMessage('old typed')}};
  const encode=async value=>{const [type,bytes]=await saver.serde.dumpsTyped(value);return {type,data:Buffer.from(bytes).toString('base64')};};
  const directory=path.join(root,'checkpoints/conversation');await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'old-typed.json'),JSON.stringify({checkpoint:await encode(checkpoint),metadata:await encode(metadata)}));
  await saver.put(config,{...emptyCheckpoint(),id:'new-indexed',ts:'2026-10-14T01:00:00.000Z'},metadata,{});
  expect((await saver.getTuple(config)).checkpoint.id).toBe('new-indexed');
  expect((await saver.getTuple({configurable:{...config.configurable,checkpoint_id:'old-typed'}})).checkpoint.channel_values.message.content).toBe('old typed');
});

test.each(['timestamp','payload'])('a corrupted %s cannot make an indexed checkpoint silently select older history', async defect=>{
  const {root,saver}=await fixture();
  await saver.put(config,{...emptyCheckpoint(),id:'older',ts:'2026-10-13T01:00:00.000Z'},metadata,{});
  const saved=await saver.put(config,{...emptyCheckpoint(),id:'current',ts:'2026-10-14T01:00:00.000Z',channel_values:{text:'large'.repeat(20000)}},metadata,{});
  const file=path.join(root,'checkpoints/conversation/current.json');const stored=JSON.parse(await fs.readFile(file,'utf8'));
  if(defect==='timestamp')stored.identity.ts='2026-10-12T01:00:00.000Z';
  else stored.checkpoint.data=stored.checkpoint.data.slice(0,-8);
  await fs.writeFile(file,JSON.stringify(stored));
  await expect(saver.getTuple(config)).rejects.toThrow('CHECKPOINT_IDENTITY_INVALID');
  await expect(saver.getTuple(saved)).rejects.toThrow('CHECKPOINT_IDENTITY_INVALID');
});
