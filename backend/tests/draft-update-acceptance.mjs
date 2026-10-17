// Product-owned replay: saved failing draft -> explicit source withdrawal -> real OpenSees -> query/report.
// --live additionally exercises the configured LLM extractor; run only with an isolated test runtime.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentSkillRuntime } from '../dist/agent-runtime/index.js';
import { handler } from '../dist/agent-skills/structure-type/beam/handler.js';
import { createRegisteredTools } from '../dist/agent-langgraph/tool-registry.js';
import { createLocalAnalysisEngineClient } from '../dist/services/analysis-execution.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { createLocalCodeCheckClient } from '../dist/services/code-check-execution.js';
import { runtimeBaseDir } from '../dist/config/index.js';

const live = process.argv.includes('--live');
if (live && !path.resolve(runtimeBaseDir).includes(`${path.sep}.tmp${path.sep}`)) throw Error('LIVE_REPLAY_REQUIRES_ISOLATED_RUNTIME');
const fixture = JSON.parse(await readFile(new URL('./fixtures/catalog-draft-reproduction-20261015.json', import.meta.url), 'utf8'));
const original = structuredClone(fixture.draftState);
// Independent Euler-Bernoulli references, frozen before invoking the candidate.
const length = 10, point = 1, E = 206e6, rho = 7850, gravity = 9.80665;
const A = .2 * .013 * 2 + (.4 - .013 * 2) * .008;
const I = (.2 * .4 ** 3 - (.2 - .008) * (.4 - 2 * .013) ** 3) / 12;
const q = A * rho * gravity / 1000;
const reference = { A, I, qKNM: q, reactionKN: (point + q * length) / 2,
  momentKNM: point * length / 4 + q * length ** 2 / 8,
  deflectionMM: (point * length ** 3 / (48 * E * I) + 5 * q * length ** 4 / (384 * E * I)) * 1000 };
const tolerance = { absolute: 1e-8, relative: 1e-8 };
const close = (actual, expected) => assert.ok(Number.isFinite(actual)
  && Math.abs(actual - expected) <= tolerance.absolute + tolerance.relative * Math.abs(expected), `${actual} != ${expected}`);
await mkdir(path.join(runtimeBaseDir, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(runtimeBaseDir, 'work/draft-update-'));
await writeFile(path.join(directory, 'frozen-reference.json'), JSON.stringify({ reference, tolerance,
  assumptions: 'Explicit sharp-corner H geometry confirmed by the user; self-weight plus original midspan point load; linear elastic analysis.' }, null, 2));
const skillRuntime = new AgentSkillRuntime();
const tools = new Map(createRegisteredTools({ skillRuntime }).map(tool => [tool.name, tool]));
const configurable = { skillRuntime, engineClient: createLocalAnalysisEngineClient(), structureProtocolClient: createLocalStructureProtocolClient(),
  codeCheckClient: createLocalCodeCheckClient(), workspaceRoot: directory, allowShell: false,
  toolContext: { skillScope: ['beam', 'opensees-static', 'code-check-gb50017', 'report-export-builtin'] },
  agentState: { draftState: structuredClone(original), structuralTypeKey: 'beam', locale: 'zh', messages: [], inputEvidence: [],
    policy: { analysisType: 'static' }, requestScope: original.requestScope, lastUserMessage: fixture.clarification } };
const trace = [];
const invoke = async (name, args) => {
  const result = await tools.get(name).invoke(args, { toolCall: { id: `draft-replay-${trace.length}` }, configurable });
  if (result?.update) {
    const previous = configurable.agentState;
    configurable.agentState = { ...previous, ...result.update,
      analysisRuns: { ...previous.analysisRuns, ...result.update.analysisRuns }, resultQuantities: { ...previous.resultQuantities, ...result.update.resultQuantities } };
  }
  const value = result?.update ? JSON.parse(result.update.messages[0].content)
    : typeof result === 'string' ? JSON.parse(result) : typeof result?.content === 'string' ? JSON.parse(result.content) : result;
  trace.push({ name, args, result: value });
  await writeFile(path.join(directory, 'trace.json'), JSON.stringify(trace, null, 2));
  return value;
};
try {
  if (live) {
    const extraction = await invoke('extract_draft_params', { locale: 'zh', message: fixture.clarification, requestScope: original.requestScope });
    assert.equal(extraction.canProceed, true);
    assert.ok(extraction.appliedDraftUpdate.clearedFields.includes('sectionRecords["S1"].standard_steel_name'));
  } else {
    const patch = handler.extractDraft({ locale: 'zh', currentState: original, llmDraftPatch: {
      clearDraftFields: ['sectionRecords["S1"].standard_steel_name'],
      engineeringDraft: { sectionRecords: [{ id: 'S1', shape: { kind: 'H', H: 400, B: 200, tw: 8, tf: 13 } }] },
    } });
    configurable.agentState.draftState = handler.mergeState(original, patch);
  }
  const draft = configurable.agentState.draftState.engineeringDraft;
  assert.equal(draft.sectionRecords.length, 1);
  assert.equal(draft.sectionRecords[0].id, 'S1');
  assert.equal(draft.sectionRecords[0].standard_steel_name, undefined);
  assert.deepEqual(draft.loads, original.engineeringDraft.loads);
  assert.equal(draft.analysisControl.self_weight, true);
  await invoke('build_model', {});
  close(configurable.agentState.model.sections[0].properties.A, A);
  close(configurable.agentState.model.sections[0].properties.Iy, I);
  assert.equal(configurable.agentState.model.analysis_control.self_weight, true);
  const analysis = await invoke('run_analysis', { analysisType: 'static', analysisSkillId: 'opensees-static', loadCaseIds: ['LC1'], loadCombinationIds: [] });
  assert.equal(analysis.success, true);
  close(analysis.keyMetrics.maxAbsReaction, reference.reactionKN);
  close(analysis.keyMetrics.maxAbsMoment, reference.momentKNM);
  const deflection = await invoke('query_results', { field: 'displacements', nodeId: '2', component: 'uz', unit: 'mm', resultKey: 'case:LC1', quantityId: 'midspan' });
  close(deflection.quantity.value, -reference.deflectionMM);
  const check = await invoke('run_code_check', { provider: 'auto', designCode: 'GB50017' });
  assert.equal(check.completionStatus, 'incomplete'); // Strengths and design assumptions were not supplied.
  assert.notEqual(check.complianceStatus, 'pass');
  assert.ok(check.missingInputCount > 0);
  // The acceptance fixture requests a report of this analysis, including its real design omissions.
  configurable.agentState.requestScope = { ...original.requestScope, report: true };
  for (const locale of ['zh', 'en']) {
    await invoke('generate_report', { analysisType: 'static', locale, message: 'Report the verified analysis and explicitly list remaining design inputs', narrative: 'structured' });
    const report = configurable.agentState.report.json;
    close(report.requestedQuantities.find(row => row.id === 'midspan').value, -reference.deflectionMM);
    assert.equal(report.meta.runId, configurable.agentState.analysisResult.runId);
    assert.notEqual(report.codeCheck.complianceStatus, 'pass');
  }
  assert.deepEqual(fixture.draftState, original);
  const evidence = { success: true, liveExtractor: live, runId: configurable.agentState.analysisResult.runId,
    reference, actualMetrics: analysis.keyMetrics, deflectionMM: deflection.quantity.value,
    designStatus: check.completionStatus, designMissingInputCount: check.missingInputCount,
    bilingualReportsMatched: true, sourceDraftUnchanged: true, directory };
  await writeFile(path.join(directory, 'acceptance.json'), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(directory, 'run.json'), JSON.stringify(configurable.agentState.analysisResult, null, 2));
  console.log(JSON.stringify(evidence));
} catch (error) {
  await writeFile(path.join(directory, 'acceptance.json'), JSON.stringify({ success: false, liveExtractor: live, error: error.message, directory }, null, 2));
  throw error;
}
