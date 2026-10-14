// Real HTTP and OpenSees acceptance against product-owned closed-form references.
// No model-provider calls. Build backend first; set SCLAW_DATA_DIR to the test runtime.
import assert from 'node:assert/strict';
import { model as raw, reference } from './fixtures/cantilever-reference.mjs';
import Fastify from 'fastify';
import { analysisRuntimeRoutes } from '../dist/api/analysis-runtime.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { modelHash } from '../dist/engineering/model-state.js';
import { analysisSettingsHash } from '../dist/engineering/analysis-runs.js';
import { createQueryResultsTool } from '../dist/agent-langgraph/model-tools.js';

const model = await normalizeEngineeringModel(raw, createLocalStructureProtocolClient());
const payload = { type:'static', engineId:'builtin-opensees', model, parameters:{} };
payload.requestBinding = { modelRevision:1, modelHash:modelHash(model),
  settingsHash:analysisSettingsHash(payload.type, payload.engineId, payload.parameters), requestSequence:1 };
const app = Fastify({ logger:false });
await app.register(analysisRuntimeRoutes);
const url = await app.listen({ host:'127.0.0.1', port:0 });
try {
  const response = await fetch(`${url}/analyze`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  assert.equal(response.status, 200);
  const run = await response.json();
  assert.equal(run.success, true, JSON.stringify(run));
  for (const [key,value] of Object.entries(payload.requestBinding)) assert.equal(run.meta[key], value);
  const archivedResponse = await fetch(`${url}/runs/${run.runId}`);
  assert.equal(archivedResponse.status, 200);
  const archived = await archivedResponse.json();
  assert.deepEqual(archived.results, run.results);
  assert.equal(modelHash(archived.modelSnapshot), payload.requestBinding.modelHash);
  for (const q of reference.quantities) {
    const resultKey = `${q.selection.kind}:${q.selection.id}`;
    const input = { runId:run.runId, resultKey, quantityId:q.id, component:q.component, unit:q.unit,
      ...(q.location.kind === 'member' ? { elementId:q.location.id, positionM:q.location.positionM, side:q.location.side }
        : { nodeId:q.location.id, field:q.component.startsWith('u') || q.component.startsWith('r') ? 'displacements' : 'reactions' }) };
    const queried = await createQueryResultsTool().invoke(input, { toolCall:{id:q.id}, configurable:{agentState:{}} });
    const actual = Object.values(queried.update.resultQuantities)[0].value;
    assert.ok(Number.isFinite(actual) && Math.abs(actual-q.value) <= q.tolerance.absolute+q.tolerance.relative*Math.abs(q.value), `${q.id}: ${actual} != ${q.value}`);
  }
  console.log(JSON.stringify({ status:'passed', interface:'real HTTP + archived tool query', case:'analytic-cantilever-D-L-U',
    runId:run.runId, queriedQuantities:reference.quantities.length, requestBinding:payload.requestBinding,
    checks:['HTTP preserves request binding','native OpenSees','archive roundtrip','independent station/side/unit values'] }, null, 2));
} finally { await app.close(); }
