import { describe, expect, jest, test } from '@jest/globals';
import { createBuildModelTool } from '../dist/agent-langgraph/tools/build-model.js';
import { tryBuildGenericModelWithLlm } from '../dist/agent-skills/structure-type/generic/llm-model-builder.js';
import { createRunContext, withRunContext } from '../dist/runtime/run-context.js';
import { resolveRunPolicy } from '../dist/runtime/run-policy.js';
import { genericFixtures } from './characterization/fixtures/generic-physics.mjs';

function fixture() {
  const candidate = structuredClone(genericFixtures.find(row => row.id === 'grid3d').model);
  candidate.load_cases[0].loads = [];
  candidate.metadata = { compileDraftLoads: true };
  const draftState = structuredClone(genericFixtures.find(row => row.id === 'grid3d').draft);
  draftState.updatedAt = 1;
  draftState.engineeringDraft.loadCases[0].loads = [];
  draftState.engineeringDraft.loads = [{ id: 'confirmed-roof-force', kind: 'nodal', magnitude: 9, unit: 'kN',
    direction: 'globalX', target: 'G111', caseId: 'LC1' }];
  const state = { draftState, model: structuredClone(genericFixtures.find(row => row.id === 'portal').model),
    modelRevision: 7, modelPending: true, modelHistory: [], messages: [], locale: 'en',
    lastUserMessage: 'Rebuild the complete 3D grid using all confirmed inputs. Keep the 100×200 mm rectangular sections and the 9 kN X force at G111.',
    analysisResult: { runId: 'prior-analysis' }, report: { markdown: 'Prior report' } };
  const buildModel = jest.fn(async (draft, _skills, options) => tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(candidate) }) },
    options.message, draft, options.locale, options.conversationHistory, options.signal, options.currentModel));
  const context = createRunContext(resolveRunPolicy({ availableSkillIds: ['generic'], availableToolIds: ['build_model'],
    requested: { repair: { enabled: false } } }));
  const invoke = input => withRunContext(context, () => createBuildModelTool({ buildModel }).invoke(input, {
    toolCall: { id: 'build' }, configurable: { agentState: state,
      structureProtocolClient: { post: async (_route, body) => ({ data: { model: body.model } }) } },
  }));
  return { candidate, state, buildModel, invoke };
}

describe('explicit complete model rebuild', () => {
  test.each([undefined, 'preserve'])('default/preserve mode retains the existing-model load compilation guard (%s)', async mode => {
    const { state, buildModel, invoke } = fixture();
    const saved = structuredClone(state);
    await expect(invoke(mode ? { mode } : {})).rejects.toThrow('DRAFT_LOAD_COMPILATION_CONFLICT');
    expect(buildModel.mock.calls[0][2].currentModel).toEqual(saved.model);
    expect(state).toEqual(saved);
  });

  test.each([undefined, 6])('rebuild rejects an absent/stale base revision before calling the builder (%s)', async baseRevision => {
    const { state, buildModel, invoke } = fixture();
    const saved = structuredClone(state);
    const result = await invoke({ mode: 'rebuild', ...(baseRevision === undefined ? {} : { baseRevision }) });
    expect(JSON.parse(result.update.messages[0].content)).toMatchObject({ success: false, modelBuilt: false,
      errorCode: 'MODEL_VERSION_CONFLICT', expectedRevision: 7, nextAction: 'query_model' });
    expect(buildModel).not.toHaveBeenCalled();
    expect(result.update.model).toBeUndefined();
    expect(state).toEqual(saved);
  });

  test.each([false, true])('authorized rebuild compiles the confirmed spatial draft and preserves the previous model in history (pending=%s)', async pending => {
    const { state, buildModel, invoke } = fixture();
    state.modelPending = pending;
    const saved = structuredClone(state);
    const result = await invoke({ mode: 'rebuild', baseRevision: 7 });
    const receipt = JSON.parse(result.update.messages[0].content);
    expect(receipt).toMatchObject({ success: true, buildMode: 'rebuild' });
    expect(buildModel.mock.calls[0][2].currentModel).toBeUndefined();
    expect(result.update).toMatchObject({ modelRevision: 8, modelPending: false, analysisResult: null, report: null });
    expect(result.update.model.coordinate_system.dimension).toBe('3d');
    expect(result.update.model.nodes).toHaveLength(18);
    expect(result.update.model.elements).toHaveLength(21);
    expect(result.update.model.load_cases[0].loads).toEqual([{ id: 'LC1:load:1', type: 'nodal', node: 'G111', fx: 9, reference_frame: 'global' }]);
    expect(result.update.modelHistory).toHaveLength(1);
    expect(result.update.modelHistory[0]).toMatchObject({ revision: 8, beforeModel: saved.model });
    expect(result.update.analysisRuns['prior-analysis']).toEqual(saved.analysisResult);
    expect(state).toEqual(saved);
  });

  test('a rebuild compilation failure preserves the saved model, draft, analysis and history', async () => {
    const { candidate, state, invoke } = fixture();
    candidate.load_cases[0].loads = [{ type: 'nodal', node: 'G111', fx: 99 }];
    const saved = structuredClone(state);
    await expect(invoke({ mode: 'rebuild', baseRevision: 7 })).rejects.toThrow('DRAFT_LOAD_COMPILATION_CONFLICT');
    expect(state).toEqual(saved);
  });
});
