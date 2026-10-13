// Independent references frozen before execution: Euler–Bernoulli simply supported beam,
// P L^3/(48 E I), q a (8 L^3 - 4 L a^2 + a^3)/(384 E I), and support equilibrium.
// No language-model/API credits are used. Run after npm run build with SCLAW_DATA_DIR set.
import assert from 'node:assert/strict';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { queryPhysicalResponse } from '../dist/engineering/result-data.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { AnalysisExecutionService } from '../dist/services/analysis-execution.js';
import { AgentSkillRuntime } from '../dist/agent-runtime/index.js';
import { normalizeEngineeringDraft } from '../dist/agent-runtime/engineering-draft.js';
import { commitModel, applyModelEdits, publishAnalysis, undoModel } from '../dist/engineering/model-state.js';

const L = 4, E = 200000e3, I = 8e-6, P = .5, q = 2, a = 2;
const expectedD = -P * L ** 3 / (48 * E * I);
const expectedL = -q * a * (8 * L ** 3 - 4 * L * a ** 2 + a ** 3) / (384 * E * I);
const close = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-10 + Math.abs(expected) * 1e-8, `${actual} != ${expected}`);
const inputLoad = normalizeEngineeringDraft({ loads: [{ id: 'p', kind: 'point', magnitude: -500, unit: 'N', direction: 'globalZ' }] }).loads[0];
assert.equal(inputLoad.unit, 'kN');
assert.equal(inputLoad.magnitude, -P);
const model = await normalizeEngineeringModel({
  schema_version: '2.0.0', unit_system: 'SI', coordinate_system: { dimension: '2d', plane: 'xz', semantics: 'global-z-up', version: 1, dof_order: ['ux','uy','uz','rx','ry','rz'] },
  nodes: [{ id: 'a', x: 0, y: 0, z: 0, restraints: [true,true,true,true,false,true] },
    { id: 'b', x: L, y: 0, z: 0, restraints: [false,true,true,true,false,true] }],
  elements: [{ id: 'beam', type: 'beam', nodes: ['a','b'], material: 'steel', section: 's' }],
  materials: [{ id: 'steel', name: 'Elastic steel', type: 'steel', E: 200000, nu: .3, rho: 7850 }],
  sections: [{ id: 's', name: 'Independent reference', type: 'general', properties: { A: .02, Iy: I, Iz: I, J: 1.6e-5 } }],
  load_cases: [{ id: 'D', type: 'dead', loads: [{ id: 'p', type: 'point', element: 'beam', position: 2, fz: inputLoad.magnitude }] },
    { id: 'L', type: 'live', loads: [{ id: 'q', type: 'distributed', element: 'beam', start: 1, end: 3, wz: -2 }] }],
  load_combinations: [{ id: 'U', factors: { D: 1.2, L: 1.4 } }], analysis_control: { self_weight: false },
}, createLocalStructureProtocolClient());
const run = await new AnalysisExecutionService().analyze({ model, type: 'static', engineId: 'builtin-opensees', parameters: {} });
assert.equal(run.success, true, JSON.stringify(run));
assert.deepEqual(Object.keys(run.results), ['case:D','case:L','combination:U']);
for (const [key, displacement, reaction] of [['case:D',expectedD,.25],['case:L',expectedL,2],['combination:U',1.2*expectedD+1.4*expectedL,3.1]]) {
  const selected = run.results[key];
  close(selected.data.reactions.a.fz, reaction);
  close(selected.data.reactions.b.fz, reaction);
  const center = queryPhysicalResponse(model, selected, 'beam', 2, 'right');
  assert.equal(center.state, 'recovered');
  close(center.sample.displacement[2], displacement);
  assert.equal(selected.data.memberResponses[0].id, 'beam');
  assert.equal(selected.meta.modelHash, run.meta.modelHash);
}
const point = run.results['case:D'];
const left = queryPhysicalResponse(model, point, 'beam', 2, 'left');
const right = queryPhysicalResponse(model, point, 'beam', 2, 'right');
close(Math.abs(left.sample.V3 - right.sample.V3), P);
const initial = commitModel(undefined, model, 'initial');
const current = { ...initial, ...publishAnalysis(initial, run.meta.modelHash, run) };
const movedModel = await normalizeEngineeringModel(applyModelEdits(model, [{ operation: 'update', collection: 'loads', caseId: 'D', id: 'p', values: { position: 3 } }]), createLocalStructureProtocolClient());
const moved = commitModel(current, movedModel, 'move load');
assert.equal(moved.analysisResult, null);
assert.equal(moved.analysisRuns[run.runId].modelSnapshot.load_cases[0].loads[0].position, 2);
const second = await new AnalysisExecutionService().analyze({ model: movedModel, type: 'static', engineId: 'builtin-opensees', parameters: { loadCaseIds: ['D'] } });
assert.equal(second.success, true);
close(second.data.reactions.a.fz, .125); close(second.data.reactions.b.fz, .375);
close(queryPhysicalResponse(movedModel, second, 'beam', 3, 'right').sample.displacement[2], -P * 3 ** 2 * 1 ** 2 / (3 * E * I * L));
assert.deepEqual(undoModel(moved).model, model);
const runtime = new AgentSkillRuntime();
for (const locale of ['zh','en']) {
  const generated = await runtime.executeReportSkill({ message: 'Native acceptance', analysisType: 'static', normalizedModel: model, analysis: run, format: 'both', locale });
  assert.equal(generated.report.json.meta.runId, run.runId);
  assert.deepEqual(generated.report.json.resultSets.map(item => item.key), Object.keys(run.results));
  assert.ok(generated.report.markdown.includes('combination:U'));
  assert.ok(generated.report.markdown.includes(String(expectedL)) || generated.report.markdown.includes(String(queryPhysicalResponse(model, run.results['case:L'], 'beam', 2, 'right').sample.displacement[2])));
}
console.log(JSON.stringify({ status: 'passed', runId: run.runId, movedRunId: second.runId, checks: ['conversion','native OpenSees','D/L/U separation','independent deflection and reaction references','physical member recovery','point-load shear jump','immutable provenance','load move and undo','bilingual report source and numeric consistency'], references: { expectedD, expectedL }, tolerance: { absolute: 1e-10, relative: 1e-8 } }, null, 2));
