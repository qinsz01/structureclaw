// Independent capability probe, not a Bench task or answer. No model-provider calls.
// +X cantilever with a +My point couple: uz=-M*x²/(2EI) before a,
// uz=-M*a*(x-a/2)/(EI) after a, and Ry=M*min(x,a)/(EI).
import assert from 'node:assert/strict';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { AnalysisExecutionService } from '../dist/services/analysis-execution.js';
import { beginAnalysisRequest, commitModel, publishAnalysis } from '../dist/engineering/model-state.js';
import { analysisSettingsHash } from '../dist/engineering/analysis-runs.js';
import { createEditModelTool, createUndoModelTool, createQueryResultsTool } from '../dist/agent-langgraph/model-tools.js';
import { applyPublicToolStateUpdate } from '../dist/agent-langgraph/public-tool-contracts.js';
import { resultTableMarkdown } from '../dist/engineering/result-data.js';

const client = createLocalStructureProtocolClient();
const close = (actual, expected) => assert.ok(Number.isFinite(actual)
  && Math.abs(actual - expected) <= 1e-10 + 1e-8 * Math.abs(expected), `${actual} != ${expected}`);
const model = await normalizeEngineeringModel({
  schema_version: '2.2.0', unit_system: 'SI', coordinate_system: { dimension: '2d', plane: 'xz',
    semantics: 'global-z-up', version: 1, dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] },
  nodes: [{ id: 'base', x: 0, y: 0, z: 0, restraints: [true, true, true, true, true, true] },
    { id: 'tip', x: 6, y: 0, z: 0, restraints: [false, true, false, true, false, true] }],
  elements: [{ id: 'beam', type: 'beam', nodes: ['base', 'tip'], material: 'm', section: 's' }],
  materials: [{ id: 'm', name: 'Explicit elastic material', category: 'steel', E: 200000, nu: .3, rho: 7850 }],
  sections: [{ id: 's', name: 'Numerical section', type: 'custom', properties: { A: .02, Iy: .0001, Iz: .0002, J: .00005 } }],
  load_cases: [{ id: 'D', type: 'dead', loads: [{ id: 'couple', type: 'point', element: 'beam', position: 2, my: 20 }] }],
  load_combinations: [{ id: 'U', factors: { D: 1.5 } }], analysis_control: { self_weight: false },
}, client);
let state = { ...commitModel(undefined, model, 'initial'), analysisRuns: {}, resultQuantities: {} };
const invoke = async (tool, input) => {
  const response = await tool.invoke(input, { toolCall: { id: 'acceptance' },
    configurable: { agentState: state, structureProtocolClient: client } });
  if (response.update) state = applyPublicToolStateUpdate(state, response.update);
  return response;
};
const solve = async () => {
  state = { ...state, ...beginAnalysisRequest(state, analysisSettingsHash('static', 'builtin-opensees', {})) };
  const run = await new AnalysisExecutionService().analyze({ model: state.model, type: 'static', engineId: 'builtin-opensees',
    parameters: {}, requestBinding: state.analysisRequest });
  assert.equal(run.success, true, JSON.stringify(run));
  state = applyPublicToolStateUpdate(state, publishAnalysis(state, state.analysisRequest, run));
  return run;
};
const first = await solve();
const quantities = [
  ['before', { elementId: 'beam', positionM: 1.234, component: 'uz', unit: 'm' }, -.000761378],
  ['couple-left', { elementId: 'beam', positionM: 2, side: 'left', component: 'M2', unit: 'kN.m' }, 20],
  ['couple-right', { elementId: 'beam', positionM: 2, side: 'right', component: 'M2', unit: 'kN.m' }, 0],
  ['after', { elementId: 'beam', positionM: 4.321, component: 'uz', unit: 'm' }, -.006642],
  ['tip-rotation', { nodeId: 'tip', field: 'displacements', component: 'ry', unit: 'rad' }, .002],
  ['base-moment', { nodeId: 'base', field: 'reactions', component: 'my', unit: 'kN.m' }, -20],
];
for (const [id, query, expected] of quantities) {
  await invoke(createQueryResultsTool(), { resultKey: 'case:D', quantityId: id, ...query });
  close(state.resultQuantities[`${first.runId}:${id}`].value, expected);
}
await invoke(createQueryResultsTool(), { compareResultKeys: ['case:D', 'combination:U'], nodeId: 'tip', referenceNodeId: 'base',
  field: 'displacements', component: 'uz', unit: 'mm', quantityId: 'controlling-difference' });
const controlling = state.resultQuantities[`${first.runId}:controlling-difference`];
close(controlling.value, -15);
assert.equal(controlling.selection, 'combination:U');
for (const locale of ['zh', 'en']) assert.ok(resultTableMarkdown({ ...first, requestedQuantities: [controlling] }, locale).includes('tip − base'));

await invoke(createEditModelTool(), { baseRevision: state.modelRevision, label: 'change couple',
  edits: [{ operation: 'update', collection: 'loads', caseId: 'D', id: 'couple', values: { my: 25 } }] });
const loadTransaction = state.modelHistory.at(-1).id;
await invoke(createEditModelTool(), { baseRevision: state.modelRevision, label: 'change independent bending stiffness',
  edits: [{ operation: 'update', collection: 'sections', id: 's', values: { properties: { Iy: .0002 } } }] });
await invoke(createUndoModelTool(), { baseRevision: state.modelRevision, transactionId: loadTransaction });
assert.equal(state.model.load_cases[0].loads[0].my, 20);
assert.equal(state.model.sections[0].properties.Iy, .0002);
assert.equal(state.analysisResult, null);
assert.equal(state.analysisRuns[first.runId].modelSnapshot.sections[0].properties.Iy, .0001);
const second = await solve();
await invoke(createQueryResultsTool(), { resultKey: 'case:D', quantityId: 'after-selective-undo',
  nodeId: 'tip', field: 'displacements', component: 'uz', unit: 'm' });
close(state.resultQuantities[`${second.runId}:after-selective-undo`].value, -.005);
console.log(JSON.stringify({ status: 'passed', runIds: [first.runId, second.runId], paidModelCalls: 0,
  checks: ['real OpenSees couple and arbitrary-position displacement', 'left/right moment discontinuity',
    'node difference and controlling combination', 'bilingual bound report', 'selective earlier-load undo preserves later section edit',
    'new solve after undo and unchanged historical snapshot'], tolerance: { absolute: 1e-10, relative: 1e-8 } }, null, 2));
