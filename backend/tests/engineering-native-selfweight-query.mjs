// Delivery check for the product-owned YJK split-beam selfweight acceptance.
// Reads the completed native job; never launches or modifies the solver project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { queryPhysicalResponse, enrichResultData, resultTableMarkdown, nativeStations } from '../dist/engineering/result-data.js';
import { nativeForceRecovery } from '../dist/engineering/native-force-recovery.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';

const modelPath = path.resolve(process.argv[2]);
const resultPath = path.resolve(process.argv[3]);
const model = await normalizeEngineeringModel(JSON.parse(fs.readFileSync(modelPath, 'utf8')), createLocalStructureProtocolClient());
const native = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
const qWeight = -2500 * .18 * 9.80665 / 1000;
const qExecuted = Number(qWeight.toPrecision(6));
const receipts = [];
for (const id of ['D', 'L']) {
  const data = native.nativeResultSet.results[`case:${id}`].data;
  const result = { success: true, selection: { kind: 'case', id }, data };
  const stations = nativeStations(model, data, 'BX0');
  nativeForceRecovery(model, data, 'BX0', stations.rows, stations.length, { [id]: 1 });
  const anchor = data.memberStations.BX0.find(row => row.positionM === 0 && row.side === 'right').components;
  assert.equal(data.nativeContext.effectiveLoads.selfWeight.loadCaseId, 'D');
  const qs = data.nativeContext.effectiveLoads.selfWeight.physicalCompilation.filter(row => row.physicalElementId === 'BX0');
  assert.equal(qs.length, 4);
  for (const q of qs) assert.ok(Math.abs(q.intensityVectorKnM[2] - qWeight) < 1e-12);
  const executed = data.nativeContext.effectiveLoads.selfWeight.executedCompilation.filter(row => row.physicalElementId === 'BX0');
  assert.equal(executed.length, 4);
  for (const q of executed) assert.ok(Math.abs(q.intensityVectorKnM[2] - qExecuted) < 1e-12);
  for (const x of [.731, 1.234, 1.7, 2.431, 3.711, 5.237]) for (const side of ['left', 'right']) {
    const response = queryPhysicalResponse(model, result, 'BX0', x, side);
    const q = id === 'D' ? qExecuted : -10;
    const patchLength = Math.max(0, Math.min(x, 3.5) - 1);
    const patch = id === 'D' ? -7 : 0;
    const point = id === 'D' && (x > 1.7 || x === 1.7 && side === 'right') ? -5 : 0;
    const expected = { Vz: anchor.Vz + q*x + patch*patchLength + point,
      My: anchor.My - anchor.Vz*x - q*x*x/2 - patch*patchLength*(x-1-patchLength/2) - point*(x-1.7) };
    for (const [component, value] of Object.entries(expected)) assert.ok(Math.abs(response.sample[component] - value) <= Math.max(1e-5, 1e-5*Math.abs(value)), `${id} ${x} ${side} ${component}`);
    if (x !== 1.7) assert.equal(response.provenance, 'mechanics-recovery');
    receipts.push({ case: id, positionM: x, side, Vz: response.sample.Vz, My: response.sample.My });
  }
  const enriched = enrichResultData(model, result, result.selection);
  assert.ok(enriched.memberResponses.find(row => row.id === 'BX0').samples.some(row => row.provenance === 'mechanics-recovery'));
  const report = resultTableMarkdown({ runId: 'native-selfweight-delivery', results: { [`case:${id}`]: { ...result, data: enriched } } }, 'en');
  assert.ok(report.includes(`| case:${id} | M2 |`));
}
console.log(JSON.stringify({ status: 'passed', modelPath, resultPath,
  resultSha256: createHash('sha256').update(fs.readFileSync(resultPath)).digest('hex'),
  checks: ['native selfweight and explicit loads', 'split physical member', 'case isolation', 'left/right point jump', 'queries/charts/report'], receipts }, null, 2));
