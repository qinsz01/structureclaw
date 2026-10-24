import { expect, test } from '@jest/globals';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { assertNoTerminalSemanticFailure } from '../../../dist/agent-langgraph/guards/terminal-failures.js';

test.each(['en', 'zh'])('terminal model failure preserves the actual diagnosis (%s)', locale => {
  const receipt = { success: false, errorCode: 'MODEL_PHYSICS_INVALID', modelBuilt: false, terminal: true,
    diagnostics: [{ code: 'LOAD_TARGET_INVALID', severity: 'error', entityIds: ['bad-source-id'],
      message: { en: 'Use the original confirmed load ID.', zh: '请使用原始已确认荷载编号。' },
      details: { error: 'Error: LOAD_MAPPING_ID_INVALID: bad-source-id' } }] };
  const messages = [new HumanMessage('Build the confirmed frame.'), new ToolMessage({ name: 'build_model', tool_call_id: 'build', content: JSON.stringify(receipt) })];
  const saved = JSON.stringify(messages);
  let failure;
  try { assertNoTerminalSemanticFailure(messages, locale); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toContain(receipt.diagnostics[0].message[locale]);
  expect(failure.message).toContain('LOAD_MAPPING_ID_INVALID: bad-source-id');
  expect(failure.message).not.toContain('MODEL_PHYSICS_INVALID: MODEL_PHYSICS_INVALID');
  expect(JSON.stringify(messages)).toBe(saved);
});
