import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AIMessage } from '@langchain/core/messages';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const previousDirectory = process.env.SCLAW_DATA_DIR;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-policy-session-'));
process.env.SCLAW_DATA_DIR = directory;
const prompts = [];
const boundTools = [];
let responses = [];
let modelAvailable = true;
const llm = await import('../../../dist/utils/llm.js');
jest.unstable_mockModule('../../../dist/utils/llm.js', () => ({ ...llm,
  createChatModel: () => modelAvailable ? ({ bindTools: tools => {
    boundTools.push(tools.map(tool => tool.name));
    return { invoke: async messages => { prompts.push(messages); return responses.shift() ?? new AIMessage('Recorded.'); } };
  } }) : null,
}));
const { LangGraphAgentService } = await import('../../../dist/agent-langgraph/agent-service.js');
const manifest = { id: 'beam', domain: 'structure-type', structureType: 'beam', stages: ['draft'],
  name: { en: 'Beam', zh: '梁' }, description: { en: 'OPTIONAL_SKILL_SENTINEL', zh: 'OPTIONAL_SKILL_SENTINEL' } };
const skillRuntime = { listSkillManifests: async () => [manifest] };
beforeEach(() => { prompts.length = 0; boundTools.length = 0; responses = []; modelAvailable = true; });
afterAll(() => {
  if (previousDirectory === undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR = previousDirectory;
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test cleanup');
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('policy applied through the persisted chat service and real graph', () => {
  test.each(['en', 'zh'])('missing LLM fails the real graph instead of completing a successful chat (%s)', async locale => {
    modelAvailable = false;
    const service = new LangGraphAgentService(skillRuntime);
    await expect(service.runFull({ conversationId: randomUUID(), message: 'Design a beam', context: { locale } }))
      .rejects.toThrow('LLM_NOT_CONFIGURED:');
    expect(prompts).toEqual([]);
    expect(boundTools).toEqual([]);
  });

  test.each(['en', 'zh'])('empty LLM output fails the real graph without a synthetic answer (%s)', async locale => {
    responses = [new AIMessage('')];
    const service = new LangGraphAgentService(skillRuntime);
    await expect(service.runFull({ conversationId: randomUUID(), message: 'Hello', context: { locale } }))
      .rejects.toThrow('LLM_EMPTY_RESPONSE:');
    expect(prompts).toHaveLength(1);
  });

  test('next-turn controls survive reopening, reach model prompts and remove memory access', async () => {
    const conversationId = randomUUID();
    const service = new LangGraphAgentService(skillRuntime);
    const first = await service.runFull({ conversationId, message: 'PRIOR_DIALOGUE_SENTINEL', context: { locale: 'en', runPolicy: {
      knowledge: 'enabled', tools: { enabledIds: ['calculate', 'memory'] },
    } } });
    expect(prompts[0][0].content).toContain('OPTIONAL_SKILL_SENTINEL');
    expect(boundTools[0]).toContain('memory');

    const graph = await service.getGraph();
    await graph.updateState({ configurable: { thread_id: conversationId } }, { model: { modelSentinel: 'retained' }, modelRevision: 7 });
    const changed = await service.runFull({ conversationId, message: 'CURRENT_DIALOGUE_SENTINEL', context: { locale: 'en', runPolicy: {
      knowledge: 'disabled', builder: 'llm', repair: { enabled: false },
      context: { history: 'current-turn', memoryScopes: [] },
    } } });
    const prompt = JSON.stringify(prompts.at(-1));
    expect(prompt).not.toContain('PRIOR_DIALOGUE_SENTINEL');
    expect(prompt).not.toContain('OPTIONAL_SKILL_SENTINEL');
    expect(prompt).toContain('CURRENT_DIALOGUE_SENTINEL');
    expect(boundTools.at(-1)).toEqual(['calculate']);
    expect(changed.model).toEqual({ modelSentinel: 'retained' });
    expect(changed.modelRevision).toBe(7);
    expect(changed.runPolicy).toMatchObject({ knowledge: 'disabled', builder: 'llm', repair: { enabled: false, maxRecoveriesPerTurn: 0 },
      context: { history: 'current-turn', memoryScopes: [] } });
    expect(changed.runPolicy.policyHash).not.toBe(first.runPolicy.policyHash);

    const reopened = new LangGraphAgentService(skillRuntime);
    const inherited = await reopened.runFull({ conversationId, message: 'NEXT_DIALOGUE_SENTINEL', context: { locale: 'en' } });
    expect(inherited.runPolicy.policyHash).toBe(changed.runPolicy.policyHash);
    expect(inherited.runPolicy.fieldSources.knowledge).toBe('session');
    expect(JSON.stringify(prompts.at(-1))).not.toContain('CURRENT_DIALOGUE_SENTINEL');
    expect(boundTools.at(-1)).not.toContain('memory');

    const enabled = await reopened.runFull({ conversationId, message: 'RESTORED_DIALOGUE_SENTINEL', context: { locale: 'en', runPolicy: {
      knowledge: 'enabled', builder: 'auto', repair: { enabled: true, maxRecoveriesPerTurn: 2 },
      context: { history: 'full', memoryScopes: ['conversation'] },
    } } });
    expect(JSON.stringify(prompts.at(-1))).toContain('PRIOR_DIALOGUE_SENTINEL');
    expect(prompts.at(-1)[0].content).toContain('OPTIONAL_SKILL_SENTINEL');
    expect(boundTools.at(-1)).toContain('memory');
    expect(enabled.runPolicy.repair).toEqual({ enabled: true, maxRecoveriesPerTurn: 2 });
  });

  test('empty tool and skill scope remains empty through real graph invocation and persistence', async () => {
    const conversationId = randomUUID();
    const service = new LangGraphAgentService(skillRuntime);
    const first = await service.runFull({ conversationId, message: 'No tools', context: { runPolicy: {
      skillIds: [], tools: { enabledIds: [] }, context: { memoryScopes: [] },
    } } });
    expect(first.runPolicy.activeSkillIds).toEqual([]);
    expect(first.runPolicy.activeToolIds).toEqual([]);
    expect(boundTools.at(-1)).toEqual([]);
    const second = await new LangGraphAgentService(skillRuntime).runFull({ conversationId, message: 'Still no tools' });
    expect(second.runPolicy.policyHash).toBe(first.runPolicy.policyHash);
    expect(boundTools.at(-1)).toEqual([]);
  });

  test.each(['en', 'zh'])('tool availability in the actual model prompt follows the new turn while full history remains (%s)', async locale => {
    const service = new LangGraphAgentService(skillRuntime);
    const conversationId = randomUUID();
    const prefix = locale === 'zh' ? '本次调用实际可用工具=' : 'Tools available for this invocation=';
    await service.runFull({ conversationId, message: 'OLD_TOOLS_DISABLED_SENTINEL', context: { locale, runPolicy: {
      tools: { enabledIds: [] }, context: { history: 'current-turn', memoryScopes: [] },
    } } });
    expect(boundTools.at(-1)).toEqual([]);
    expect(prompts.at(-1)[0].content).toContain(`${prefix}[]`);
    const reopened = new LangGraphAgentService(skillRuntime);
    await reopened.runFull({ conversationId, message: 'Use calculate now', context: { locale, runPolicy: {
      tools: { enabledIds: ['calculate'] }, context: { history: 'full', memoryScopes: [] },
    } } });
    expect(JSON.stringify(prompts.at(-1))).toContain('OLD_TOOLS_DISABLED_SENTINEL');
    expect(boundTools.at(-1)).toEqual(['calculate']);
    expect(prompts.at(-1)[0].content).toContain(`${prefix}["calculate"]`);
    await reopened.runFull({ conversationId, message: 'Disable again', context: { locale, runPolicy: { tools: { enabledIds: [] } } } });
    expect(boundTools.at(-1)).toEqual([]);
    expect(prompts.at(-1)[0].content).toContain(`${prefix}[]`);
  });

  test('repair off permits a successful registered calculation but blocks a failed one from retrying', async () => {
    const service = new LangGraphAgentService(skillRuntime);
    responses = [new AIMessage({ content: '', tool_calls: [{ id: 'ok', name: 'calculate', args: { expression: '6 * 7' } }] }), new AIMessage('42')];
    const succeeded = await service.runFull({ conversationId: randomUUID(), message: 'Calculate', context: { runPolicy: {
      repair: { enabled: false }, tools: { enabledIds: ['calculate'] },
    } } });
    expect(succeeded.runUsage.toolCalls).toBe(1);
    expect(succeeded.runUsage.recoveries).toBe(0);
    expect(succeeded.messages.some(message => message._getType() === 'tool' && String(message.content).includes('42'))).toBe(true);
    responses = [new AIMessage({ content: '', tool_calls: [{ id: 'bad', name: 'calculate', args: { expression: 'unknownVariable + 1' } }] }),
      new AIMessage({ content: '', tool_calls: [{ id: 'retry', name: 'calculate', args: { expression: '6 * 7' } }] }), new AIMessage('Stopped after failure.')];
    const failed = await service.runFull({ conversationId: randomUUID(), message: 'Calculate', context: { runPolicy: {
      repair: { enabled: false }, tools: { enabledIds: ['calculate'] },
    } } });
    expect(failed.runUsage.toolCalls).toBe(1);
    expect(failed.runUsage.recoveries).toBe(0);
    expect(failed.messages.some(message => String(message.content).includes('RECOVERY_BUDGET_EXHAUSTED'))).toBe(true);
  });

  test.each(['en', 'zh'])('explicitly ending a failed waiting turn keeps its ledger and permits a normal new turn (%s)', async locale => {
    const service = new LangGraphAgentService(skillRuntime);
    const conversationId = randomUUID();
    const graph = await service.getGraph();
    const graphConfig = { configurable: { thread_id: conversationId } };
    const model = { modelSentinel: 'retained' };
    const analysisRuns = { archived: { runId: 'archived', success: true, data: { retained: 42 } } };
    await graph.updateState(graphConfig, { model, modelRevision: 7, analysisRuns }, 'agent');
    responses = [new AIMessage({ content: '', tool_calls: [
      { id: 'failed-calc', name: 'calculate', args: { expression: 'unknownVariable + 1' } },
    ] }), new AIMessage({ content: 'Please clarify.', tool_calls: [
      { id: 'waiting-ask', name: 'ask_user_clarification', args: { question: 'Continue?' } },
      { id: 'not-executed', name: 'calculate', args: { expression: '999' } },
    ] })];
    await service.runFull({ conversationId, message: 'Calculate', context: { locale, runPolicy: {
      repair: { enabled: false }, tools: { enabledIds: ['calculate', 'ask_user_clarification'] },
    } } });
    const waiting = await service.getConversationSessionSnapshot(conversationId, locale);
    const oldRunId = waiting.snapshot.runtime.usage.runId;
    const ledgerPath = path.join(directory, 'run-records', `${oldRunId}.json`);
    const oldLedger = fs.readFileSync(ledgerPath, 'utf8');
    expect(waiting.snapshot.runtime).toMatchObject({ waitingForReply: true, busy: false, usage: { toolCalls: 2, recoveries: 0 } });
    await expect(service.runFull({ conversationId, message: 'A new request' })).rejects.toThrow('CONVERSATION_WAITING_FOR_REPLY');
    await expect(service.endWaitingTurn(conversationId, 'stale-run')).rejects.toThrow('CONVERSATION_TURN_CONFLICT');
    const release = await service.sessionLock.acquire(conversationId);
    try { await expect(service.endWaitingTurn(conversationId, oldRunId)).rejects.toThrow('CONVERSATION_BUSY'); }
    finally { release(); }
    expect((await graph.getState(graphConfig)).tasks.some(task => task.interrupts?.length)).toBe(true);
    const callsBefore = prompts.length;
    const ended = await service.endWaitingTurn(conversationId, oldRunId);
    expect(prompts).toHaveLength(callsBefore);
    expect(ended.runtime).toMatchObject({ waitingForReply: false, busy: false, usage: { runId: oldRunId, toolCalls: 2, recoveries: 0 } });
    expect(ended.state.model).toEqual(model);
    expect(ended.state.modelRevision).toBe(7);
    expect(ended.state.analysisRuns).toEqual(analysisRuns);
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(oldLedger);
    const closed = await graph.getState(graphConfig);
    expect(closed.next).toEqual([]);
    expect(closed.tasks).toEqual([]);
    const cancellations = closed.values.messages.filter(message => message._getType() === 'tool'
      && ['waiting-ask', 'not-executed'].includes(message.tool_call_id));
    expect(cancellations).toHaveLength(2);
    expect(cancellations.every(message => JSON.parse(message.content).status === 'cancelled')).toBe(true);
    expect(closed.values.messages.at(-1).content).toContain(locale === 'zh' ? '本轮已由你结束' : 'You ended this turn');
    await expect(service.endWaitingTurn(conversationId, oldRunId)).rejects.toThrow('CONVERSATION_NOT_WAITING_FOR_REPLY');
    await expect(service.resumeStream(conversationId, 'Resume obsolete question').next()).rejects.toThrow('CONVERSATION_NOT_WAITING_FOR_REPLY');

    responses = [new AIMessage({ content: '', tool_calls: [{ id: 'fresh-calc', name: 'calculate', args: { expression: '6 * 7' } }] }), new AIMessage('42')];
    const next = await service.runFull({ conversationId, message: 'Calculate 6 * 7', context: { locale } });
    expect(next.runUsage.runId).not.toBe(oldRunId);
    expect(next.runUsage).toMatchObject({ toolCalls: 1, recoveries: 0, pendingFailures: {} });
    expect(next.model).toEqual(model);
    expect(next.analysisRuns).toEqual(analysisRuns);
    expect(next.messages.at(-1).content).toBe('42');
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(oldLedger);
  });
});
