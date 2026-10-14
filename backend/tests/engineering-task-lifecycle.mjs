// Real SQLite compare-and-set acceptance. Solver scheduling is controlled here;
// native numerical execution is covered by engineering-http-acceptance.mjs.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { model } from './fixtures/cantilever-reference.mjs';

const runtime = await mkdtemp(path.join(os.tmpdir(), 'sclaw-task-cas-'));
process.env.SCLAW_DATA_DIR = runtime;
process.env.DATABASE_URL = `file:${path.join(runtime, 'data', 'structureclaw.db')}`;
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const initialized = spawnSync(process.execPath, ['scripts/sync-sqlite-schema.mjs'], {cwd:backend,env:process.env,encoding:'utf8'});
assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
const { prisma } = await import('../dist/utils/database.js');
const { AnalysisService } = await import('../dist/services/analysis.js');
const { executeAnalysisRun, loadAnalysisRun } = await import('../dist/engineering/analysis-runs.js');
try {
  const conversation = await prisma.conversation.create({data:{title:'Own lifecycle reference',type:'engineering'}});
  const physical = await prisma.structuralModel.create({data:{name:'Own beam reference',conversationId:conversation.id,
    nodes:model.nodes,elements:model.elements,materials:model.materials,sections:model.sections,
    physicalModel:model,coordinateSystem:model.coordinate_system}});
  const service = new AnalysisService();
  const task = await service.createAnalysisTask({name:'CAS lifecycle',type:'static',modelId:physical.id,parameters:{},engineId:'builtin-opensees'});
  let finish, entered, calls=0, archivedId;
  const started = new Promise(resolve => { entered=resolve; });
  const barrier = new Promise(resolve => { finish=resolve; });
  service.executionService.analyze = async payload => {
    calls++; entered(); await barrier;
    const run = await executeAnalysisRun(payload,async () => ({success:true,data:{}}));
    archivedId=run.runId; return run;
  };
  const pending = service.runAnalysis(task.id);
  await started;
  await assert.rejects(service.runAnalysis(task.id), /ANALYSIS_TASK_RUNNING_OR_CHANGED/);
  const running = await prisma.analysis.findUnique({where:{id:task.id}});
  assert.equal(running.status,'running'); assert.ok(running.results.requestId);
  await prisma.structuralModel.update({where:{id:physical.id},data:{physicalModel:{...model,name:'edited while running'}}});
  finish();
  await assert.rejects(pending,/ANALYSIS_RUN_SUPERSEDED/);
  assert.equal(calls,1);
  assert.equal((await loadAnalysisRun(archivedId)).success,true);
  const superseded = await prisma.analysis.findUnique({where:{id:task.id}});
  assert.equal(superseded.status,'failed');
  assert.equal(superseded.results.requestId,running.results.requestId);
  assert.equal(superseded.results.runId,undefined);
  service.executionService.analyze = payload => executeAnalysisRun(payload,async () => ({success:true,data:{}}));
  const completed = await service.runAnalysis(task.id);
  assert.equal(completed.status,'completed'); assert.ok(completed.results.runId);
  assert.notEqual(completed.results.runId,archivedId);
  console.log(JSON.stringify({status:'passed',checks:['real SQLite claim','no duplicate launch','changed input rejects late publication','historical run retained','explicit new run succeeds']}));
} finally {
  await prisma.$disconnect();
  if (path.dirname(path.resolve(runtime)) !== path.resolve(os.tmpdir()) || !path.basename(runtime).startsWith('sclaw-task-cas-')) throw new Error('Unsafe cleanup');
  await rm(runtime,{recursive:true,force:true});
}
