import { describe, expect, test } from '@jest/globals';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { applyFinalAnswerPolicy } from '../../../dist/agent-langgraph/delivery/final-answer.js';

describe('agent graph empty final response failure', () => {
  test.each(['en', 'zh'])('fails without inventing a response or changing saved tool results (%s)', locale => {
    const analysisResult = { runId: 'saved-run', success: true };
    const state = { locale, analysisResult };
    for (const currentTurnMessages of [[], [new ToolMessage({ name: 'run_analysis', tool_call_id: 'analysis', content: '{"success":true}' })]]) {
      expect(() => applyFinalAnswerPolicy({ response: new AIMessage('  '), hasToolCalls: false,
        currentTurnMessages, state, log: { warn() {} } })).toThrow('LLM_EMPTY_RESPONSE:');
      expect(state.analysisResult).toBe(analysisResult);
    }
  });

  test('keeps normal text and tool-call responses unchanged', () => {
    for (const response of [new AIMessage('Done'), new AIMessage({ content: '', tool_calls: [
      { name: 'memory', args: { action: 'list' }, id: 'memory', type: 'tool_call' },
    ] })]) {
      expect(applyFinalAnswerPolicy({ response, hasToolCalls: response.tool_calls.length > 0,
        currentTurnMessages: [], state: { locale: 'en' }, log: { warn() {} } })).toBe(response);
    }
  });
});
