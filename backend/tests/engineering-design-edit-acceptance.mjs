// Product-owned reproduction, real public tools, OpenSees and code checker.
// Freeze Euler-Bernoulli references before running the candidate. The supplied
// custom numerical section is NOT certification of a rolled-section catalogue.
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentSkillRuntime } from '../dist/agent-runtime/index.js';
import { createRegisteredTools } from '../dist/agent-langgraph/tool-registry.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { commitModel, currentAnalysisError } from '../dist/engineering/model-state.js';
import { createLocalAnalysisEngineClient } from '../dist/services/analysis-execution.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { createLocalCodeCheckClient } from '../dist/services/code-check-execution.js';
import { runtimeBaseDir } from '../dist/config/index.js';

const fixture = JSON.parse((await readFile(new URL('./fixtures/design-edit-boundary-20261015.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const reference = { reactionKn: .5, momentKnm: 2.5, deflectionMm: 1 * 10 ** 3 / (48 * 206e6 * 2.37e-5) * 1000,
  cantileverDeflectionMm: 1 * 10 ** 3 / (3 * 206e6 * 2.37e-5) * 1000,
  serviceCapacityMm: 10000 / 250, tolerance: { absolute: 1e-8, relative: 1e-8 } };
await mkdir(path.join(runtimeBaseDir, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(runtimeBaseDir, 'work/design-edit-'));
await writeFile(path.join(directory, 'frozen-reference.json'), JSON.stringify({ fixture, reference }, null, 2));
const skillRuntime = new AgentSkillRuntime();
const tools = new Map(createRegisteredTools({ skillRuntime }).map(tool => [tool.name, tool]));
const protocol = createLocalStructureProtocolClient();
const raw = structuredClone(fixture.model);
raw.analysis_control = { self_weight: false, rigid_floor: false, rigid_offsets: false, p_delta: false, construction_stage: false };
const model = await normalizeEngineeringModel(raw, protocol);
const configurable = { skillRuntime, engineClient: createLocalAnalysisEngineClient(), structureProtocolClient: protocol,
  codeCheckClient: createLocalCodeCheckClient(), workspaceRoot: directory,
  skillScope: ['beam', 'opensees-static', 'code-check-gb50017', 'report-export-builtin'], allowShell: false,
  maxToolCallsPerTurn: 200, agentState: { ...commitModel({}, model, 'reproduction'), locale: 'zh', inputEvidence: [],
    policy: { analysisType: 'static' }, lastUserMessage: 'Explicit product-owned reproduction' } };
let sequence = 0;
const receipts = [];
const invoke = async (name, args) => {
  const result = await tools.get(name).invoke(args, { toolCall: { id: `acceptance-${++sequence}` }, configurable });
  if (result?.update) {
    const previous = configurable.agentState;
    configurable.agentState = { ...previous, ...result.update,
      analysisRuns: { ...previous.analysisRuns, ...result.update.analysisRuns }, resultQuantities: { ...previous.resultQuantities, ...result.update.resultQuantities } };
    return JSON.parse(result.update.messages[0].content);
  }
  return typeof result === 'string' ? JSON.parse(result) : typeof result?.content === 'string' ? JSON.parse(result.content) : result;
};
const analysis = { analysisType: 'static', analysisSkillId: 'opensees-static', loadCaseIds: ['LC1'], loadCombinationIds: ['ULS'] };
const edit = edits => invoke('edit_model', { baseRevision: configurable.agentState.modelRevision, edits });
const update = (collection, id, values) => ({ operation: 'update', collection, id, values });
const close = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= reference.tolerance.absolute + reference.tolerance.relative * Math.abs(expected), `${actual} != ${expected}`);
const items = check => check.details.flatMap(detail => detail.checks.flatMap(group => group.items.map(item => ({ ...item, resultKey: detail.resultKey, elementId: detail.elementId }))));
try {
  const schema = await invoke('query_model', { collection: 'elements', includeSchema: true });
  assert.ok(schema.editSchema.$defs.MemberDesign.properties.basis);
  await invoke('run_analysis', analysis);
  assert.equal(currentAnalysisError(configurable.agentState), undefined);
  const initialRun = configurable.agentState.analysisResult.runId;
  const before = await invoke('run_code_check', { designCode: 'GB50017', provider: 'builtin' });
  assert.equal(before.completionStatus, 'incomplete');
  assert.ok(before.writeTargets.some(row => row.collection === 'materials' && row.id === '1' && row.path === 'design.f'));
  assert.equal(before.writeTargets.find(row => row.path === 'properties.S').modelUnit, 'm3');
  // Only the actual numerical inputs confirmed by the user; do not invent
  // phi_b, b/t, local stability or slenderness limits to force completion.
  const supplied = await edit([
    update('materials', '1', { design: '{"f":215,"fv":125,"basis":{"f":"user supplied","fv":"user supplied"}}' }),
    update('sections', 'SEC-I20A', { 'properties.S': '.000104', 'properties.tw': '.0052', 'properties.Wnx': '.000237', 'properties.imin': '.021' }),
    ...['1', '2'].map(id => update('elements', id, { 'design.beta1': '1.1', 'design.deflectionLimitN': '250', 'design.serviceability_result_keys': '["case:LC1"]',
      'design.basis': { phi_b: 'User reports a midpoint lateral restraint; no numerical stability factor supplied.' } })),
  ]);
  assert.equal(supplied.changed, true);
  assert.equal(configurable.agentState.analysisResult, null);
  await invoke('run_analysis', analysis);
  const partial = await invoke('run_code_check', { designCode: 'GB50017', provider: 'builtin' });
  const missing = [...new Set(partial.missingInputs.map(row => row.field))].sort();
  assert.deepEqual(missing, ['member.design.btLimit', 'member.design.l0', 'member.design.lambdaLimit', 'member.design.phi_b', 'section.b', 'section.t']);
  const partialItems = items(configurable.agentState.codeCheckResult);
  for (const row of partialItems.filter(row => row.item === '挠度')) {
    if (row.resultKey === 'case:LC1') {
      assert.equal(row.status, 'pass'); close(row.inputs.demand, reference.deflectionMm); close(row.inputs.capacity, reference.serviceCapacityMm);
      assert.equal(row.calculationInputs.deflectionResponse.definition, 'transverse-displacement-relative-to-whole-span-chord');
    } else assert.equal(row.status, 'not_applicable');
  }
  const query = await invoke('query_results', { field: 'displacements', nodeId: '2', component: 'uz', unit: 'mm', quantityId: 'midpoint-deflection' });
  close(Math.abs(query.quantity.value), reference.deflectionMm);
  for (const locale of ['zh', 'en']) {
    await invoke('generate_report', { message: 'Partial checks with supplied inputs', analysisType: 'static', locale, narrative: 'structured' });
    assert.equal(configurable.agentState.report.json.codeCheck.complianceStatus, 'incomplete');
    close(Math.abs(configurable.agentState.report.json.requestedQuantities.find(row => row.id === 'midpoint-deflection').value), reference.deflectionMm);
  }
  receipts.push({ stage: 'actual supplied inputs', runId: configurable.agentState.analysisResult.runId, partial, deflectionMm: reference.deflectionMm });
  // User explicitly requests strength + deflection only. Exercise public edits,
  // actual OpenSees, checker and bilingual reports; no stability inputs are filled.
  await edit(['1', '2'].map(id => update('elements', id, {
    'design.requested_checks': ['normal_stress', 'shear_stress', 'equivalent_stress', 'deflection'],
    'design.basis.requested_checks': 'Explicit test request: strength and deflection only',
  })));
  await invoke('run_analysis', analysis);
  const selected = await invoke('run_code_check', { designCode: 'GB50017', provider: 'builtin' });
  assert.equal(selected.completionStatus, 'complete'); assert.equal(selected.complianceStatus, 'pass');
  assert.equal(selected.checkScope.limited, true); assert.equal(selected.conclusionEligible, false);
  assert.equal(selected.requestedChecksPassed, true); assert.equal(selected.missingInputCount, 0);
  for (const member of configurable.agentState.model.elements) {
    assert.equal(member.design.phi_b, undefined); assert.equal(member.design.lambdaLimit, undefined);
  }
  const selectedItems = items(configurable.agentState.codeCheckResult);
  for (const row of selectedItems.filter(row => ['整体稳定', '局部稳定', '长细比'].includes(row.item))) {
    assert.equal(row.status, 'not_applicable'); assert.equal(row.scopeReason, 'not_requested');
  }
  for (const row of selectedItems.filter(row => row.item === '正应力')) close(row.inputs.demand, 2.5e6 / 237000);
  for (const row of selectedItems.filter(row => row.item === '挠度' && row.resultKey === 'case:LC1')) close(row.inputs.demand, reference.deflectionMm);
  for (const locale of ['zh', 'en']) {
    await invoke('generate_report', { message: 'Explicit strength and deflection checks only', analysisType: 'static', locale, narrative: 'structured' });
    assert.equal(configurable.agentState.report.json.codeCheck.checkScope.limited, true);
    assert.ok(configurable.agentState.report.markdown.includes(locale === 'zh' ? '未请求项目未校核' : 'Unrequested checks were not performed'));
  }
  receipts.push({ stage: 'explicit selected strength and deflection checks with bilingual reports', runId: configurable.agentState.analysisResult.runId, selected });
  // Removing the declared subset restores all implemented checks.
  await edit(['1', '2'].map(id => update('elements', id, { 'design.requested_checks': null })));
  // Independent additional synthetic design data, explicitly declared here.
  await edit([update('sections', 'SEC-I20A', { properties: { b: .04, t: .0084 } }),
    ...['1', '2'].map(id => update('elements', id, { design: { phi_b: .9, btLimit: 13, lambdaLimit: 250, l0: 5000,
      basis: { phi_b: 'Synthetic test condition, not inferred from restraint', btLimit: 'Synthetic explicit limit', lambdaLimit: 'Synthetic explicit limit' } } }))]);
  await invoke('run_analysis', analysis);
  const complete = await invoke('run_code_check', { designCode: 'GB50017' });
  assert.equal(complete.completionStatus, 'complete'); assert.equal(complete.complianceStatus, 'pass');
  assert.equal(complete.summary.inputRequired, 0);
  assert.notEqual(configurable.agentState.analysisResult.runId, initialRun);
  receipts.push({ stage: 'explicit complete synthetic conditions', runId: configurable.agentState.analysisResult.runId, complete });
  await edit([update('elements', '1', { 'design.serviceability_result_keys': ['case:TYPO'] })]);
  await invoke('run_analysis', analysis);
  await assert.rejects(invoke('run_code_check', { designCode: 'GB50017' }), /SERVICEABILITY_RESULT_UNAVAILABLE/);
  await edit([update('elements', '1', { 'design.serviceability_result_keys': ['case:LC1'] }),
    { operation: 'update', collection: 'loads', caseId: 'LC1', id: model.load_cases[0].loads[0].id, values: { fz: -1000 } }]);
  await invoke('run_analysis', analysis);
  const failed = await invoke('run_code_check', { designCode: 'GB50017' });
  assert.equal(failed.complianceStatus, 'fail'); assert.ok(failed.summary.failed > 0);
  receipts.push({ stage: 'actual overload', runId: configurable.agentState.analysisResult.runId, failed });
  const cantilever = structuredClone(raw);
  cantilever.metadata.supportType = 'cantilever';
  cantilever.nodes[0].restraints = [true,true,true,true,true,true];
  cantilever.nodes[2].restraints = [false,true,false,true,false,true];
  cantilever.load_cases[0].loads = [{id:'tip-load',type:'nodal',node:'3',fz:-1},
    {id:'fixed-motion',type:'displacement',node:'1',uz:-.02,ry:.001}];
  for (const member of cantilever.elements) member.design = {deflectionLimitN:250,serviceability_result_keys:['case:LC1']};
  configurable.agentState = {...commitModel({},await normalizeEngineeringModel(cantilever,protocol),'cantilever-reference'),locale:'zh',inputEvidence:[],policy:{analysisType:'static'}};
  await invoke('run_analysis',analysis);
  await invoke('run_code_check',{designCode:'GB50017'});
  const cantileverItems = items(configurable.agentState.codeCheckResult).filter(row => row.item==='挠度' && row.resultKey==='case:LC1');
  assert.equal(cantileverItems.length,2);
  for (const row of cantileverItems) {
    assert.equal(row.status,'fail'); close(row.inputs.demand,reference.cantileverDeflectionMm); close(row.inputs.capacity,reference.serviceCapacityMm);
    assert.equal(row.calculationInputs.deflectionResponse.definition,'transverse-displacement-relative-to-fixed-end');
  }
  receipts.push({stage:'cantilever excludes fixed-end translation and rotation',runId:configurable.agentState.analysisResult.runId,deflectionMm:reference.cantileverDeflectionMm});
  // A generic explicit cantilever has the same physical restraints but no
  // template labels. Its tip response must not be removed as endpoint drift.
  delete cantilever.metadata;
  configurable.agentState = {...commitModel({},await normalizeEngineeringModel(cantilever,protocol),'explicit-cantilever-reference'),locale:'zh',inputEvidence:[],policy:{analysisType:'static'}};
  await invoke('run_analysis',analysis);
  await invoke('run_code_check',{designCode:'GB50017'});
  const explicitCantileverItems = items(configurable.agentState.codeCheckResult).filter(row => row.item==='挠度' && row.resultKey==='case:LC1');
  assert.equal(explicitCantileverItems.length,2);
  for (const row of explicitCantileverItems) {
    assert.equal(row.status,'fail'); close(row.inputs.demand,reference.cantileverDeflectionMm); close(row.inputs.capacity,reference.serviceCapacityMm);
    assert.equal(row.calculationInputs.deflectionResponse.definition,'transverse-displacement-relative-to-fixed-end');
  }
  receipts.push({stage:'explicit cantilever without template metadata retains tip deflection',runId:configurable.agentState.analysisResult.runId,deflectionMm:reference.cantileverDeflectionMm});
  await writeFile(path.join(directory, 'acceptance.json'), JSON.stringify({ status: 'passed', reference, receipts }, null, 2));
  console.log(JSON.stringify({ status: 'passed', directory, reference, stages: receipts.map(row => ({ stage: row.stage, runId: row.runId })) }, null, 2));
} catch (error) {
  await writeFile(path.join(directory, 'acceptance.json'), JSON.stringify({ status: 'failed', receipts, error: String(error) }, null, 2));
  console.error(JSON.stringify({ status: 'failed', directory, error: String(error) })); throw error;
}
