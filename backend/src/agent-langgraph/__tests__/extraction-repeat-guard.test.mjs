import { describe, expect, jest, test } from '@jest/globals';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { hasExtractedCurrentInput } from '../../../dist/agent-langgraph/tools/input-message.js';
import { toolContextForNode } from '../../../dist/agent-langgraph/graph.js';
import { executeToolsSequentially } from '../../../dist/agent-langgraph/sequential-tools.js';

const result = (name, payload) => new ToolMessage({ name, content: JSON.stringify(payload), tool_call_id: name });
const extracted = payload => result('extract_draft_params', { status: 'applied', applied: ['engineeringDraft.materials["M1"].grade'],
  unapplied: [], ...payload });
const messages = () => [new HumanMessage('材料Q235钢，截面工字钢I20a'), extracted()];

describe('one complete extraction per actual input', () => {
  test('the next model call and execution both exclude redundant extraction', async () => {
    const state = { messages: messages(), selectedSkillIds: ['beam'] };
    const context = toolContextForNode(state, {});
    expect(context.activeToolIds).not.toContain('extract_draft_params');
    expect(context.activeToolIds).toContain('ask_user_clarification');
    const invoke = jest.fn();
    const extractor = tool(invoke, { name: 'extract_draft_params', description: 'test', schema: z.object({}) });
    const update = await executeToolsSequentially([extractor], { ...state,
      messages: [...state.messages, new AIMessage({ content: '', tool_calls: [
        { name: 'extract_draft_params', args: {}, id: 'duplicate' },
      ] })] }, {});
    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.parse(update.update.messages[0].content)).toMatchObject({ errorCode: 'INPUT_ALREADY_EXTRACTED' });
  });

  test.each([
    new HumanMessage('H=200, B=100, tw=7, tf=11.4 mm'),
    result('ask_user_clarification', { type: 'clarification_answered', answer: '确认 H200,B100,tw7,tf11.4' }),
    result('read_file', { content: 'new attachment evidence' }),
    result('detect_structure_type', { type: 'frame' }),
  ])('new actual input or evidence enables extraction again: %#', evidence => {
    const state = { messages: [...messages(), evidence], selectedSkillIds: ['beam'] };
    expect(hasExtractedCurrentInput(state.messages)).toBe(false);
    expect(toolContextForNode(state, {}).activeToolIds).toContain('extract_draft_params');
  });

  test('a recoverable builder protocol diagnostic reopens extraction in both exposure and execution', async () => {
    const state = { messages: [...messages(), result('build_model', { success: false, modelBuilt: false,
      errorCode: 'DRAFT_PROTOCOL_INVALID', nextAction: 'extract_draft_params',
      repair: { clearDraftFields: ['sectionRecords["S1"].purpose'] } })], selectedSkillIds: ['generic'] };
    expect(hasExtractedCurrentInput(state.messages)).toBe(false);
    expect(toolContextForNode(state, {}).activeToolIds).toContain('extract_draft_params');
    const invoke = jest.fn(async () => '{}');
    const extractor = tool(invoke, { name: 'extract_draft_params', description: 'test', schema: z.object({}) });
    await executeToolsSequentially([extractor], { ...state, messages: [...state.messages,
      new AIMessage({ content: '', tool_calls: [{ name: 'extract_draft_params', args: {}, id: 'repair-protocol' }] })] }, {});
    expect(invoke).toHaveBeenCalledTimes(1);
    // A successful correction consumes the input again; it is not a permanent bypass.
    expect(hasExtractedCurrentInput([...state.messages, extracted()])).toBe(true);
  });

  test.each([
    { status: 'partial', unapplied: [{ path: 'sectionRecords', reason: 'invalid' }] },
    { status: 'no_change', applied: [], unapplied: [{ reason: 'missing evidence' }] },
    { status: 'failed', success: false },
  ])('an incomplete or failed attempt remains retryable: %j', payload => {
    expect(hasExtractedCurrentInput([new HumanMessage('input'), extracted(payload)])).toBe(false);
  });

  test('a no-change result also consumes the evidence, including checkpoint messages', () => {
    const message = extracted({ status: 'no_change', applied: [] });
    expect(hasExtractedCurrentInput([message.toJSON()])).toBe(true);
    expect(hasExtractedCurrentInput([...messages(), new AIMessage('try a different restatement')])).toBe(true);
    expect(hasExtractedCurrentInput([])).toBe(false);
  });
});
