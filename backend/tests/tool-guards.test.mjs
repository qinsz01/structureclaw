// Unit tests for the tool-scheduling guards (agent-langgraph/guards). End-to-end behaviour is
// covered by tests/characterization/guard-fault-injection.test.mjs.
import { describe, expect, test } from '@jest/globals';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

const guards = await import('../dist/agent-langgraph/guards/tool-guards.js');
const { structuredToolError } = await import('../dist/agent-langgraph/guards/tool-errors.js');
const { repairResponseToolCalls } = await import('../dist/agent-langgraph/guards/response-guards.js');
const { createRunContext, withRunContext } = await import('../dist/runtime/run-context.js');
const { resolveRunPolicy } = await import('../dist/runtime/run-policy.js');

const policy = (requested = {}) => resolveRunPolicy({ availableSkillIds: [], availableToolIds: ['query_results', 'ask_user_clarification'],
  defaultToolIds: ['query_results', 'ask_user_clarification'], requested });
const toolNames = ['query_results', 'ask_user_clarification'];

describe('tool guards', () => {
  test('a user clarification resets rejection and no-progress streaks', () => {
    const context = createRunContext(policy());
    const ledger = guards.guardLedger(context);
    ledger.noProgressStreak = 7;
    ledger.blocked.push({ guard: 'repeated-failure', tool: 'query_results', code: 'RUN_NOT_FOUND' });
    ledger.stop = { reason: 'repeated-blocks', calls: 2 };
    guards.resetClarificationGuards(context);
    expect(guards.guardLedger(context)).toMatchObject({ noProgressStreak: 0, blocked: [] });
    expect(guards.guardLedger(context).stop).toBeUndefined();
  });
  test('call signatures ignore key order, blank values and surrounding whitespace', () => {
    expect(guards.callSignature('q', { b: 1, a: ' x ', c: null, d: '' })).toBe(guards.callSignature('q', { a: 'x', b: 1 }));
    expect(guards.callSignature('q', { a: 'x' })).not.toBe(guards.callSignature('q', { a: 'y' }));
  });

  test('failure codes come from the leading code, schema errors or a stable text hash', () => {
    expect(guards.failureCode('RUN_NOT_FOUND: abc')).toBe('RUN_NOT_FOUND');
    expect(guards.failureCode('Error: Received tool input did not match expected schema')).toBe('INVALID_TOOL_ARGUMENTS');
    expect(guards.failureCode('something odd')).toBe(guards.failureCode('something odd'));
    expect(guards.failureCode('something odd')).toMatch(/^TOOL_FAILED_[0-9a-f]{8}$/);
  });

  test('identical failures are blocked at the limit; the stop limit follows repair.enabled', () => {
    for (const [requested, stopAfter] of [[{}, 2], [{ profile: 'no-repair' }, 1]]) {
      const context = createRunContext(policy(requested));
      withRunContext(context, () => {
        const ledger = guards.guardLedger(context);
        const call = { name: 'query_results', args: { runId: 'x' } };
        const repairEnabled = context.policy.repair.enabled;
        for (let n = 0; n < guards.REPEATED_FAILURE_LIMIT; n += 1) {
          expect(guards.preflightToolCall({ call, toolNames, messages: [], ledger, repairEnabled })).toBeUndefined();
          guards.recordToolResult(ledger, call, 'RUN_NOT_FOUND', false);
        }
        const blocked = guards.preflightToolCall({ call, toolNames, messages: [], ledger, repairEnabled });
        expect(blocked.kind).toBe('blocked');
        expect(JSON.parse(blocked.content)).toMatchObject({ errorCode: 'REPEATED_FAILED_CALL', previousErrorCode: 'RUN_NOT_FOUND' });
        expect(Boolean(ledger.stop)).toBe(stopAfter === 1);
        guards.preflightToolCall({ call, toolNames, messages: [], ledger, repairEnabled });
        expect(ledger.stop).toMatchObject({ reason: 'repeated-blocks' });
        expect(context.usage.guards['repeated-failure']).toBe(stopAfter);
      });
    }
  });

  test('a different error code restarts the count; a success clears it', () => {
    const context = createRunContext(policy());
    const ledger = guards.guardLedger(context);
    const call = { name: 'query_results', args: {} };
    guards.recordToolResult(ledger, call, 'RUN_NOT_FOUND', false);
    guards.recordToolResult(ledger, call, 'RESULT_NOT_FOUND', false);
    expect(guards.preflightToolCall({ call, toolNames, messages: [], ledger, repairEnabled: true })).toBeUndefined();
    guards.recordToolResult(ledger, call, undefined, false);
    guards.recordToolResult(ledger, call, 'RESULT_NOT_FOUND', false);
    expect(guards.preflightToolCall({ call, toolNames, messages: [], ledger, repairEnabled: true })).toBeUndefined();
  });

  test('a state change clears the failure history so a fixed call may be retried', () => {
    const ledger = guards.guardLedger(createRunContext(policy()));
    const call = { name: 'query_results', args: {} };
    guards.recordToolResult(ledger, call, 'RUN_NOT_FOUND', false);
    guards.recordToolResult(ledger, call, 'RUN_NOT_FOUND', false);
    guards.recordToolResult(ledger, { name: 'edit_model', args: { baseRevision: 1 } }, undefined, true);
    expect(guards.preflightToolCall({ call, toolNames, messages: [], ledger, repairEnabled: true })).toBeUndefined();
  });

  test('no-progress ends the turn after the limit; state changes and new reads reset it', () => {
    const ledger = guards.guardLedger(createRunContext(policy()));
    const call = { name: 'query_results', args: {} };
    guards.recordToolResult(ledger, call, undefined, false); // new information
    for (let n = 1; n < guards.NO_PROGRESS_LIMIT; n += 1) guards.recordToolResult(ledger, call, undefined, false);
    guards.recordToolResult(ledger, call, undefined, true); // state progress
    expect(ledger.stop).toBeUndefined();
    for (let n = 0; n < guards.NO_PROGRESS_LIMIT; n += 1) guards.recordToolResult(ledger, call, undefined, false);
    expect(ledger.stop).toEqual({ reason: 'no-progress', calls: guards.NO_PROGRESS_LIMIT });
  });

  test('duplicate clarifications are matched by normalized question and need an answer', () => {
    const answered = new ToolMessage({ name: 'ask_user_clarification', tool_call_id: 'c1',
      content: JSON.stringify({ type: 'clarification_answered', question: '请问梁的跨度是多少？', answer: '6米' }) });
    const messages = [new HumanMessage('分析梁'), new AIMessage(''), answered, new HumanMessage('继续')];
    expect(guards.findAnsweredClarification('请问梁的跨度是多少', messages)).toEqual({ question: '请问梁的跨度是多少？', answer: '6米', source: 'tool' });
    expect(guards.findAnsweredClarification('请提供荷载大小与位置', messages)).toBeUndefined();
    const empty = new ToolMessage({ name: 'ask_user_clarification', tool_call_id: 'c2',
      content: JSON.stringify({ type: 'clarification_answered', question: 'Span?', answer: ' ' }) });
    expect(guards.findAnsweredClarification('Span?', [new HumanMessage('x'), empty])).toBeUndefined();
    // Older turns are out of scope: only the current and the previous turn are searched.
    const old = [new HumanMessage('t1'), answered, new HumanMessage('t2'), new HumanMessage('t3')];
    expect(guards.findAnsweredClarification('请问梁的跨度是多少', old)).toBeUndefined();
    expect(guards.questionSimilarity('What is the span?', 'what is the span')).toBe(1);
  });

  test('a clarification asked under another model revision or draft may be asked again', () => {
    const before = { modelRevision: 1, draftState: { inferredType: 'beam', engineeringDraft: { geometry: { lengthM: 6 } } } };
    const token = guards.clarificationStateToken(before);
    const answered = new ToolMessage({ name: 'ask_user_clarification', tool_call_id: 'c1',
      content: JSON.stringify({ type: 'clarification_answered', question: 'What is the section?', answer: 'H300', stateToken: token }) });
    const messages = [new HumanMessage('beam'), new AIMessage(''), answered];
    expect(guards.findAnsweredClarification('What is the section?', messages, token)).toMatchObject({ answer: 'H300' });
    const edited = guards.clarificationStateToken({ ...before, modelRevision: 2 });
    const redrafted = guards.clarificationStateToken({ ...before, draftState: { ...before.draftState, engineeringDraft: { geometry: { lengthM: 8 } } } });
    expect(guards.findAnsweredClarification('What is the section?', messages, edited)).toBeUndefined();
    expect(guards.findAnsweredClarification('What is the section?', messages, redrafted)).toBeUndefined();
  });

  test.each(['no_change', 'partial'])('an invalid answer twice may be re-asked after %s extraction', status => {
    const messages = [new HumanMessage('Analyze the beam')];
    for (let attempt = 0; attempt < 2; attempt++) {
      messages.push(new ToolMessage({ name: 'ask_user_clarification', tool_call_id: `q${attempt}`,
        content: JSON.stringify({ type: 'clarification_answered', question: 'Span in metres?', answer: 'unknown', stateToken: 'same' }) }));
      messages.push(new ToolMessage({ name: 'extract_draft_params', tool_call_id: `e${attempt}`,
        content: JSON.stringify({ status, unapplied: status === 'partial' ? [{ field: 'lengthM', reason: 'not a number' }] : [] }) }));
      expect(guards.preflightToolCall({ call: { name: 'ask_user_clarification', args: { question: 'Span in metres?' } },
        toolNames, messages, stateToken: 'same', ledger: guards.guardLedger(createRunContext(policy())), repairEnabled: true })).toBeUndefined();
    }
    messages.push(new ToolMessage({ name: 'ask_user_clarification', tool_call_id: 'q3',
      content: JSON.stringify({ type: 'clarification_answered', question: 'Span in metres?', answer: '6', stateToken: 'same' }) }));
    messages.push(new ToolMessage({ name: 'extract_draft_params', tool_call_id: 'e3',
      content: JSON.stringify({ status: 'applied', unapplied: [] }) }));
    expect(guards.findAnsweredClarification('Span in metres?', messages, 'same')).toMatchObject({ answer: '6' });
  });

  test('unknown tools and malformed arguments are rejected without a run context', () => {
    const unknown = guards.preflightToolCall({ call: { name: 'magic', args: {} }, toolNames, messages: [], ledger: undefined, repairEnabled: true });
    expect(unknown.kind).toBe('rejected');
    expect(JSON.parse(unknown.content)).toMatchObject({ errorCode: 'UNKNOWN_TOOL', availableTools: ['ask_user_clarification', 'query_results'] });
    const malformed = guards.preflightToolCall({ call: { name: 'query_results', args: { [guards.MALFORMED_ARGUMENTS_KEY]: '{bad' } },
      toolNames, messages: [], ledger: undefined, repairEnabled: true });
    expect(JSON.parse(malformed.content)).toMatchObject({ errorCode: 'MALFORMED_TOOL_ARGUMENTS', receivedArguments: '{bad' });
  });
});

describe('structured tool errors', () => {
  const state = { model: { nodes: [{ id: 'A' }, { id: 'B' }], elements: [{ id: 'beam' }], load_cases: [{ id: 'LC1' }] },
    analysisResult: { runId: 'r1', results: { 'case:LC1': {} } }, analysisRuns: { r0: {} } };

  test('thrown ToolNode text becomes JSON with a code and hint', () => {
    expect(JSON.parse(structuredToolError('Error: No draft state available.\n Please fix your mistakes.', 'x', state)))
      .toEqual({ success: false, errorCode: 'TOOL_EXECUTION_FAILED', error: 'No draft state available.', hint: expect.any(String) });
  });

  test('unknown-ID errors list the existing IDs', () => {
    expect(JSON.parse(structuredToolError('Error: RUN_NOT_FOUND\n Please fix your mistakes.', 'RUN_NOT_FOUND', state)))
      .toMatchObject({ errorCode: 'RUN_NOT_FOUND', availableRunIds: ['r0', 'r1'] });
    expect(JSON.parse(structuredToolError('Error: RESULT_NODE_NOT_FOUND', 'RESULT_NODE_NOT_FOUND', state))).toMatchObject({ availableNodeIds: ['A', 'B'] });
    expect(JSON.parse(structuredToolError('Error: MEMBER_NOT_FOUND', 'MEMBER_NOT_FOUND', state))).toMatchObject({ availableElementIds: ['beam'] });
    expect(JSON.parse(structuredToolError('Error: MODEL_OBJECT_NOT_FOUND: elements:x', 'MODEL_OBJECT_NOT_FOUND: elements:x', state)))
      .toMatchObject({ collection: 'elements', availableIds: ['beam'] });
    expect(JSON.parse(structuredToolError(JSON.stringify({ success: false, errorCode: 'RESULT_NOT_FOUND' }), 'RESULT_NOT_FOUND', state)))
      .toMatchObject({ availableResultKeys: ['case:LC1'] });
  });

  test('already structured errors without an ID problem are left unchanged', () => {
    expect(structuredToolError(JSON.stringify({ success: false, errorCode: 'CURRENT_ANALYSIS_REQUIRED' }), 'CURRENT_ANALYSIS_REQUIRED', state)).toBeUndefined();
  });
});

describe('response tool-call repair', () => {
  test('executable responses are returned unchanged', () => {
    const response = new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'query_results', args: {}, type: 'tool_call' }] });
    expect(repairResponseToolCalls(response)).toBe(response);
  });

  test('missing ids are generated and unparseable arguments are marked', () => {
    const response = new AIMessage({ content: 'x', tool_calls: [{ name: 'query_results', args: { a: 1 }, type: 'tool_call' }],
      invalid_tool_calls: [{ name: 'query_model', args: '{}', type: 'invalid_tool_call' }, { id: 'bad', name: 'run_analysis', args: 'x=1', type: 'invalid_tool_call' }] });
    const repaired = repairResponseToolCalls(response);
    expect(repaired.invalid_tool_calls).toEqual([]);
    expect(repaired.tool_calls.map(call => [call.name, call.args])).toEqual([
      ['query_results', { a: 1 }], ['query_model', {}], ['run_analysis', { [guards.MALFORMED_ARGUMENTS_KEY]: 'x=1' }]]);
    expect(repaired.tool_calls.every(call => typeof call.id === 'string' && call.id.length > 0)).toBe(true);
    expect(repaired.tool_calls[2].id).toBe('bad');
  });
});
