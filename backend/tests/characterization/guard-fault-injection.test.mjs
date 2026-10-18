// Fault injection for the guard layer (agent-langgraph/guards, delivery/final-review.ts).
// The scripted LLM misbehaves on purpose: it repeats failing calls, thrashes without progress,
// re-asks an answered question, calls hallucinated tools/IDs, sends malformed arguments, invents
// result numbers, claims actions that never ran, and returns empty or truncated answers.
// Each case must recover or end honestly: no crash, no stream error, bounded LLM/tool calls,
// saved state unchanged, a terminal `done` event, and guard events in the run record.
import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, runTurn, setupHarness, toolResultSeenByAgent, TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { stepStatuses } from './helpers/normalize.mjs';
import { beamAnalysis, beamModel } from './fixtures/engineering-beam.mjs';

const ledgerFor = (ctx, runId) => ctx.backend.runRecords().find(item => item.name === `${runId}.json`)?.record;
const guardEvents = ledger => ledger.usage.events.filter(event => event.kind === 'guard').map(({ guard, action }) => `${guard}:${action}`);
const startedTools = ledger => ledger.usage.events.filter(event => event.kind === 'tool_started').map(event => event.name);
const agentRequests = turn => turn.requests.filter(request => request.kind === 'agent');
const lastUserText = request => {
  const messages = request.body.messages ?? [];
  const last = messages.at(-1);
  return last?.role === 'user' ? String(last.content) : '';
};
const midspanMoment = runId => ({ runId, resultKey: 'case:LC1', elementId: 'beam', positionM: 5, side: 'right',
  field: 'forces', component: 'M2', unit: 'kN.m' });

function expectTerminated(turn) {
  expect(turn.events.at(-1)).toEqual({ type: 'done' });
  expect(turn.result?.content?.response).toEqual(expect.any(String));
  expect(turn.result.content.response.trim().length).toBeGreaterThan(0);
}

async function seedAnalysis(ctx, prefix, locale = 'en', runPolicy) {
  const turn = await runTurn(ctx, {
    message: 'Analyze the supplied beam.',
    context: { locale, model: beamModel, modelFormat: 'structuremodel-v2', ...(runPolicy ? { runPolicy } : {}) },
  }, [toolCall('run_analysis', beamAnalysis, `${prefix}-seed`), 'SEEDED']);
  const session = await ctx.backend.session(turn.conversationId);
  expect(session.analysis.current).toBe(true);
  return { conversationId: turn.conversationId, session };
}

async function expectStateUnchanged(ctx, conversationId, before) {
  const after = await ctx.backend.session(conversationId);
  expect(after.analysis).toEqual(before.analysis);
  expect(after.report).toEqual(before.report);
  expect(after.modelRevision).toBe(before.modelRevision);
  return after;
}

describeWithOpenSees('characterization: guard layer fault injection', () => {
  const ctx = setupHarness();

  test('an identical failing call is not executed a third time; continuing ends the turn honestly', async () => {
    const { conversationId, session: before } = await seedAnalysis(ctx, 'repeat');
    const args = { runId: '00000000-0000-4000-8000-000000000000', field: 'reactions' };
    const turn = await runTurn(ctx, { conversationId, message: 'Show the reactions.', context: { locale: 'en' } },
      [1, 2, 3, 4].map(n => toolCall('query_results', args, `repeat-${n}`)), { expectedToolErrors: 4 });

    const first = toolResultSeenByAgent(turn.requests, 'repeat-1');
    expect(first).toMatchObject({ success: false, errorCode: 'RUN_NOT_FOUND', availableRunIds: [before.analysis.runId] });
    expect(toolResultSeenByAgent(turn.requests, 'repeat-3')).toMatchObject({ success: false, errorCode: 'REPEATED_FAILED_CALL',
      guard: 'repeated-failure', previousErrorCode: 'RUN_NOT_FOUND', previousFailures: 2 });
    // Four scripted calls, then the guard answers without a fifth LLM request.
    expect(agentRequests(turn)).toHaveLength(4);
    expectTerminated(turn);
    expect(turn.result.content.response).toContain('This turn was stopped automatically');
    expect(turn.result.content.response).toContain('query_results (RUN_NOT_FOUND)');
    expect(turn.result.content.response).toContain(`analysis results (run ${before.analysis.runId})`);

    const session = await expectStateUnchanged(ctx, conversationId, before);
    const ledger = ledgerFor(ctx, session.usage.runId);
    expect(startedTools(ledger)).toEqual(['query_results', 'query_results']);
    expect(guardEvents(ledger)).toEqual(['repeated-failure:blocked', 'repeated-failure:blocked', 'guard-stop:end-turn']);
    expect(ledger.usage.guards).toEqual({ 'repeated-failure': 2, 'guard-stop': 1 });
  }, TURN_TIMEOUT_MS);

  test('tool calls without state progress are bounded (identical reads and varying failures)', async () => {
    const { conversationId, session: before } = await seedAnalysis(ctx, 'thrash', 'zh');
    const reads = await runTurn(ctx, { conversationId, message: '检查模型。', context: { locale: 'zh' } },
      Array.from({ length: 9 }, (_, n) => toolCall('query_model', {}, `thrash-read-${n}`)));
    expect(agentRequests(reads)).toHaveLength(9);
    expect(stepStatuses(reads.steps).every(step => step.status === 'done')).toBe(true);
    expectTerminated(reads);
    expect(reads.result.content.response).toContain('连续 8 次工具调用没有产生新的模型、分析、报告或查询结果');
    let session = await expectStateUnchanged(ctx, conversationId, before);
    expect(guardEvents(ledgerFor(ctx, session.usage.runId))).toEqual(['no-progress:end-turn']);

    // Different arguments each time (so no identical repeat), every call failing or refused.
    const failures = await runTurn(ctx, { conversationId, message: '查询结果。', context: { locale: 'zh' } },
      Array.from({ length: 8 }, (_, n) => toolCall('query_results', { runId: `00000000-0000-4000-8000-00000000000${n}`, field: 'reactions' }, `thrash-fail-${n}`)),
      { expectedToolErrors: 8 });
    expect(agentRequests(failures)).toHaveLength(8);
    expectTerminated(failures);
    expect(failures.result.content.response).toContain('本轮已自动停止');
    session = await expectStateUnchanged(ctx, conversationId, before);
    const ledger = ledgerFor(ctx, session.usage.runId);
    // The existing recovery budget (2) still applies: only three calls were executed.
    expect(startedTools(ledger)).toEqual(['query_results', 'query_results', 'query_results']);
    expect(ledger.usage.recoveries).toBe(2);
    expect(guardEvents(ledger)).toEqual(['no-progress:end-turn']);
  }, TURN_TIMEOUT_MS * 2);

  test('a clarification answered earlier is not asked again in the same or the next turn', async () => {
    ctx.llm.setInternal(null);
    const question = 'What is the span length of the beam?';
    const asked = await runTurn(ctx, { message: 'Analyze a simply supported beam.', context: { locale: 'en' } },
      [toolCall('ask_user_clarification', { question }, 'dup-ask')]);
    expect(asked.interactions).toHaveLength(1);
    const resumed = await runTurn(ctx, { conversationId: asked.conversationId, resumeValue: 'The span is 6 m.' }, [
      toolCall('ask_user_clarification', { question: `${question} ` }, 'dup-again'),
      'Using the stored answer: span 6 m.',
    ], { resume: true, expectedToolErrors: 1 });
    expect(resumed.interactions).toEqual([]);
    expect(toolResultSeenByAgent(resumed.requests, 'dup-again')).toMatchObject({ success: false, errorCode: 'DUPLICATE_CLARIFICATION',
      previousQuestion: question, storedAnswer: 'The span is 6 m.' });
    expect(resumed.result.content.response).toBe('Using the stored answer: span 6 m.');

    const next = await runTurn(ctx, { conversationId: asked.conversationId, message: 'Continue.', context: { locale: 'en' } }, [
      toolCall('ask_user_clarification', { question: 'What is the span length of the beam' }, 'dup-next-turn'),
      'Continuing with the 6 m span.',
    ], { expectedToolErrors: 1 });
    expect(next.interactions).toEqual([]);
    expect(toolResultSeenByAgent(next.requests, 'dup-next-turn')).toMatchObject({ errorCode: 'DUPLICATE_CLARIFICATION' });
    expectTerminated(next);
    const session = await ctx.backend.session(asked.conversationId);
    expect(session.waitingForReply).toBe(false);
    expect(guardEvents(ledgerFor(ctx, session.usage.runId))).toEqual(['duplicate-clarification:blocked']);
  }, TURN_TIMEOUT_MS);

  test('hallucinated tools, unknown IDs and malformed arguments get structured errors and change nothing', async () => {
    const { conversationId, session: before } = await seedAnalysis(ctx, 'bad');
    const malformed = { role: 'assistant', content: '', tool_calls: [{ id: 'bad-malformed', type: 'function',
      function: { name: 'run_analysis', arguments: 'analysisType=static' } }] };
    const withoutId = { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'query_model', arguments: '{}' } }] };
    const turn = await runTurn(ctx, { conversationId, message: 'Inspect node Z.', context: { locale: 'en' } }, [
      toolCall('run_magic_solver', { everything: true }, 'bad-tool'),
      toolCall('query_results', { field: 'reactions', nodeId: 'Z' }, 'bad-node'),
      toolCall('edit_model', { baseRevision: before.modelRevision, edits: [{ operation: 'update', collection: 'nodes', id: 'Z', values: { x: 1 } }] }, 'bad-edit'),
      malformed,
      withoutId,
      'NO_CHANGES_MADE',
    ], { expectedToolErrors: 4 });

    const unknownTool = toolResultSeenByAgent(turn.requests, 'bad-tool');
    expect(unknownTool).toMatchObject({ success: false, errorCode: 'UNKNOWN_TOOL', guard: 'unknown-tool' });
    expect(unknownTool.availableTools).toEqual(expect.arrayContaining(['run_analysis', 'query_results', 'edit_model']));
    expect(toolResultSeenByAgent(turn.requests, 'bad-node')).toMatchObject({ success: false, errorCode: 'RESULT_NODE_NOT_FOUND',
      availableNodeIds: ['A', 'B'] });
    expect(toolResultSeenByAgent(turn.requests, 'bad-edit')).toMatchObject({ success: false, errorCode: 'MODEL_OBJECT_NOT_FOUND',
      collection: 'nodes', availableIds: ['A', 'B'] });
    expect(toolResultSeenByAgent(turn.requests, 'bad-malformed')).toMatchObject({ success: false, errorCode: 'MALFORMED_TOOL_ARGUMENTS',
      receivedArguments: 'analysisType=static' });
    // The call without an id received a generated id and executed normally.
    expect(stepStatuses(turn.steps).filter(step => step.tool === 'query_model')).toEqual([{ tool: 'query_model', status: 'done' }]);
    const repaired = turn.steps.find(step => step.tool === 'query_model' && step.status === 'done');
    expect(repaired?.id).toMatch(/^step-call_guard_/);
    expect(turn.result.content.response).toBe('NO_CHANGES_MADE');
    expectTerminated(turn);

    const session = await expectStateUnchanged(ctx, conversationId, before);
    const ledger = ledgerFor(ctx, session.usage.runId);
    expect(startedTools(ledger)).toEqual(['query_results', 'edit_model', 'query_model']);
    expect(guardEvents(ledger)).toEqual(['unknown-tool:rejected', 'malformed-arguments:rejected', 'missing-tool-call-id:repaired']);
  }, TURN_TIMEOUT_MS);

  test('invented result numbers get one correction; a repeated failure is flagged; inputs are not flagged', async () => {
    const { conversationId, session: before } = await seedAnalysis(ctx, 'numbers');
    const runId = before.analysis.runId;
    const corrected = await runTurn(ctx, { conversationId, message: 'What is the midspan moment?', context: { locale: 'en' } }, [
      'The midspan moment is 25 kN·m and the midspan deflection is 42.4 mm.',
      toolCall('query_results', midspanMoment(runId), 'numbers-query'),
      'The midspan moment is 2.5 kN·m (run result).',
    ]);
    const [, retry] = agentRequests(corrected);
    expect(lastUserText(retry)).toContain('[StructureClaw answer check]');
    expect(lastUserText(retry)).toContain('25 kN·m; 42.4 mm');
    expect(corrected.result.content.response).toBe('The midspan moment is 2.5 kN·m (run result).');
    let session = await ctx.backend.session(conversationId);
    expect(guardEvents(ledgerFor(ctx, session.usage.runId))).toEqual(['answer-integrity:correction-requested', 'answer-integrity:corrected']);

    const flagged = await runTurn(ctx, { conversationId, message: 'And the moment again?', context: { locale: 'en' } }, [
      'The moment is 30 kN·m.', 'I am confident it is 30 kN·m.',
    ]);
    expect(agentRequests(flagged)).toHaveLength(2);
    expect(flagged.result.content.response).toMatch(/^I am confident it is 30 kN·m\.\n\n---\nNote \(result check\): these values could not be verified/);
    expect(flagged.result.content.response).toContain('30 kN·m');
    session = await ctx.backend.session(conversationId);
    expect(guardEvents(ledgerFor(ctx, session.usage.runId))).toEqual(['answer-integrity:correction-requested', 'answer-integrity:flagged']);

    // Restating the user's inputs and the saved results is the normal path: no intervention.
    const inputs = 'For the 10 m span with a 1 kN midspan load, the reactions are 0.5 kN each and the midspan moment is 2.5 kN·m.';
    const normal = await runTurn(ctx, { conversationId, message: 'Summarize.', context: { locale: 'en' } }, [inputs]);
    expect(agentRequests(normal)).toHaveLength(1);
    expect(normal.result.content.response).toBe(inputs);
    session = await expectStateUnchanged(ctx, conversationId, before);
    expect(guardEvents(ledgerFor(ctx, session.usage.runId))).toEqual([]);
  }, TURN_TIMEOUT_MS * 2);

  test('claimed actions without a successful tool result or saved artifact are corrected or flagged', async () => {
    const { conversationId } = await seedAnalysis(ctx, 'claims', 'zh');
    const corrected = await runTurn(ctx, { conversationId, message: '总结一下。', context: { locale: 'zh' } }, [
      '报告已生成，所有验算均通过。',
      '分析已完成；尚未生成报告，也未进行规范校核。',
    ]);
    const [, retry] = agentRequests(corrected);
    expect(lastUserText(retry)).toContain('回答称已生成报告');
    expect(lastUserText(retry)).toContain('回答称校核通过');
    expect(corrected.result.content.response).toBe('分析已完成；尚未生成报告，也未进行规范校核。');

    const flagged = await runTurn(ctx, { conversationId, message: '再总结。', context: { locale: 'zh' } }, [
      '报告已生成。', '报告已生成，请查看。',
    ]);
    expect(flagged.result.content.response).toContain('报告已生成，请查看。\n\n---\n注意（结果核对）：回答称已生成报告');
    const session = await ctx.backend.session(conversationId);
    expect(guardEvents(ledgerFor(ctx, session.usage.runId))).toEqual(['answer-integrity:correction-requested', 'answer-integrity:flagged']);
  }, TURN_TIMEOUT_MS);

  test('no-repair: the answer is flagged without a correction retry and the first guard block ends the turn', async () => {
    const runPolicy = { profile: 'no-repair' };
    const { conversationId, session: before } = await seedAnalysis(ctx, 'norepair', 'en', runPolicy);
    const flagged = await runTurn(ctx, { conversationId, message: 'Moment?', context: { locale: 'en', runPolicy } },
      ['The moment is 30 kN·m.']);
    expect(agentRequests(flagged)).toHaveLength(1);
    expect(flagged.result.content.response).toContain('Note (result check)');
    let session = await ctx.backend.session(conversationId);
    expect(session.policy.profileId).toBe('no-repair');
    expect(guardEvents(ledgerFor(ctx, session.usage.runId))).toEqual(['answer-integrity:flagged']);

    const args = { runId: '00000000-0000-4000-8000-000000000000', field: 'reactions' };
    const blocked = await runTurn(ctx, { conversationId, message: 'Reactions?', context: { locale: 'en', runPolicy } },
      [1, 2, 3, 4].map(n => toolCall('query_results', args, `norepair-${n}`)), { expectedToolErrors: 4 });
    // Executed once; the next two are refused by the disabled recovery budget; the fourth is the guard block.
    expect(toolResultSeenByAgent(blocked.requests, 'norepair-2').error).toContain('RECOVERY_BUDGET_EXHAUSTED');
    expect(agentRequests(blocked)).toHaveLength(4);
    expectTerminated(blocked);
    expect(blocked.result.content.response).toContain('This turn was stopped automatically');
    session = await expectStateUnchanged(ctx, conversationId, before);
    const ledger = ledgerFor(ctx, session.usage.runId);
    expect(startedTools(ledger)).toEqual(['query_results']);
    expect(guardEvents(ledger)).toEqual(['repeated-failure:blocked', 'guard-stop:end-turn']);
  }, TURN_TIMEOUT_MS);

  test('empty and truncated final answers are replaced or marked', async () => {
    ctx.llm.setInternal(null);
    const empty = await runTurn(ctx, { message: 'Hello.', context: { locale: 'en' } }, ['']);
    expectTerminated(empty);
    expect(empty.result.content.response).toContain('The model did not produce a valid response');
    let session = await ctx.backend.session(empty.conversationId);
    expect(guardEvents(ledgerFor(ctx, session.usage.runId))).toEqual(['empty-final-answer:replaced']);

    const truncated = await runTurn(ctx, { message: '你好。', context: { locale: 'zh' } }, [{ content: '这是一个被截断的回答', finish_reason: 'length' }]);
    expectTerminated(truncated);
    expect(truncated.result.content.response).toBe('这是一个被截断的回答\n\n（注意：模型输出达到长度上限，以上回答可能不完整。）');
    session = await ctx.backend.session(truncated.conversationId);
    expect(guardEvents(ledgerFor(ctx, session.usage.runId))).toEqual(['truncated-final-answer:noted']);
  }, TURN_TIMEOUT_MS);
});
