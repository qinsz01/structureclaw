import { describe, expect, test, jest } from '@jest/globals';
const extract = jest.fn();
jest.unstable_mockModule('../../../dist/agent-langgraph/param-extractor.js', () => ({ invokeParamExtractor: extract }));

test('design extraction uses the formal schema and rejects bad generated fields before changing the draft', async () => {
  const { handler } = await import('../../../dist/agent-skills/structure-type/beam/handler.js');
  const { createExtractDraftParamsTool } = await import('../../../dist/agent-langgraph/tools.js');
  const { createLocalStructureProtocolClient } = await import('../../../dist/services/structure-protocol-execution.js');
  const { engineeringModelSchema, draftDesignSchema } = await import('../../../dist/engineering/model-edit-contract.js');
  const client = createLocalStructureProtocolClient();
  const contract = draftDesignSchema(await engineeringModelSchema(client));
  expect(contract.$defs.MemberDesign.additionalProperties).toBe(false);
  expect(contract.$defs.MemberDesign.properties.basis.additionalProperties.type).toBe('string');
  const plugin = { id: 'beam', structureType: 'beam', manifest: { structuralTypeKeys: ['beam'] }, handler };
  const tool = createExtractDraftParamsTool({ resolvePluginForType: async () => plugin });
  const state = { structuralTypeKey: 'beam', draftState: handler.mergeState(undefined, handler.extractDraft({ locale: 'en',
    llmDraftPatch: { engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 } } } })) };
  const before = structuredClone(state);
  const requestScope = { responses: ['forces'], design: true, report: false, outputs: [] };
  const invoke = () => tool.invoke({ message: 'Use the supplied design conditions', requestScope },
    { toolCall: { id: 'design-extract' }, configurable: { structureProtocolClient: client, agentState: state } });
  for (const design of [
    { basis: { noNewLoadCombinations: true } }, { basis: { capacityCheck: { caseId: 'LC1' } } },
    { stressCheckType: 'elastic' }, { sectionPlasticDevelopment: false },
  ]) {
    extract.mockResolvedValue({ engineeringDraft: { templateAssignments: { beam: { design } } } });
    await expect(invoke()).rejects.toThrow('MODEL_EDIT_FIELD_INVALID');
    expect(state).toEqual(before);
    expect(extract.mock.lastCall[0].designSchema).toEqual(contract);
  }
  extract.mockResolvedValue({ engineeringDraft: { materials: [{ id: 'M', design: { f: 215, fv: 125, basis: { source: 'Supplied' } } }],
    templateAssignments: { beam: { design: { l0: 4800, serviceability_result_keys: ['case:LC1'],
      basis: { capacityCheck: 'Use case:LC1 only', assumptions: 'Elastic stress; no plastic development' } } } } } });
  const result = await invoke();
  expect(result.update.draftState.engineeringDraft.templateAssignments.beam.design).toMatchObject({ l0: 4800,
    serviceability_result_keys: ['case:LC1'], basis: { assumptions: 'Elastic stress; no plastic development' } });
  expect(result.update.draftState.engineeringDraft.materials[0].design.f).toBe(215);
  expect(state).toEqual(before);

  // Malformed extraction is a failure, not a successful merge that resets the
  // correction path. Tool rejections do not consume recoveries; the third identical
  // call is refused by the repeated-failure guard without running the extractor again.
  const { AIMessage } = await import('@langchain/core/messages');
  const { executeToolsSequentially } = await import('../../../dist/agent-langgraph/sequential-tools.js');
  const { createRunContext, withRunContext } = await import('../../../dist/runtime/run-context.js');
  const { resolveRunPolicy } = await import('../../../dist/runtime/run-policy.js');
  const context = createRunContext(resolveRunPolicy({ availableSkillIds: ['beam'], availableToolIds: ['extract_draft_params'],
    defaultToolIds: ['extract_draft_params'], requested: { repair: { enabled: true, maxRecoveriesPerTurn: 2 } } }));
  extract.mockClear();
  extract.mockResolvedValue({ engineeringDraft: { templateAssignments: { beam: { design: { basis: { bad: true } } } } } });
  for (let attempt = 0; attempt < 4; attempt++) {
    const command = await withRunContext(context, () => executeToolsSequentially([tool], { ...state, messages: [new AIMessage({ content: '',
      tool_calls: [{ id: `attempt-${attempt}`, name: 'extract_draft_params', args: { message: 'Use supplied conditions', requestScope } }] })] },
      { configurable: { structureProtocolClient: client } }));
    expect(command.update.messages[0].status).toBe('error');
    expect(command.update.messages[0].content).toContain(attempt >= 2 ? 'REPEATED_FAILED_CALL' : 'MODEL_EDIT_FIELD_INVALID');
    expect(command.update.draftState).toBeUndefined();
  }
  expect(context.usage.recoveries).toBe(0);
  expect(extract).toHaveBeenCalledTimes(2);
});
describe('missing engineering input is clarification, not recovery', () => {
  test('accepted new parameters archive the old run through the direct tool entry', async () => {
    const { handler } = await import('../../../dist/agent-skills/structure-type/beam/handler.js');
    const { createExtractDraftParamsTool } = await import('../../../dist/agent-langgraph/tools.js');
    const plugin = { id: 'beam', structureType: 'beam', manifest: { structuralTypeKeys: ['beam'] }, handler };
    extract.mockResolvedValue({ engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 } } });
    const oldRun = { runId: 'old-run', success: true };
    const result = await createExtractDraftParamsTool({ resolvePluginForType: async () => plugin }).invoke({ message: '10m beam',
      requestScope: { responses: ['forces'], design: false, report: false, outputs: [] } },
    { toolCall: { id: 'accepted-change' }, configurable: { agentState: { structuralTypeKey: 'beam', analysisResult: oldRun, report: { runId: 'old-run' } } } });
    expect(result.update.analysisResult).toBeNull();
    expect(result.update.report).toBeNull();
    expect(result.update.modelPending).toBe(true);
    expect(result.update.analysisRuns['old-run']).toEqual(oldRun);
  });

  test.each([
    {}, { design: true }, { responses: [] }, { responses: undefined }, { responses: 'forces' },
  ])('valid outer scope survives an incomplete internal scope %j without re-extraction', async internalScope => {
    const { handler } = await import('../../../dist/agent-skills/structure-type/beam/handler.js');
    const { createExtractDraftParamsTool } = await import('../../../dist/agent-langgraph/tools.js');
    const { createRunContext, withRunContext } = await import('../../../dist/runtime/run-context.js');
    const { resolveRunPolicy } = await import('../../../dist/runtime/run-policy.js');
    const plugin = { id: 'beam', structureType: 'beam', manifest: { structuralTypeKeys: ['beam'] }, handler };
    const runtime = { resolvePluginForType: async () => plugin };
    const context = createRunContext(resolveRunPolicy({ availableSkillIds: ['beam'], availableToolIds: ['extract_draft_params', 'ask_user_clarification'], defaultToolIds: ['extract_draft_params', 'ask_user_clarification'],
      requested: { repair: { enabled: false } } }));
    const scope = { responses: ['forces', 'reactions'], design: true, report: false, outputs: [] };
    extract.mockClear();
    extract.mockResolvedValue({ engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
      loads: [{ kind: 'point', magnitude: 1, unit: 'kN', location: { xM: 5 } }] }, requestScope: internalScope });
    const result = await withRunContext(context, () => createExtractDraftParamsTool(runtime).invoke({
      message: '设计一个简支梁，跨度10m，梁中间荷载1kN', locale: 'zh', requestScope: scope,
    }, { toolCall: { id: 'extract-internal-scope' }, configurable: { agentState: { structuralTypeKey: 'beam' } } }));
    const output = JSON.parse(result.update.messages[0].content);
    expect(output.requestScope).toEqual(scope);
    expect(output.nextState.engineeringDraft.geometry.lengthM).toBe(10);
    expect(output.nextState.engineeringDraft.loads).toHaveLength(1);
    expect(output.nextAction).toBe('ask_user_clarification');
    expect(output.criticalMissing).toContain('templateProperties');
    expect(extract).toHaveBeenCalledTimes(1);
    expect(context.usage.recoveries).toBe(0);
    expect(context.usage.pendingFailures).toEqual({});
  });

  test.each([true, false])('one extraction preserves missing fields with repair enabled=%s', async enabled => {
    const { handler } = await import('../../../dist/agent-skills/structure-type/beam/handler.js');
    const { createExtractDraftParamsTool } = await import('../../../dist/agent-langgraph/tools.js');
    const { createRunContext, withRunContext } = await import('../../../dist/runtime/run-context.js');
    const { resolveRunPolicy } = await import('../../../dist/runtime/run-policy.js');
    const plugin = { id: 'beam', structureType: 'beam', manifest: { structuralTypeKeys: ['beam'] }, handler };
    const runtime = { resolvePluginForType: async () => plugin };
    const policy = resolveRunPolicy({ availableSkillIds: ['beam'], availableToolIds: ['extract_draft_params', 'ask_user_clarification'], defaultToolIds: ['extract_draft_params', 'ask_user_clarification'], requested: { repair: { enabled, maxRecoveriesPerTurn: 2 } } });
    const context = createRunContext(policy);
    extract.mockClear();
    extract.mockResolvedValue({ engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' }, loads: [{ kind: 'point', magnitude: 1, unit: 'kN', location: { xM: 5 } }] } });
    const result = await withRunContext(context, () => createExtractDraftParamsTool(runtime).invoke({ message: '设计一个简支梁，跨度10m，梁中间荷载1kN', locale: 'zh' }, { toolCall: { id: 'extract-missing' }, configurable: { agentState: { structuralTypeKey: 'beam' } } }));
    const output = JSON.parse(result.update.messages[0].content);
    expect(output.criticalMissing).toContain('templateProperties');
    expect(output.nextAction).toBe('ask_user_clarification');
    expect(output.canProceed).toBe(false);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(context.usage.recoveries).toBe(0);
    expect(output.nextState.engineeringDraft.geometry.lengthM).toBe(10);
  });
  test.each(['zh','en'])('unknown internal response goal asks once while preserving engineering input (%s)', async locale => {
    const { handler } = await import('../../../dist/agent-skills/structure-type/beam/handler.js');
    const { createExtractDraftParamsTool } = await import('../../../dist/agent-langgraph/tools.js');
    const plugin = { id: 'beam', structureType: 'beam', manifest: { structuralTypeKeys: ['beam'] }, handler };
    extract.mockClear();
    extract.mockResolvedValue({ engineeringDraft: { structureType:'beam', geometry:{lengthM:10}, boundary:{supportType:'simply-supported'},
      loads:[{kind:'point',magnitude:1,unit:'kN',location:{xM:5}}] }, requestScope:{design:true,responses:[]} });
    const result=await createExtractDraftParamsTool({resolvePluginForType:async()=>plugin}).invoke({message:'10m beam, 1kN at midspan',locale},
      {toolCall:{id:'unknown-goal'},configurable:{agentState:{structuralTypeKey:'beam'}}});
    const output=JSON.parse(result.update.messages[0].content);
    expect(output.criticalMissing).toEqual(['requestScope']);
    expect(output.nextAction).toBe('ask_user_clarification');
    expect(output.clarificationQuestions).toHaveLength(1);
    expect(output.clarificationQuestions[0].question).toMatch(locale==='zh'?/所求|需要/:/need/);
    expect(output.nextState.engineeringDraft.geometry.lengthM).toBe(10);
    expect(output.nextState.engineeringDraft.loads).toHaveLength(1);
    expect(extract).toHaveBeenCalledTimes(1);
  });
});
