import { describe, expect, test } from '@jest/globals';
import { projectAnalysisForChat, projectReportForChat, projectChatResult, projectChatStreamChunk, createChatStreamProjection } from '../dist/services/chat-artifacts.js';

function fixture() {
  const source = { kind: 'native', convention: { force: 'kN', moment: 'kN.m' }, geometry: { axis: [1, 0, 0] } };
  const data = { units: { force: 'kN', displacement: 'm' }, summary: { maxDisplacement: .002 },
    displacements: { n: { ux: 0, uy: 0, uz: -.002 } }, reactions: { n: { fz: 42 } },
    forces: { b: { n1: { N: -42 }, n2: { N: -40 } } },
    memberStations: { b: [{ N: -42, source }] }, nativeContext: { vendor: 'audit' },
    memberResponses: [{ id: 'b', length: 2, state: 'native-stations', reason: 'native', samples: [
      { x: 0, position: [0, 0, 0], side: 'right', N: -42, V2: 1, V3: 2, M2: 3, M3: 4, T: 5, provenance: 'solver-direct', source },
      { x: 2, position: [2, 0, 0], side: 'left', N: -40, V2: 0, V3: 1, M2: 2, M3: 3, T: 4, provenance: 'solver-direct', source },
    ] }], customEngineField: { keep: 9 }, responseDefinition: { available: ['forces', 'reactions'] } };
  return { runId: 'r', selectedResultKey: 'case:D', success: true, meta: { runId: 'r', modelHash: 'hash', settingsHash: 'settings' },
    data: { ...data, caseResults: { D: data, L: data } }, results: {
      'case:D': { success: true, selection: { key: 'case:D', kind: 'case', id: 'D' }, meta: { runId: 'r' }, data: { ...data, caseResults: { D: data, L: data } } },
      'case:L': { success: true, selection: { key: 'case:L', kind: 'case', id: 'L' }, meta: { runId: 'r' }, data },
    } };
}

describe('chat artifact projection', () => {
  test('keeps every independent result and numeric sample without mutating the archived run', () => {
    const raw = fixture(), before = structuredClone(raw), view = projectAnalysisForChat(raw);
    expect(raw).toEqual(before);
    expect(Object.keys(view.results)).toEqual(['case:D', 'case:L']);
    expect(view.data).toBeUndefined();
    expect(view.selectedDataReference).toEqual({ resultKey: 'case:D' });
    expect(view.artifactReference).toEqual({ kind: 'analysis-run', runId: 'r' });
    for (const key of Object.keys(raw.results)) {
      const original = raw.results[key].data, projected = view.results[key].data;
      for (const field of ['units', 'displacements', 'reactions', 'forces', 'summary', 'customEngineField', 'responseDefinition']) expect(projected[field]).toEqual(original[field]);
      expect(projected.memberResponses).toHaveLength(original.memberResponses.length);
      for (const [i, sample] of original.memberResponses[0].samples.entries()) {
        const { source: _source, ...numbersAndScope } = sample;
        expect(projected.memberResponses[0].samples[i]).toEqual({ ...numbersAndScope,
          source: { kind: 'run-member-sample', runId: 'r', resultKey: key, memberId: 'b', sampleIndex: i } });
      }
      expect(projected.nativeContext).toBeUndefined();expect(projected.memberStations).toBeUndefined();
    }
    expect(view.results['case:D'].data.caseResults).toBeUndefined();
    expect(projectAnalysisForChat(view)).toEqual(view);
  });

  test('legacy data with no run archive is left intact, including provenance', () => {
    const raw = fixture().data;
    expect(projectAnalysisForChat(raw)).toBe(raw);
  });

  test('forces-only placeholder internals never regain displacements through chat projection', () => {
    const raw = fixture();raw.meta.stiffnessPlaceholder = { material: true, section: true };
    const view = projectAnalysisForChat(raw);
    expect(raw.results['case:D'].data.displacements).toBeDefined();
    for (const result of Object.values(view.results)) {
      expect(result.data.displacements).toBeUndefined();
      expect(result.data.responseDefinition.unavailable).toContain('displacements');
    }
  });

  test('unrepresented legacy cases and station-only results remain available', () => {
    const raw = fixture();raw.results['case:D'].data.caseResults.EXTRA = { forces: { extra: 2 }, memberStations: { x: [1] } };
    const projected = projectAnalysisForChat(raw).results['case:D'].data;
    expect(projected.caseResults.EXTRA).toEqual(raw.results['case:D'].data.caseResults.EXTRA);
  });

  test('failed or missing children never inherit the selected successful result', () => {
    const raw = fixture();raw.results['case:L'] = { success: false, error_code: 'FAILED', data: null };
    const view = projectAnalysisForChat(raw);
    expect(view.results['case:L']).toEqual(raw.results['case:L']);
    delete raw.results['case:D'];
    expect(projectAnalysisForChat(raw).selectedDataReference).toBeUndefined();
  });

  test('chat reports reference the full run instead of embedding all solver fields again', () => {
    const raw = { summary: 'ok', markdown: '# Report', json: { analysis: fixture(), keyMetrics: { max: 42 }, normalizedModel: { nodes: [] }, meta: { runId: 'r' } } };
    const before = structuredClone(raw), view = projectReportForChat(raw);
    expect(raw).toEqual(before);expect(view.json.analysis).toBeUndefined();
    expect(view.json.analysisReference).toEqual({ kind: 'analysis-run', runId: 'r', selectedResultKey: 'case:D', resultKeys: ['case:D', 'case:L'] });
    for (const key of ['keyMetrics', 'normalizedModel', 'meta']) expect(view.json[key]).toEqual(raw.json[key]);
    expect(projectReportForChat(view)).toEqual(view);
    expect(projectReportForChat({ json: { analysis: { success: true } } })).toEqual({ json: { analysis: { success: true } } });
  });

  test('sync results and streamed artifact/final events use the same projection', () => {
    const result = { response: 'ok', analysis: fixture(), report: { markdown: 'ok' } };
    for (const chunk of [{ type: 'result', content: result }, { type: 'artifact_payload_sync', artifact: 'analysis', latestResult: result }]) {
      const view = projectChatStreamChunk(chunk);
      expect(view.content ?? view.latestResult).toEqual(projectChatResult(result));
    }
    expect(projectChatStreamChunk({ type: 'error', error: 'no' })).toEqual({ type: 'error', error: 'no' });
  });

  test('incomplete canonical member recovery does not erase unrepresented native stations', () => {
    const raw = fixture();raw.results['case:D'].data.memberResponses = [];
    expect(projectAnalysisForChat(raw).results['case:D'].data.memberStations).toEqual(raw.results['case:D'].data.memberStations);
  });

  test('one SSE connection sends each artifact once and references only the identical current value', () => {
    const project = createChatStreamProjection(), analysis = fixture(), model = { nodes: [] };
    const first = project({ type: 'artifact_payload_sync', artifact: 'analysis', latestResult: { analysis } });
    const geometry = project({ type: 'artifact_payload_sync', artifact: 'model', model });
    const final = project({ type: 'result', content: { response: 'ok', analysis, model } });
    expect(final.content).toEqual({ response: 'ok', artifactReferences: { analysis: first.artifactId, model: geometry.artifactId } });
    const changed = structuredClone(analysis);
    project({ type: 'artifact_payload_sync', artifact: 'analysis', latestResult: { analysis } });
    expect(project({ type: 'result', content: { analysis: changed } }).content.analysis).toEqual(projectAnalysisForChat(changed));
  });

  test('invalidation and separate SSE turns cannot reuse stale references', () => {
    const first = createChatStreamProjection(), second = createChatStreamProjection(), analysis = fixture();
    first({ type: 'artifact_payload_sync', artifact: 'analysis', latestResult: { analysis } });
    first({ type: 'artifact_payload_sync', artifact: 'analysis', invalidated: true });
    for (const project of [first, second]) expect(project({ type: 'result', content: { analysis } }).content.artifactReferences).toBeUndefined();
  });
});
