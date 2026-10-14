import { beforeAll, describe, expect, test } from '@jest/globals';
import { createEditModelTool } from '../dist/agent-langgraph/model-tools.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { commitModel } from '../dist/engineering/model-state.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { scenarios } from './fixtures/opensees-chain-reference.mjs';

const protocol = createLocalStructureProtocolClient();
const editModel = createEditModelTool();
let state;
beforeAll(async () => {
  const source = structuredClone(scenarios[0].model);
  source.load_cases = [{ id: 'D', type: 'dead', loads: [
    { id: 'P', type: 'point', element: 'AB', position: 2, fz: -1 },
  ] }];
  source.load_combinations = [];
  for (const element of source.elements) delete element.design;
  const model = await normalizeEngineeringModel(source, protocol);
  state = { ...commitModel({}, model, 'initial'), inputEvidence: [],
    analysisResult: { runId: 'previous-run', success: true },
    codeCheckResult: { runId: 'previous-run' }, report: { runId: 'previous-run' } };
});

const splitEdits = load => [
  { operation: 'add', collection: 'nodes', id: 'mid', values: { x: 2, y: 0, z: 0 } },
  { operation: 'update', collection: 'elements', id: 'AB', values: { nodes: ['A', 'mid'] } },
  { operation: 'add', collection: 'elements', id: 'mid-B', values: {
    type: 'beam', nodes: ['mid', 'B'], material: 'steel', section: 's',
  } },
  { operation: 'update', collection: 'load_cases', id: 'D', values: { loads: [{ id: 'P', ...load }] } },
];
const invoke = edits => editModel.invoke({ baseRevision: state.modelRevision, edits }, {
  toolCall: { id: 'load-contract-edit' }, configurable: { agentState: state, structureProtocolClient: protocol },
});

describe('edit_model through the real Python V2 boundary', () => {
  test.each([
    [{ type: 'point', node: 'mid', fz: -1 }, /must target an element/],
    [{ type: 'point', element: 'AB', fz: -1 }, /finite nonnegative position/],
    [{ type: 'distributed', node: 'mid' }, /must target an element/],
    [{ type: 'nodal', element: 'AB' }, /must target a node/],
  ])('rejects invalid load semantics before committing any part of a batch: %j', async (load, error) => {
    const before = structuredClone(state);
    const failure = await invoke(splitEdits(load)).catch(reason => reason);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/failed StructureModel v2 validation/);
    expect(JSON.stringify(failure.detail)).toMatch(error);
    // Failed validation preserves the original topology, revision, history and current delivery.
    expect(state).toEqual(before);
    expect(state.model.nodes.some(node => node.id === 'mid')).toBe(false);
    expect(state.modelRevision).toBe(1);
    expect(state.analysisResult.runId).toBe('previous-run');
  });

  test('the explicitly corrected nodal load commits the whole edit and invalidates current results', async () => {
    const before = structuredClone(state);
    const response = await invoke(splitEdits({ type: 'nodal', node: 'mid', fz: -1 }));
    expect(response.update.modelRevision).toBe(2);
    expect(response.update.modelHistory).toHaveLength(2);
    expect(response.update.model.nodes.some(node => node.id === 'mid')).toBe(true);
    expect(response.update.model.load_cases[0].loads[0]).toMatchObject({ id: 'P', type: 'nodal', node: 'mid', fz: -1 });
    expect(response.update.analysisResult).toBeNull();
    expect(response.update.codeCheckResult).toBeNull();
    expect(response.update.report).toBeNull();
    expect(response.update.analysisRuns['previous-run']).toEqual(state.analysisResult);
    expect(state).toEqual(before);
  });
});
