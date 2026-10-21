import { expect, test } from '@jest/globals';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { AgentSkillRuntime } from '../../../dist/agent-runtime/index.js';
import { createAskUserClarificationTool } from '../../../dist/agent-langgraph/tools/ask-clarification.js';
import { compactDraftToolPayload } from '../../../dist/agent-langgraph/draft-tool-summary.js';

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
