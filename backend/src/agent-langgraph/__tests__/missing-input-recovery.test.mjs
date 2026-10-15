import { describe, expect, test, jest } from '@jest/globals';
const extract = jest.fn();
jest.unstable_mockModule('../../../dist/agent-langgraph/param-extractor.js', () => ({ invokeParamExtractor: extract }));
describe('missing engineering input is clarification, not recovery', () => {
  test('accepted new parameters archive the old run through the direct tool entry', async () => {
    const { handler } = await import('../../../dist/agent-skills/structure-type/beam/handler.js');
    const { createExtractDraftParamsTool } = await import('../../../dist/agent-langgraph/tools.js');
    const plugin = { id: 'beam', structureType: 'beam', manifest: { structuralTypeKeys: ['beam'] }, handler };
    extract.mockResolvedValue({ engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 } } });
    const oldRun = { runId: 'old-run', success: true };
    const result = await createExtractDraftParamsTool({ resolvePluginForType: async () => plugin }).invoke({ message: '10m beam',
      requestScope: { responses: ['forces'], method: 'solver', design: false, report: false, outputs: [] } },
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
    const context = createRunContext(resolveRunPolicy({ availableSkillIds: ['beam'], availableToolIds: ['extract_draft_params'], defaultToolIds: ['extract_draft_params'],
      requested: { repair: { enabled: false } } }));
    const scope = { responses: ['forces', 'reactions'], method: 'solver', design: true, report: false, outputs: [] };
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
    const policy = resolveRunPolicy({ availableSkillIds: ['beam'], availableToolIds: ['extract_draft_params'], defaultToolIds: ['extract_draft_params'], requested: { repair: { enabled, maxRecoveriesPerTurn: 2 } } });
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
