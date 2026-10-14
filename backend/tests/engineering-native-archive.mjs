// Replays an already completed native response through run storage, never a solver.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { executeAnalysisRun, saveAnalysisRun, loadAnalysisRun } from '../dist/engineering/analysis-runs.js';
import { contentHash } from '../dist/engineering/model-state.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';

const [sourceArgument, resultArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !resultArgument || !outputArgument) throw new Error('Usage: engineering-native-archive.mjs <source-model.json> <completed-native-result.json> <new-output-directory>');
const sourceFile=path.resolve(sourceArgument), resultFile=path.resolve(resultArgument), directory=path.resolve(outputArgument);
assert.ok(!fs.existsSync(directory), 'Output must be a fresh directory');
const bytes=fs.readFileSync(resultFile), native=JSON.parse(bytes.toString('utf8'));
assert.equal(native.nativeResultSet?.schema,'sclaw-native-result-set/v1');
assert.ok(Object.values(native.nativeResultSet.results).every(row => row.success === true));
const model=await normalizeEngineeringModel(JSON.parse(fs.readFileSync(sourceFile,'utf8')),createLocalStructureProtocolClient());
let invokes=0, uncompressedBytes;
const started=performance.now();
const run=await executeAnalysisRun({model,type:'static',engineId:`builtin-${native.nativeContext.engine}`,
  parameters:{},requestId:randomUUID()},async () => {invokes++;return {success:true,data:native};},async (id,record) => {
    uncompressedBytes=Buffer.byteLength(JSON.stringify(record));
    await saveAnalysisRun(id,record,directory);
  });
assert.equal(invokes,1);
assert.equal(run.success,true);
const storedAt=performance.now();
const restored=await loadAnalysisRun(run.runId,directory);
assert.equal(contentHash(restored.results),contentHash(run.results));
assert.equal(contentHash(restored.modelSnapshot),contentHash(model));
assert.equal(restored.requestHash,run.requestHash);
const archiveFile=path.join(directory,run.runId,'run.json.gz'), compressed=fs.readFileSync(archiveFile);
assert.ok(compressed.length < uncompressedBytes);
const receipt={status:'passed',operation:'archive/reload of completed native results; no SDK job or LLM call',runId:run.runId,
  resultKeys:Object.keys(restored.results),uncompressedBytes,compressedBytes:compressed.length,
  reductionPercent:100*(1-compressed.length/uncompressedBytes),
  archiveMs:storedAt-started,reloadAndVerifyMs:performance.now()-storedAt,
  resultsSha256:contentHash(restored.results),
  files:[sourceFile,resultFile,archiveFile].map(file => ({path:file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}))};
fs.writeFileSync(path.join(directory,'acceptance.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt,null,2));
