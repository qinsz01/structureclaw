import { describe, expect, test, jest } from '@jest/globals';
const extract = jest.fn();
jest.unstable_mockModule('../../../dist/agent-langgraph/param-extractor.js', () => ({ invokeParamExtractor: extract }));
describe('missing engineering input is clarification, not recovery', () => {
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
});
