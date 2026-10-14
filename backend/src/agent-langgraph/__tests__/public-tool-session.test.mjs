import { afterAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
const previous = process.env.SCLAW_DATA_DIR;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-public-policy-'));
process.env.SCLAW_DATA_DIR = temporary;
const { createPublicToolSession } = await import('../../../dist/agent-langgraph/public-tool-contracts.js');
afterAll(() => { if (previous === undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR = previous;
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir())) throw new Error('unsafe test cleanup');
  fs.rmSync(temporary, { recursive: true, force: true }); });

describe('durable public tool session', () => {
  test('real registered tools keep counters on resume, preserve explicit empty scope and cannot widen permissions', async () => {
    const session = await createPublicToolSession({ message: 'Calculate', runPolicy: { skillIds: [], tools: { enabledIds: ['calculate'] }, budgets: { maxToolCallsPerTurn: 2 } } });
    const first = await session.invoke('calculate', { expression: '6 * 7' });
    expect(first.usage.toolCalls).toBe(1);
    expect(first.policy.activeSkillIds).toEqual([]);
    expect(JSON.stringify(first.messages)).toContain('42');
    const resumed = await createPublicToolSession({ sessionId: session.sessionId, resume: true });
    await expect(resumed.invoke('read_file', { filePath: 'settings.json' })).rejects.toThrow('TOOL_NOT_ALLOWED');
    const second = await resumed.invoke('calculate', { expression: '8 * 9' });
    expect(second.usage.toolCalls).toBe(2);
    const third = await resumed.invoke('calculate', { expression: '10 * 11' });
    expect(JSON.stringify(third.messages)).toContain('TOOL_CALL_BUDGET_EXHAUSTED');
    await expect(createPublicToolSession({ sessionId: session.sessionId, resume: true, runPolicy: { budgets: { maxToolCallsPerTurn: 200 } } })).rejects.toThrow('PUBLIC_SESSION_RESUME_IMMUTABLE');
    const next = await createPublicToolSession({ sessionId: session.sessionId, newTurn: true, message: 'A new user request' });
    expect(next.snapshot().usage.toolCalls).toBe(0);
    expect(next.policy.activeToolIds).toEqual(['calculate']);
  });
  test('unsupported external context control is rejected before any operation', async () => {
    await expect(createPublicToolSession({ runPolicy: { context: { history: 'current-turn' } } })).rejects.toThrow('HOST_CONTEXT_CONTROL_UNSUPPORTED');
  });
  test('an external clarification is an ordinary recorded tool result', async () => {
    const session = await createPublicToolSession({ runPolicy: { tools: { enabledIds: ['ask_user_clarification'] } } });
    const result = await session.invoke('ask_user_clarification', { question: 'Which support?' });
    expect(JSON.stringify(result.messages)).toContain('clarification_needed');
    expect(result.usage.toolCalls).toBe(1);
    expect(session.snapshot().pendingCall).toBeUndefined();
  });
});
