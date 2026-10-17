// Product-owned acceptance: public tools, real OpenSees, no LLM or Bench dependency.
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

const hInertia = (h, b, tw, tf) => (b*h**3 - (b-tw)*(h-2*tf)**3)/12;
const persisted = JSON.parse((await readFile(new URL('./fixtures/hw-design-draft-reproduction-20261015.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const cases = [
  { id: 'reported-lowercase-h', name: 'HW300×300×10×15', shape: { kind: 'h', H: 300, B: 300, tw: 10, tf: 15 }, I: hInertia(.3,.3,.01,.015) },
  { id: 'uppercase-h', name: 'H300×300×10×15', shape: { kind: 'H', H: 300, B: 300, tw: 10, tf: 15 }, I: hInertia(.3,.3,.01,.015) },
  { id: 'hw-dimensions-name', name: 'HW300×300×10×15', I: hInertia(.3,.3,.01,.015) },
  { id: 'hn-dimensions-name', name: 'HN400×200×8×13', I: hInertia(.4,.2,.008,.013) },
  { id: 'rectangular', name: '250×500', shape: { kind: 'RECTANGULAR', B: 250, H: 500 }, I: .25*.5**3/12 },
  { id: 'circular', name: 'Circular 200 mm', shape: { kind: 'CIRCULAR', d: 200 }, I: Math.PI*.2**4/64 },
  { id: 'pipe', name: 'Pipe 200×10 mm', shape: { kind: 'PIPE', d: 200, T: 10 }, I: Math.PI*(.2**4-.18**4)/64 },
  { id: 'persisted-design-diagnostics', name: 'HW300×300×10×15', I: hInertia(.3,.3,.01,.015), completeDesign: true },
];
const references = cases.map(row => ({ ...row, reactionKn: .5, momentKnm: 2.5,
  deflectionMm: 1*10**3/(48*206e6*row.I)*1000, rotationRad: 1*10**2/(16*206e6*row.I) }));
const tolerance = { absolute: 1e-8, relative: 1e-8 };
await mkdir(path.join(runtimeBaseDir, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(runtimeBaseDir, 'work/section-shape-'));
await writeFile(path.join(directory, 'frozen-reference.json'), JSON.stringify({ references, tolerance,
  assumptions: '10 m simple beam; midspan downwards 1 kN; no self-weight; E=206000 MPa; sharp-corner geometry for explicit H dimensions.' }, null, 2));
const close = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance.absolute + tolerance.relative*Math.abs(expected), `${actual} != ${expected}`);
const skillRuntime = new AgentSkillRuntime();
const tools = new Map(createRegisteredTools({ skillRuntime }).map(tool => [tool.name, tool]));
const protocol = createLocalStructureProtocolClient();
const receipts = [];
try {
  for (const fixture of references) {
    const draft = { structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
      material: { family: 'steel', grade: 'Q235B' }, sections: { beam: fixture.name },
      ...(fixture.shape ? { sectionRecords: [{ id: 'SEC-BEAM-1', name: fixture.name, type: fixture.shape.kind, shape: fixture.shape }] } : {}),
      loads: [{ kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 5 } }],
      analysisControl: { self_weight: false }, analysis: { loadCombinations: [] } };
    const draftState = fixture.completeDesign ? structuredClone(persisted.draftState)
      : handler.mergeState(undefined, handler.extractDraft({ locale: 'zh', llmDraftPatch: { engineeringDraft: draft } }));
    draftState.requestScope = { responses: ['forces','reactions','displacements'], method: 'solver', design: false, report: true, outputs: [] };
    const originalDraft = structuredClone(draftState);
    const configurable = { skillRuntime, engineClient: createLocalAnalysisEngineClient(), structureProtocolClient: protocol,
      codeCheckClient: createLocalCodeCheckClient(), workspaceRoot: directory,
      toolContext: { skillScope: ['beam','opensees-static','code-check-gb50017','report-export-builtin'] }, allowShell: false,
      agentState: { draftState, structuralTypeKey: 'beam', locale: 'zh', messages: [], inputEvidence: [],
        policy: { analysisType: 'static' }, requestScope: draftState.requestScope, lastUserMessage: 'Product acceptance: explicitly supplied geometry and loading' } };
    let sequence = 0;
    const invoke = async (name, args) => {
      const result = await tools.get(name).invoke(args, { toolCall: { id: `${fixture.id}-${++sequence}` }, configurable });
      if (result?.update) {
        const previous = configurable.agentState;
        configurable.agentState = { ...previous, ...result.update,
          analysisRuns: { ...previous.analysisRuns, ...result.update.analysisRuns }, resultQuantities: { ...previous.resultQuantities, ...result.update.resultQuantities } };
        return JSON.parse(result.update.messages[0].content);
      }
      return typeof result === 'string' ? JSON.parse(result) : typeof result?.content === 'string' ? JSON.parse(result.content) : result;
    };
    await invoke('build_model', {});
    assert.deepEqual(draftState, originalDraft); // Recover old drafts without rewriting history.
    close(configurable.agentState.model.sections[0].properties.Iy, fixture.I);
    const analysis = await invoke('run_analysis', { analysisType: 'static', analysisSkillId: 'opensees-static', loadCaseIds: ['LC1'], loadCombinationIds: [] });
    assert.equal(analysis.success, true);
    close(analysis.keyMetrics.maxAbsReaction, fixture.reactionKn);
    close(analysis.keyMetrics.maxAbsMoment, fixture.momentKnm);
    const query = await invoke('query_results', { field: 'displacements', nodeId: '2', component: 'uz', unit: 'mm', resultKey: 'case:LC1', quantityId: 'midspan-deflection' });
    close(query.quantity.value, -fixture.deflectionMm);
    const rotation = await invoke('query_results', { field: 'displacements', nodeId: '1', component: 'ry', unit: 'rad', resultKey: 'case:LC1', quantityId: 'left-rotation' });
    close(Math.abs(rotation.quantity.value), fixture.rotationRad);
    for (const locale of ['zh','en']) {
      await invoke('generate_report', { analysisType: 'static', message: 'Report the explicitly requested analysis', locale, narrative: 'structured' });
      close(configurable.agentState.report.json.requestedQuantities.find(row => row.id === 'midspan-deflection').value, -fixture.deflectionMm);
      assert.equal(configurable.agentState.report.json.analysis.runId, configurable.agentState.analysisResult.runId);
      assert.equal(configurable.agentState.report.json.meta.runId, configurable.agentState.analysisResult.runId);
    }
    // No invented design strengths or stability factors are allowed to produce a pass.
    const unrequested = await invoke('run_code_check', { designCode: 'GB50017', provider: 'builtin' });
    assert.equal(unrequested.reason, 'DESIGN_NOT_REQUESTED');
    const check = await invoke('run_code_check', { designCode: 'GB50017', provider: 'builtin', requestScope: { ...draftState.requestScope, design: true } });
    assert.equal(check.completionStatus, fixture.completeDesign ? 'complete' : 'incomplete');
    if (fixture.completeDesign) {
      assert.equal(check.complianceStatus, 'pass');
      assert.equal(check.conclusionEligible, true);
      assert.equal(check.summary.total, 14);
      assert.equal(check.summary.passed, 14);
      for (const locale of ['zh','en']) {
        await invoke('generate_report', { analysisType: 'static', message: 'Report the complete explicitly supplied design', locale, narrative: 'structured' });
        assert.equal(configurable.agentState.report.json.codeCheck.summary.passed, 14);
        assert.equal(configurable.agentState.report.json.codeCheck.meta.runId, configurable.agentState.analysisResult.runId);
      }
    } else assert.ok(check.missingInputCount > 0);
    receipts.push({ case: fixture.id, runId: configurable.agentState.analysisResult.runId, reference: fixture,
      actual: { metrics: analysis.keyMetrics, deflectionMm: query.quantity.value, leftRotation: rotation.quantity.value },
      formalCheck: check.completionStatus, bilingualReportMatched: true, sourceDraftUnchanged: true });
    await writeFile(path.join(directory, `${fixture.id}.json`), JSON.stringify({ model: configurable.agentState.model, run: configurable.agentState.analysisResult, receipt: receipts.at(-1) }, null, 2));
    console.log(JSON.stringify(receipts.at(-1)));
  }
  await writeFile(path.join(directory, 'acceptance.json'), JSON.stringify({ success: true, receipts }, null, 2));
  console.log(JSON.stringify({ success: true, cases: receipts.length, directory }));
} catch (error) {
  await writeFile(path.join(directory, 'acceptance.json'), JSON.stringify({ success: false, receipts, error: error.message }, null, 2));
  throw error;
}
