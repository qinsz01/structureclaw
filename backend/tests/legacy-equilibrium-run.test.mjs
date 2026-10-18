// Read-only compatibility: runs archived by the retired equilibrium shortcut (engine builtin-equilibrium)
// still load, list and display their saved forces and reactions. Nothing new is computed for them.
import { describe, test, expect, beforeAll } from '@jest/globals';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SCLAW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-legacy-equilibrium-'));
const archive = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/legacy-equilibrium-run.json'), 'utf8'));
let loadAnalysisRun, resultCatalogEntry, createQueryResultsTool;

beforeAll(async () => {
  const runDir = path.join(process.env.SCLAW_DATA_DIR, 'runs', archive.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(archive));
  ({ loadAnalysisRun } = await import('../dist/engineering/analysis-runs.js'));
  ({ resultCatalogEntry } = await import('../dist/engineering/result-selection.js'));
  ({ createQueryResultsTool } = await import('../dist/agent-langgraph/model-tools.js'));
});

const query = async (state, args) => {
  const command = await createQueryResultsTool().invoke(args, { toolCall: { id: 'legacy-query' }, configurable: { agentState: state } });
  return JSON.parse(command.update.messages[0].content).quantity;
};

describe('legacy builtin-equilibrium runs', () => {
  test('the archived run loads with its engine, saved reactions and member forces', async () => {
    const run = await loadAnalysisRun(archive.runId);
    expect(run.meta.engineId).toBe('builtin-equilibrium');
    expect(run.data.reactions.A.fz).toBe(0.5);
    expect(run.data.memberResponses[0].samples.length).toBeGreaterThan(0);
    const entry = resultCatalogEntry(run, false);
    expect(entry).toMatchObject({ runId: archive.runId, analysisType: 'static', nodes: ['A', 'B'], members: ['beam'] });
    expect(entry.results).toEqual([expect.objectContaining({ key: 'case:LC1', available: true })]);
  });

  test('saved reactions are queryable; responses the run never stored are reported unavailable', async () => {
    const run = await loadAnalysisRun(archive.runId);
    const state = { analysisResult: run };
    expect((await query(state, { runId: run.runId, nodeId: 'B', field: 'reactions', component: 'fz', unit: 'kN' })).value).toBe(0.5);
    await expect(query(state, { runId: run.runId, nodeId: 'B', field: 'displacements', component: 'uz', unit: 'mm' }))
      .rejects.toThrow('RESULT_FIELD_UNAVAILABLE');
  });
});
