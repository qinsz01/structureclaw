import { expect, test } from '@jest/globals';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { AgentSkillRuntime } from '../../../dist/agent-runtime/index.js';
import { createAskUserClarificationTool } from '../../../dist/agent-langgraph/tools/ask-clarification.js';
import { compactDraftToolPayload } from '../../../dist/agent-langgraph/draft-tool-summary.js';
import { fieldContractFailure } from '../../../dist/agent-langgraph/capability-notice.js';

test('a mapped-answer contract fault ends the current turn with an honest explanation', () => {
  const fault = new ToolMessage({ name: 'extract_draft_params', tool_call_id: 'extract', content: JSON.stringify({
    errorCode: 'FIELD_CONTRACT_UNRESOLVED', message: 'The system failed to map your answer. Do not repeat it.',
  }) });
  expect(fieldContractFailure([new HumanMessage('fixed'), fault])).toBe('The system failed to map your answer. Do not repeat it.');
  expect(fieldContractFailure([fault, new HumanMessage('new request')])).toBeUndefined();
});

for (const locale of ['en', 'zh']) test(`scope exclusions are explicit (${locale})`, async () => {
  const runtime = new AgentSkillRuntime();
  const match = await runtime.detectStructuralTypeWithLlm(null, '计算混凝土框架', locale, undefined, ['beam', 'generic']);
  expect(match.scopeExclusion).toEqual({ code: 'STRUCTURE_SKILL_DISABLED', skillId: 'concrete-frame' });
  expect(match.supportNote).toContain(locale === 'zh' ? '能力未启用' : 'disabled');
  expect(match.skillId).toBe('generic');
});

test('a field contract fault cannot be overwritten by no_change or another clarification', async () => {
  const fault = { success: false, errorCode: 'FIELD_CONTRACT_UNRESOLVED', nextAction: 'report_internal_error',
    criticalMissing: ['boundary.frameBaseSupportType'], unresolved: [{ requiredPath: 'boundary.frameBaseSupportType', appliedPaths: ['engineeringDraft.boundary.supportType'] }] };
  const state = { inferredType: 'frame' };
  expect(compactDraftToolPayload(fault, state, state)).toMatchObject(fault);
  const response = await createAskUserClarificationTool().invoke({ question: 'Repeat the base support?' }, { configurable: {
    agentState: { messages: [new HumanMessage('fixed'), new ToolMessage({ name: 'extract_draft_params', content: JSON.stringify(fault), tool_call_id: 'extract' })] },
  } });
  expect(JSON.parse(response)).toMatchObject(fault);
});

test('a disabled capability notice is delivered even when the model omits it', async () => {
  const { withCapabilityNotice } = await import('../../../dist/agent-langgraph/capability-notice.js');
  const messages = [new HumanMessage('frame'), new ToolMessage({ name: 'detect_structure_type', tool_call_id: 'route',
    content: JSON.stringify({ scopeExclusion: { code: 'STRUCTURE_SKILL_DISABLED', skillId: 'frame' }, supportNote: 'Frame is disabled in Capability settings.' }) })];
  const answer = withCapabilityNotice(new AIMessage('Analysis complete.'), messages);
  expect(answer.content).toBe('Frame is disabled in Capability settings.\n\nAnalysis complete.');
  expect(withCapabilityNotice(answer, messages)).toBe(answer);
  const call = new AIMessage({ content: '', tool_calls: [{ name: 'build_model', args: {}, id: 'build' }] });
  expect(withCapabilityNotice(call, messages)).toBe(call);
});
