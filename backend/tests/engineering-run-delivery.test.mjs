import { describe, expect, test } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeAnalysisRun, loadAnalysisRun } from '../dist/engineering/analysis-runs.js';
import { beginAnalysisRequest } from '../dist/engineering/model-state.js';
import { createQueryResultsTool } from '../dist/agent-langgraph/model-tools.js';
import { resultTableMarkdown, scalarResultQuantity } from '../dist/engineering/result-data.js';

describe('archived and requested results', () => {
  test('adapter provenance conflicts become failed archived results instead of being overwritten', async () => {
    const model = { nodes:[], elements:[], materials:[], sections:[], load_cases:[{id:'D',loads:[]}] };
    let archive;
    const run = await executeAnalysisRun({ model, type:'static', parameters:{} },
      async () => ({ success:true, meta:{ modelHash:'wrong-model' }, data:{ displacements:{a:{uz:99}} } }),
      async (_id, record) => { archive = record; });
    expect(run.success).toBe(false);
    expect(archive.results['case:D'].error_code).toBe('ANALYSIS_RESULT_BINDING_MISMATCH');
    expect(archive.results['case:D'].data.displacements).toBeUndefined();
  });
  test('run reload retains the physical snapshot and rejects traversal or inconsistent provenance', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'structureclaw-run-'));
    try {
      const model = { nodes: [], elements: [], materials: [], sections: [], load_cases: [{ id: 'D', loads: [] }] };
      let stored;
      const result = await executeAnalysisRun({ model, type: 'static', parameters: {} },
        async () => ({ success: true, data: { displacements: { tip: { uz: -0.001 } } } }),
        async (id, record) => { stored = record; await mkdir(path.join(directory, id));
          await writeFile(path.join(directory, id, 'run.json'), JSON.stringify(record)); });
      const loaded = await loadAnalysisRun(result.runId, directory);
      expect(loaded.modelSnapshot).toEqual(model);
      expect(loaded.results['case:D'].data.displacements.tip.uz).toBe(-0.001);
      await expect(loadAnalysisRun('../settings', directory)).rejects.toThrow('RUN_ID_INVALID');
      stored.request.model.nodes.push({ id: 'changed' });
      await writeFile(path.join(directory, result.runId, 'run.json'), JSON.stringify(stored));
      await expect(loadAnalysisRun(result.runId, directory)).rejects.toThrow('RUN_ARCHIVE_INVALID');
    } finally {
      if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('structureclaw-run-')) throw new Error('Invalid test directory');
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('a signed node query and bilingual report use the same value, case and unit', async () => {
    const model = { nodes: [], elements: [], materials: [], sections: [] };
    const state = { model, ...beginAnalysisRequest({ model }, 'settings'), resultQuantities: {}, analysisRuns: {} };
    state.analysisResult = { runId: 'r', selectedResultKey: 'case:D', meta: state.analysisRequest,
      results: { 'case:D': { success: true, meta: { runId: 'r' }, data: { reactions: { base: { fz: -.5 } } } } } };
    const response = await createQueryResultsTool().invoke({ field: 'reactions', nodeId: 'base',
      quantityId: 'reaction', component: 'fz', unit: 'N' }, { toolCall: { id: 'query' }, configurable: { agentState: state } });
    const quantity = response.update.resultQuantities['r:reaction'];
    expect(quantity).toMatchObject({ id: 'reaction', selection: 'case:D', value: -500, unit: 'N' });
    for (const locale of ['zh','en']) {
      const markdown = resultTableMarkdown({ ...state.analysisResult, requestedQuantities: [quantity,
        { ...quantity, runId: 'old', value: 999 }] }, locale);
      expect(markdown).toContain('| reaction | case:D | base | fz | -500 | N |');
      expect(markdown).not.toContain('999');
    }
  });

  test('wrong dimensions and display interpolation cannot masquerade as a recovered quantity', () => {
    expect(() => scalarResultQuantity({ fz: 3 }, 'fz', 'mm', false)).toThrow('RESULT_UNIT_MISMATCH');
    expect(() => scalarResultQuantity({ state: 'interpolated', sample: { V3: 2 } }, 'V3', 'kN', true)).toThrow('EXACT_MEMBER_RESPONSE_UNAVAILABLE');
    expect(() => scalarResultQuantity({ state: 'recovered', method: 'nearest-sample', sample: { V3: 2 } }, 'V3', 'kN', true)).toThrow('EXACT_MEMBER_RESPONSE_UNAVAILABLE');
  });
});
