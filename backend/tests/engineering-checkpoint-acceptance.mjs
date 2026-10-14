// Persist an existing run through checkpoints and reload in a fresh process; no solver or LLM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { performance } from 'node:perf_hooks';
import { AIMessage } from '@langchain/core/messages';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { FileCheckpointer } from '../dist/agent-langgraph/file-checkpointer.js';
import { loadAnalysisRun } from '../dist/engineering/analysis-runs.js';
import { contentHash } from '../dist/engineering/model-state.js';

const [archiveArgument, runId, outputArgument, operation] = process.argv.slice(2);
if (!archiveArgument || !runId || !outputArgument) throw new Error('Usage: engineering-checkpoint-acceptance.mjs <archive-directory> <run-id> <new-output-directory>');
const archiveDirectory=path.resolve(archiveArgument), directory=path.resolve(outputArgument);
const config={configurable:{thread_id:'native-history',checkpoint_ns:''}};
const run=await loadAnalysisRun(runId,archiveDirectory);
assert.equal(run.success,true);
assert.ok(Object.keys(run.results).length > 1,'This acceptance needs a real multi-result run');

if(operation === 'read') {
  const started=performance.now();
  const saver=new FileCheckpointer(directory);
  const tuple=await saver.getTuple(config);
  assert.equal(tuple.checkpoint.id,'native-2');
  assert.equal(contentHash(tuple.checkpoint.channel_values.analysisRuns[runId]),contentHash(run));
  assert.equal(contentHash(tuple.pendingWrites[0][2]),contentHash(run));
  assert.equal(tuple.checkpoint.channel_values.message.getType(),'ai');
  assert.equal(tuple.checkpoint.channel_values.message.content,'native step 2');
  assert.equal(tuple.metadata.step,2);
  const entries=[];
  for await(const item of saver.list(config)) {
    assert.equal(contentHash(item.checkpoint.channel_values.analysisRuns[runId]),contentHash(run));
    entries.push(item.checkpoint.id);
  }
  assert.deepEqual(entries,['native-2','native-1','native-0']);
  console.log(JSON.stringify({status:'passed',operation:'fresh-process checkpoint reload',
    resultKeys:Object.keys(run.results),runSha256:contentHash(run),entries,readAndVerifyMs:performance.now()-started}));
} else {
  assert.equal(operation,undefined);
  assert.ok(!fs.existsSync(directory),'Output must be a fresh directory');
  const saver=new FileCheckpointer(directory), started=performance.now();
  let saved=config, rawCheckpointBytes=0;
  for(let i=0;i<3;i++) {
    const checkpoint={...emptyCheckpoint(),id:`native-${i}`,ts:`2026-10-14T04:00:0${i}.000Z`,
      channel_values:{analysisRuns:{[runId]:run},message:new AIMessage(`native step ${i}`)}};
    const [,bytes]=await saver.serde.dumpsTyped(checkpoint);
    rawCheckpointBytes+=bytes.length;
    saved=await saver.put(saved,checkpoint,{source:'update',step:i,parents:{}},{});
  }
  await saver.putWrites(saved,[['analysisRun',run]],'completed-native-run');
  const checkpointDirectory=path.join(directory,'checkpoints','native-history');
  const compressedCheckpointBytes=fs.readdirSync(checkpointDirectory)
    .reduce((sum,name)=>sum+fs.statSync(path.join(checkpointDirectory,name)).size,0);
  assert.ok(compressedCheckpointBytes<rawCheckpointBytes);
  const writeMs=performance.now()-started;
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),archiveDirectory,runId,directory,'read'],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr || child.stdout);
  const readback=JSON.parse(child.stdout.trim());
  const receipt={status:'passed',operation:'real archived run through checkpoint storage and process restart; no SDK or LLM call',
    runId,archiveDirectory,rawCheckpointBytes,compressedCheckpointBytes,
    reductionPercent:100*(1-compressedCheckpointBytes/rawCheckpointBytes),writeMs,readback};
  fs.writeFileSync(path.join(directory,'acceptance.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(receipt,null,2));
}
