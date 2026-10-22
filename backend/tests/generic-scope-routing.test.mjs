import { describe, expect, jest, test } from '@jest/globals';
import { AgentSkillRuntime } from '../dist/agent-runtime/index.js';
import { resolveRunPolicy } from '../dist/runtime/run-policy.js';
import { createRunContext, withRunContext } from '../dist/runtime/run-context.js';

const policy = requested => resolveRunPolicy({ requested, availableSkillIds: ['beam', 'generic'],
  availableToolIds: ['extract_draft_params'], defaultToolIds: ['extract_draft_params'] });

describe('a sole generic scope needs no LLM routing decision', () => {
  test('routes directly without spending an LLM call or recovery', async () => {
    const runtime = new AgentSkillRuntime();
    const invoke = jest.fn(() => { throw new Error('Unnecessary router invocation'); });
    const context = createRunContext(policy({ skillIds: ['generic'] }));
    const match = await withRunContext(context, () => runtime.detectStructuralTypeWithLlm({ invoke },
      'Build a frame with a cantilever and a diagonal brace.', 'en', undefined, ['generic']));
    expect(match).toMatchObject({ skillId: 'generic', supportLevel: 'fallback' });
    expect(invoke).not.toHaveBeenCalled();
    expect(context.usage.llmCalls).toBe(0);
    expect(context.usage.recoveries).toBe(0);
    expect(context.usage.events).toContainEqual(expect.objectContaining({ kind: 'structural_routing', path: 'scope-only', skillId: 'generic' }));
  });

  test('an explicit empty scope never enables generic', async () => {
    const runtime = new AgentSkillRuntime();
    const context = createRunContext(policy({ skillIds: [] }));
    const match = await withRunContext(context, () => runtime.detectStructuralTypeWithLlm(null, 'Build a beam.', 'en', undefined, []));
    expect(match.skillId).toBeUndefined();
    expect(match.supportLevel).toBe('unsupported');
  });

  test('fixed routing retains precedence', async () => {
    const runtime = new AgentSkillRuntime();
    const context = createRunContext(policy({ skillIds: ['generic'], routing: { mode: 'fixed', skillId: 'generic' } }));
    const match = await withRunContext(context, () => runtime.detectStructuralTypeWithLlm(null, 'Build a beam.', 'en', undefined, ['generic']));
    expect(match).toMatchObject({ skillId: 'generic', routingSource: 'policy-fixed' });
  });
});
