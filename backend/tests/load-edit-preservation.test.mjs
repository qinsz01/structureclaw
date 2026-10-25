import { beforeAll, describe, expect, test } from '@jest/globals';
import { createEditModelTool } from '../dist/agent-langgraph/model-tools.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { commitModel } from '../dist/engineering/model-state.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { scenarios } from './fixtures/opensees-chain-reference.mjs';

const protocol = createLocalStructureProtocolClient(), tool = createEditModelTool();
let state;
beforeAll(async () => {
  const source = structuredClone(scenarios[0].model);
  source.load_cases = [{ id: 'D', type: 'dead', loads: [
    { id: 'P', type: 'point', element: 'AB', position: 2, fz: -30 },
    { id: 'Q', type: 'point', element: 'AB', position: 3, fz: -25 },
  ] }];
  source.load_combinations = [];
  for (const element of source.elements) delete element.design;
  const model = await normalizeEngineeringModel(source, protocol);
  state = { ...commitModel({}, model, 'initial'), analysisResult: { runId: 'previous-run' }, report: { json: { meta: { runId: 'previous-run' } } } };
});
const invoke = edits => tool.invoke({ baseRevision: state.modelRevision, edits }, {
  toolCall: { id: 'preserve-loads' }, configurable: { agentState: state, structureProtocolClient: protocol },
});
const loads = () => structuredClone(state.model.load_cases[0].loads);
const caseUpdate = rows => ({ operation: 'update', collection: 'load_cases', id: 'D', values: { loads: rows } });

describe('load updates cannot silently delete omitted records', () => {
  test.each(['partial', 'empty'])('rejects an implicit %s replacement atomically', async kind => {
    const before = structuredClone(state), replacement = kind === 'empty' ? [] : [{ ...loads()[1], fz: -20 }];
    const failure = await invoke([caseUpdate(replacement)]).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('MODEL_EDIT_EXPLICIT_LOAD_REMOVAL_REQUIRED');
    expect(failure.message).toContain('collection="loads"');
    expect(state).toEqual(before);
    expect(state.modelRevision).toBe(1);expect(state.analysisResult.runId).toBe('previous-run');
  });

  test('a load ID update changes only that load and invalidates the old analysis', async () => {
    const before = structuredClone(state);
    const result = await invoke([{ operation: 'update', collection: 'loads', caseId: 'D', id: 'Q', values: { fz: -20 } }]);
    expect(result.update.model.load_cases[0].loads).toEqual([loads()[0], { ...loads()[1], fz: -20 }]);
    expect(result.update.modelRevision).toBe(2);expect(result.update.analysisResult).toBeNull();
    expect(result.update.analysisRuns['previous-run']).toEqual(state.analysisResult);
    expect(state).toEqual(before);
  });

  test('a complete array retaining all IDs remains an explicit supported update', async () => {
    const rows = loads();rows[1].fz = -20;
    const result = await invoke([caseUpdate(rows)]);
    expect(result.update.model.load_cases[0].loads).toEqual(rows);
  });

  test('explicit per-load removal followed by a replacement is supported', async () => {
    const rows = [{ ...loads()[1], fz: -20 }];
    const result = await invoke([{ operation: 'remove', collection: 'loads', caseId: 'D', id: 'P' }, caseUpdate(rows)]);
    expect(result.update.model.load_cases[0].loads).toEqual(rows);
    expect(state.model.load_cases[0].loads).toHaveLength(2);
  });

  test('explicitly removing and replacing a complete case is supported', async () => {
    const replacement = { ...state.model.load_cases[0], loads: [{ ...loads()[1], fz: -20 }] };
    const result = await invoke([{ operation: 'remove', collection: 'load_cases', id: 'D' },
      { operation: 'add', collection: 'load_cases', id: 'D', values: replacement }]);
    expect(result.update.model.load_cases[0].loads).toEqual(replacement.loads);
  });
});
