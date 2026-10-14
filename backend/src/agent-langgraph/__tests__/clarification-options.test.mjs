import { describe, expect, test } from '@jest/globals';
import { createAskUserClarificationTool } from '../../../dist/agent-langgraph/tools.js';
import { resolveRunPolicy } from '../../../dist/runtime/run-policy.js';
import { createRunContext, withRunContext } from '../../../dist/runtime/run-context.js';

describe('clarification option contract', () => {
  test('normalizes provider object choices before exposing them to a UI or host', async () => {
    const policy = resolveRunPolicy({ availableSkillIds: [], availableToolIds: ['ask_user_clarification'],
      defaultToolIds: ['ask_user_clarification'], executionOwner: 'external' });
    const output = await withRunContext(createRunContext(policy), () => createAskUserClarificationTool().invoke({
      question: 'Material and section?', optionsJson: JSON.stringify([
        { label: ' Q235, 100×200 mm ', value: 'alternative' }, { label: 'C30, 250×500 mm' },
        { label: '', text: 'Explicit elastic properties' }, { value: 'Other section' },
        ' Q235, 100×200 mm ', null, 42, { label: {} }, '',
      ]),
    }));
    expect(JSON.parse(output).options).toEqual(['Q235, 100×200 mm', 'C30, 250×500 mm', 'Explicit elastic properties', 'Other section']);
  });
});
