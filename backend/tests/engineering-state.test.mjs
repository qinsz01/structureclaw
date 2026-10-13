import { describe, expect, test } from '@jest/globals';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { applyModelEdits, beginAnalysisRequest, commitModel, modelHash, undoModel, currentAnalysisError, publishAnalysis } from '../dist/engineering/model-state.js';
import { analysisSelections, executeAnalysisRun, executionStatus } from '../dist/engineering/analysis-runs.js';
import { SessionLock } from '../dist/engineering/session-lock.js';
import { checkRunResults, formatCheckSummary } from '../dist/engineering/code-checks.js';
import { executeToolsSequentially } from '../dist/agent-langgraph/sequential-tools.js';
import { assertResolvedInput, mergeInputEvidence } from '../dist/engineering/input-evidence.js';

const model = () => ({ schema_version: '2.0.0', nodes: [{ id: 'a', x: 0 }, { id: 'b', x: 4 }],
  elements: [{ id: 'beam', nodes: ['a', 'b'], material: 'steel', section: 's' }],
  materials: [{ id: 'steel', E: 200000 }], sections: [{ id: 's' }],
  load_cases: [{ id: 'D', loads: [{ id: 'p', type: 'point', element: 'beam', position: 1, fz: -0.5 }] }, { id: 'L', loads: [] }],
  load_combinations: [{ id: 'U', factors: { D: 1.2, L: 1.4 } }] });

describe('physical model revisions', () => {
  test('physical settings use the same revision and invalidate the preceding run', () => {
    const old = commitModel(undefined, model(), 'create');
    const edited = applyModelEdits(old.model, [{ operation: 'update', collection: 'model_settings', id: 'analysis_control', values: { self_weight: false } }]);
    expect(commitModel({ ...old, analysisResult: { runId: 'before' } }, edited, 'settings')).toMatchObject({ modelRevision: 2, analysisResult: null, analysisRuns: { before: { runId: 'before' } } });
  });
  test('metadata and record order do not change physics; end order does', () => {
    const a = model(); const b = model(); b.nodes.reverse(); b.metadata = { title: 'display' };
    expect(modelHash(a)).toBe(modelHash(b)); b.elements[0].nodes.reverse(); expect(modelHash(a)).not.toBe(modelHash(b));
  });
  test('local axes and seismic mass metadata are physical', () => {
    const a = model(); const b = model(); b.metadata = { elementReferenceVectors: { beam: [0, 1, 0] }, seismicMassArea: 20 };
    expect(modelHash(a)).not.toBe(modelHash(b));
  });
  test('moves the same load, preserves sign and small magnitude, invalidates results', () => {
    const old = commitModel(undefined, model(), 'create');
    const edited = applyModelEdits(old.model, [{ operation: 'update', collection: 'loads', caseId: 'D', id: 'p', values: { position: 3 } }]);
    const next = commitModel({ ...old, analysisResult: { success: true } }, edited, 'move');
    expect(next.modelRevision).toBe(2); expect(next.analysisResult).toBeNull();
    expect(next.model.load_cases[0].loads).toEqual([{ id: 'p', type: 'point', element: 'beam', position: 3, fz: -0.5 }]);
    expect(old.model.load_cases[0].loads[0].position).toBe(1);
    const restored = undoModel(next); expect(restored.modelRevision).toBe(3); expect(restored.model).toEqual(old.model);
  });
  test('failed batch does not partially edit and deletion cannot orphan references', () => {
    const original = model();
    expect(() => applyModelEdits(original, [{ operation: 'update', collection: 'nodes', id: 'b', values: { x: 9 } }, { operation: 'remove', collection: 'nodes', id: 'a' }])).toThrow('MODEL_UNKNOWN_REFERENCE');
    expect(original.nodes[1].x).toBe(4);
  });
  test('conflicting selective undo is rejected without rewriting history', () => {
    const first = commitModel(undefined, model(), 'create');
    const second = commitModel(first, applyModelEdits(first.model, [{ operation: 'update', collection: 'nodes', id: 'b', values: { x: 5 } }]), 'edit1');
    const third = commitModel(second, applyModelEdits(second.model, [{ operation: 'update', collection: 'nodes', id: 'b', values: { x: 6 } }]), 'edit2');
    expect(() => undoModel(third, second.modelHistory.at(-1).id)).toThrow('MODEL_UNDO_CONFLICT');
  });
  test('old and failed analyses cannot justify current checks', () => {
    const m = model();
    const state = { model: m, ...beginAnalysisRequest({ model: m }, 'settings') };
    expect(currentAnalysisError({ model: m, analysisResult: { success: true } })).toBe('ANALYSIS_STALE_OR_LEGACY');
    expect(currentAnalysisError({ ...state, analysisResult: { success: false, meta: state.analysisRequest } })).toBe('ANALYSIS_FAILED');
    expect(currentAnalysisError({ ...state, analysisResult: { success: true, meta: state.analysisRequest } })).toBeUndefined();
  });
  test('late completion is retained historically but cannot replace the current result', () => {
    const original = model(); const changed = model(); changed.nodes[1].x = 7;
    const result = { runId: 'old-run', success: true };
    const update = publishAnalysis({ model: changed }, beginAnalysisRequest({ model: original }, 'settings').analysisRequest, result);
    expect(update.analysisResult).toBeUndefined(); expect(update.analysisRuns['old-run']).toBe(result);
  });
  test('same model with new settings cannot be overwritten by an earlier completion', () => {
    const base = commitModel(undefined, model(), 'create');
    const old = { ...base, ...beginAnalysisRequest(base, 'old-settings') };
    const newer = { ...old, ...beginAnalysisRequest(old, 'new-settings') };
    const result = { runId: 'old-run', success: true, meta: old.analysisRequest };
    const update = publishAnalysis(newer, old.analysisRequest, result);
    expect(update.analysisResult).toBeUndefined();
    expect(update.analysisRuns['old-run']).toBe(result);
    expect(currentAnalysisError({ ...newer, analysisResult: result })).toBe('ANALYSIS_STALE_OR_LEGACY');
  });
  test('editing back to the same geometry or retrying identical settings still rejects old requests', () => {
    const base = commitModel(undefined, model(), 'create');
    const first = { ...base, ...beginAnalysisRequest(base, 'settings') };
    const edited = commitModel(first, applyModelEdits(first.model, [{ operation: 'update', collection: 'nodes', id: 'b', values: { x: 5 } }]), 'move');
    const restored = { ...first, ...undoModel(edited) };
    expect(modelHash(restored.model)).toBe(modelHash(first.model));
    const result = { runId: 'old-run', success: true, meta: first.analysisRequest };
    expect(publishAnalysis(restored, first.analysisRequest, result).analysisResult).toBeUndefined();
    const retried = { ...first, ...beginAnalysisRequest(first, 'settings') };
    expect(publishAnalysis(retried, first.analysisRequest, result).analysisResult).toBeUndefined();
    const fresh = { runId: 'new-run', success: true, meta: retried.analysisRequest };
    expect(publishAnalysis(retried, retried.analysisRequest, fresh).analysisResult).toBe(fresh);
  });
});

test('required source conflicts persist until an explicit resolution; optional unread pages do not block', () => {
  const first = [{ id: 'drawing', field: 'nodes.b.x', value: 4, unit: 'm', source: { file: 'drawing.pdf', page: 2 } }];
  const merged = mergeInputEvidence(first, [{ id: 'table', field: 'nodes.b.x', value: 5, unit: 'm', source: { file: 'table.csv', row: 3 } }]);
  expect(() => assertResolvedInput(merged)).toThrow('INPUT_EVIDENCE_UNRESOLVED');
  const resolved = mergeInputEvidence(merged, [{ id: 'resolution', field: 'nodes.b.x', status: 'resolved', resolution: { selectedSource: 'drawing', reason: 'Explicit corrected drawing revision' } }]);
  expect(resolved).toHaveLength(3); expect(() => assertResolvedInput(resolved)).not.toThrow();
  expect(() => assertResolvedInput([{ field: 'appendix', status: 'unread', required: false }])).not.toThrow();
  expect(() => assertResolvedInput([{ field: 'support', status: 'unread' }])).toThrow();
});

describe('input resolutions bind the reviewed evidence', () => {
  const observations = () => [
    { id: 'drawing', field: 'span', value: 4, unit: 'm', source: { file: 'drawing.pdf', page: 2 } },
    { id: 'table', field: 'span', value: 5, unit: 'm', source: { file: 'table.csv', row: 3 } },
  ];
  const resolution = () => ({ id: 'review-1', field: 'span', status: 'resolved', resolution: { selectedSource: 'drawing', reason: 'Reviewed corrected drawing' } });
  test('a new conflicting observation or unread source reopens a previously resolved field', () => {
    const resolved = mergeInputEvidence(observations(), [resolution()]);
    expect(resolved.at(-1).resolution.evidenceHashes).toHaveLength(2);
    expect(() => assertResolvedInput(resolved)).not.toThrow();
    for (const extra of [{ id: 'revision-2', field: 'span', value: 7, unit: 'm' },
      { id: 'revision-2', field: 'span', status: 'unread' }]) {
      const updated = mergeInputEvidence(resolved, [extra]);
      expect(() => assertResolvedInput(updated)).toThrow('INPUT_EVIDENCE_UNRESOLVED');
    }
  });
  test('source IDs are immutable and revised observations retain their original evidence', () => {
    const resolved = mergeInputEvidence(observations(), [resolution()]);
    expect(() => mergeInputEvidence(resolved, [{ ...observations()[0], value: 7 }])).toThrow('INPUT_EVIDENCE_ID_CONFLICT');
    expect(resolved.find((item) => item.id === 'drawing').value).toBe(4);
    const updated = mergeInputEvidence(resolved, [{ ...observations()[0], id: 'drawing-revision-2', value: 7 }]);
    expect(() => assertResolvedInput(updated)).toThrow('INPUT_EVIDENCE_UNRESOLVED');
    const reviewedAgain = mergeInputEvidence(updated, [{ ...resolution(), id: 'review-2',
      resolution: { selectedSource: 'drawing-revision-2', reason: 'Reviewed new drawing revision' } }]);
    expect(() => assertResolvedInput(reviewedAgain)).not.toThrow();
    expect(reviewedAgain.filter((item) => item.status === 'resolved')).toHaveLength(2);
    expect(reviewedAgain.find((item) => item.id === 'drawing').value).toBe(4);
    expect(mergeInputEvidence(reviewedAgain, [observations()[0]])).toEqual(reviewedAgain);
  });
  test('raw legacy append-only resolutions only cover preceding observations', () => {
    const raw = [...observations(), resolution()];
    expect(() => assertResolvedInput(raw)).not.toThrow();
    expect(() => assertResolvedInput([...raw, { id: 'later', field: 'span', value: 8, unit: 'm' }])).toThrow('INPUT_EVIDENCE_UNRESOLVED');
    expect(() => assertResolvedInput([...observations(), { ...resolution(), resolution: { selectedSource: 'absent', reason: 'Typo' } }])).toThrow('INPUT_EVIDENCE_UNRESOLVED');
  });
  test('an explicit corrected value can resolve reviewed missing evidence but not later conflicting input', () => {
    const resolved = mergeInputEvidence([{ id: 'missing', field: 'span', status: 'missing' }], [
      { id: 'value-review', field: 'span', status: 'resolved', resolution: { value: 4, unit: 'm', reason: 'User supplied the missing dimension' } },
    ]);
    expect(() => assertResolvedInput(resolved)).not.toThrow();
    expect(() => assertResolvedInput(mergeInputEvidence(resolved, [{ id: 'new', field: 'span', value: 5, unit: 'm' }]))).toThrow('INPUT_EVIDENCE_UNRESOLVED');
  });
});

describe('immutable run collections', () => {
  test('D/L and combination are separate with explicit selection, never summed implicitly', async () => {
    const requests = []; let saved;
    const result = await executeAnalysisRun({ model: model(), type: 'static', parameters: {} }, async (request) => {
      requests.push(request); return { success: true, data: { reactions: { a: { fz: requests.length } } } };
    }, async (id, record) => { saved = record; expect(id).toBe(record.runId); });
    expect(requests.map((r) => r.parameters)).toEqual([{ loadCaseIds: ['D'] }, { loadCaseIds: ['L'] }, { loadCombinationId: 'U' }]);
    expect(Object.keys(result.results)).toEqual(['case:D', 'case:L', 'combination:U']);
    expect(saved.request.model).toEqual(model()); expect(result.meta.modelHash).toBe(modelHash(model()));
  });
  test('unknown selectors fail before execution', () => {
    expect(() => analysisSelections(model(), { loadCaseIds: ['NO'] }, 'static')).toThrow('LOAD_CASE_NOT_FOUND');
  });
  test('legacy aliases normalize before splitting and never leak into child requests', async () => {
    const requests = [];
    const m = model(); m.load_combinations.push({ id: 'S', factors: { D: 1, L: 1 } });
    const result = await executeAnalysisRun({ model: m, type: 'static', parameters: {
      load_case_ids: ['D'], combinationIds: ['U', 'S'], loadCases: [], floorLoadTransferMode: 'node_tributary',
    } }, async (request) => { requests.push(request.parameters); return { success: true, data: {} }; }, async () => {});
    expect(Object.keys(result.results)).toEqual(['case:D', 'combination:U', 'combination:S']);
    expect(requests).toEqual([
      { floorLoadTransferMode: 'node_tributary', loadCaseIds: ['D'] },
      { floorLoadTransferMode: 'node_tributary', loadCombinationId: 'U' },
      { floorLoadTransferMode: 'node_tributary', loadCombinationId: 'S' },
    ]);
    for (const alias of ['load_combination_id', 'combinationId']) {
      expect(analysisSelections(m, { [alias]: 'S' }, 'static')).toEqual([{ key: 'combination:S', kind: 'combination', id: 'S' }]);
    }
  });
  test('conflicting aliases and load overrides fail before invoking the solver', async () => {
    const m = model(); m.load_combinations.push({ id: 'S', factors: { D: 1, L: 1 } });
    let invoked = false;
    const invoke = async () => { invoked = true; return { success: true, data: {} }; };
    for (const parameters of [
      { loadCombinationIds: ['U', 'S'], combinationIds: ['U'] },
      { loadCaseIds: ['D'], load_case_ids: ['L'] },
      { loadCombinationId: 'U', combinationId: 'S' },
    ]) await expect(executeAnalysisRun({ model: m, type: 'static', parameters }, invoke, async () => {})).rejects.toThrow('CONFLICTING_RESULT_SELECTION');
    for (const parameters of [{ loadCases: [{ loads: [{ node: 'a', fz: 999 }] }] }, { batchCases: [{ id: 'other' }] }]) {
      await expect(executeAnalysisRun({ model: m, type: 'static', parameters }, invoke, async () => {})).rejects.toThrow('MODEL_LOAD_OVERRIDES_UNSUPPORTED');
    }
    expect(invoked).toBe(false);
    expect(analysisSelections(m, { loadCaseIds: ['D'], load_case_ids: ['D'] }, 'static')).toEqual([{ key: 'case:D', kind: 'case', id: 'D' }]);
    expect(() => analysisSelections(m, { loadCaseIds: [] }, 'static')).toThrow('INVALID_RESULT_SELECTION');
  });
  test('unverified commercial SDK mappings are unsupported capabilities rather than numerical failures', () => {
    for (const error_code of ['YJK_NATIVE_MATERIAL_GRADE_UNVERIFIED', 'PKPM_NATIVE_MATERIAL_PROPERTIES_UNVERIFIED', 'PKPM_NATIVE_SECTION_PROPERTIES_UNVERIFIED']) {
      expect(executionStatus({ success: false, error_code })).toBe('unsupported');
    }
  });
  test('one failed case does not become a successful current run', async () => {
    let calls = 0;
    const result = await executeAnalysisRun({ model: model(), type: 'static', parameters: {} }, async () => {
      if (++calls === 2) throw new Error('No solver'); return { success: true, data: {} };
    }, async () => {});
    expect(result.success).toBe(false); expect(result.results['case:L'].success).toBe(false);
    expect(result.results['case:D'].success).toBe(true);
  });
});

test('sessions serialize competing writes but permit independent conversations', async () => {
  const lock = new SessionLock(); const releaseA = await lock.acquire('a'); let acquired = false;
  const waiting = lock.acquire('a').then((release) => { acquired = true; return release; });
  const releaseB = await lock.acquire('b'); expect(acquired).toBe(false); releaseB(); releaseA();
  (await waiting)(); expect(acquired).toBe(true);
});

test('later tool in one batch sees the new model revision', async () => {
  let observed;
  const write = tool(async () => new Command({ update: { modelRevision: 4 } }), { name: 'write', description: 'write', schema: z.object({}) });
  const read = tool(async (_, config) => { observed = config.configurable.agentState.modelRevision; return 'ok'; }, { name: 'read', description: 'read', schema: z.object({}) });
  const state = { modelRevision: 3, artifacts: {}, analysisRuns: {}, messages: [new AIMessage({ content: '', tool_calls: [{ name: 'write', args: {}, id: '1' }, { name: 'read', args: {}, id: '2' }] })] };
  const first = await executeToolsSequentially([write, read], state, { configurable: {} });
  expect(observed).toBeUndefined();
  await executeToolsSequentially([write, read], { ...state, ...first.update, messages: [...state.messages, ...first.update.messages] }, { configurable: {} });
  expect(observed).toBe(4);
});

test('checks retain each case and expose incomplete scope independently of execution', async () => {
  const seen = [];
  const checked = await checkRunResults({ selectedResultKey: 'case:D', results: {
    'case:D': { success: true, selection: { id: 'D' }, meta: { runId: 'r' } },
    'case:L': { success: true, selection: { id: 'L' }, meta: { runId: 'r' } },
  } }, async (r) => {
    seen.push(r.selection.id);
    return r.selection.id === 'D'
      ? { completionStatus: 'complete', complianceStatus: 'fail', summary: { total: 1, failed: 1, maxUtilization: 1.2 }, details: [{ elementId: 'beam' }] }
      : { completionStatus: 'incomplete', complianceStatus: 'incomplete', summary: { total: 1, inputRequired: 1, maxUtilization: null }, details: [] };
  });
  expect(seen).toEqual(['D', 'L']); expect(checked.complianceStatus).toBe('fail');
  expect(checked.completionStatus).toBe('incomplete'); expect(checked.summary.maxUtilization).toBe(1.2);
  expect(checked.details[0].resultKey).toBe('case:D');
  expect(formatCheckSummary(checked.summary, 'en')).toContain('input required 1');
  expect(formatCheckSummary(checked.summary, 'zh')).toContain('资料不足 1');
});

test('failed recompute clears the old current analysis but preserves history', async () => {
  const fail = tool(async () => { throw new Error('solver unavailable'); }, { name: 'run_analysis', description: 'test', schema: z.object({}) });
  const result = await executeToolsSequentially([fail], { artifacts: {}, analysisRuns: {}, analysisResult: { runId: 'previous', success: true },
    messages: [new AIMessage({ content: '', tool_calls: [{ name: 'run_analysis', args: {}, id: 'r' }] })] }, { configurable: {} });
  expect(result.update.analysisResult).toBeNull(); expect(result.update.analysisRuns.previous.success).toBe(true);
});
