import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const extract = jest.fn();
jest.unstable_mockModule('../../../dist/agent-langgraph/param-extractor.js', () => ({ invokeParamExtractor: extract }));
const { createExtractDraftParamsTool } = await import('../../../dist/agent-langgraph/tools/extract-draft-params.js');
const { handler } = await import('../../../dist/agent-skills/structure-type/generic/handler.js');
const plugin = { id: 'generic', structureType: 'unknown', handler };
const match = { key: 'unknown', mappedType: 'unknown', skillId: 'generic', supportLevel: 'supported', routingSource: 'scope-selected' };
const scope = { responses: ['forces', 'reactions'], design: false, report: false, outputs: [] };
const patch = length => ({ engineeringDraft: { geometry: { lengthM: length }, boundary: { supportType: 'simply-supported' },
  loads: [{ id: 'P', kind: 'point', magnitude: 10, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: length / 2 } }] } });
const model = { nodes: [{ id: 'A', x: 0, y: 0, z: 0 }, { id: 'B', x: 8, y: 0, z: 0 }],
  elements: [{ id: 'AB', type: 'beam', nodes: ['A', 'B'] }], load_cases: [{ id: 'L', loads: [] }] };

async function invoke(state, locale, length = 10) {
  return createExtractDraftParamsTool({ resolvePluginForType: async () => plugin,
    detectStructuralTypeWithLlm: async () => match }).invoke({ message: `Use the confirmed ${length} m beam and 10 kN midpoint load.`, locale, requestScope: scope },
  { toolCall: { id: 'extract-model-action' }, configurable: { agentState: { ...state, requestScope: scope } } });
}

beforeEach(() => { extract.mockReset(); extract.mockResolvedValue(patch(10)); });

describe.each(['en', 'zh'])('extraction action guidance (%s)', locale => {
  test('a complete new draft proceeds to building', async () => {
    const result = await invoke({}, locale);
    expect(JSON.parse(result.update.messages[0].content)).toMatchObject({ canProceed: true, criticalMissing: [],
      status: 'applied', nextAction: 'build_model' });
    expect(result.update.draftState.engineeringDraft.geometry.lengthM).toBe(10);
  });

  test.each([8, 10])('an existing model is queried before choosing local edits or an authorized rebuild (prior length=%s)', async length => {
    extract.mockResolvedValueOnce(patch(length));
    const seeded = await invoke({}, locale, length);
    const draftState = seeded.update.draftState;
    const state = { model, modelRevision: 7, draftState };
    const before = structuredClone(state);
    const result = await invoke(state, locale);
    const receipt = JSON.parse(result.update.messages[0].content);
    expect(receipt).toMatchObject({ canProceed: true, criticalMissing: [], nextAction: 'query_model',
      status: length === 10 ? 'no_change' : 'applied' });
    expect(receipt.instruction).toContain('edit_model');
    expect(receipt.instruction).toContain('mode:"rebuild"');
    expect(receipt.instruction).toContain('baseRevision');
    expect(result.update).not.toHaveProperty('model');
    expect(state).toEqual(before);
  });

  test('an existing model does not turn genuinely missing draft inputs into a query/build action', async () => {
    extract.mockResolvedValue({ engineeringDraft: { geometry: { lengthM: 10 } } });
    const result = await invoke({ model, modelRevision: 7 }, locale);
    const receipt = JSON.parse(result.update.messages[0].content);
    expect(receipt).toMatchObject({ canProceed: false, nextAction: 'ask_user_clarification' });
    expect(receipt.criticalMissing).toEqual(expect.arrayContaining(['supports', 'loads']));
  });
});
