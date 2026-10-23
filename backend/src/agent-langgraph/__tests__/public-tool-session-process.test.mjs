import { afterAll, describe, expect, test } from '@jest/globals';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previous = process.env.SCLAW_DATA_DIR;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-public-process-'));
process.env.SCLAW_DATA_DIR = temporary;
const { createPublicToolSession, inspectPublicToolSession, recoverPublicToolSession } = await import('../../../dist/agent-langgraph/public-tool-contracts.js');
const { acquirePersistentSessionLock } = await import('../../../dist/engineering/persistent-session-lock.js');
const hosts = [];

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill();
  await exit;
}
function host(sessionId, hold = false) {
  const child = fork(new URL('../../../tests/fixtures/public-session-host.mjs', import.meta.url),
    [sessionId, typeof hold === 'string' ? hold : hold ? 'hold' : 'normal'], { env: { ...process.env }, execArgv: [], windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  hosts.push(child);
  const messages = [];
  const waiters = [];
  let stderr = '';
  let received = 0;
  let lastMessage;
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => {
    received++;
    lastMessage = message;
    if (waiters.length) waiters.shift().resolve(message); else messages.push(message);
  });
  child.on('exit', (code, signal) => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`Host exited ${code}/${signal}: ${stderr}`));
  });
  return {
    child,
    next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Host response timeout: pid=${child.pid}, received=${received}, last=${JSON.stringify(lastMessage)}; ${stderr}`)), 15000);
      waiters.push({ resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    }),
  };
}
const newSession = () => createPublicToolSession({ runPolicy: {
  skillIds: [], tools: { enabledIds: ['calculate'] }, budgets: { maxToolCallsPerTurn: 2 },
} });

afterAll(async () => {
  await Promise.all(hosts.map(stop));
  if (previous === undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR = previous;
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test cleanup');
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('independent public tool hosts', () => {
  test('an occupied session rejects the other host and later resumes without losing counters', async () => {
    const session = await newSession();
    const first = host(session.sessionId, true);
    expect(await first.next()).toEqual({ type: 'ready' });
    const second = host(session.sessionId);
    expect(await second.next()).toEqual({ type: 'ready' });
    first.child.send('invoke');
    expect(await first.next()).toEqual({ type: 'entered' });
    second.child.send('invoke');
    expect(await second.next()).toMatchObject({ type: 'error', message: expect.stringContaining('PUBLIC_SESSION_BUSY_OR_OUTCOME_UNKNOWN') });
    const pending = session.snapshot().pendingCall;
    expect(pending.name).toBe('calculate');
    const inFlight = await inspectPublicToolSession(session.sessionId);
    expect(inFlight).toMatchObject({ status: 'busy', usage: { toolCalls: 1 }, recovery: null });
    first.child.send('release');
    expect(await first.next()).toMatchObject({ type: 'result', toolCalls: 1 });
    second.child.send('invoke');
    expect(await second.next()).toMatchObject({ type: 'result', toolCalls: 2 });
    const saved = session.snapshot();
    expect(saved.pendingCall).toBeUndefined();
    expect(saved.usage.toolCalls).toBe(2);
    expect(saved.usage.startedToolCallIds).toHaveLength(2);
    expect(saved.usage.events.filter(event => event.kind === 'tool_finished')).toHaveLength(2);
    second.child.send('invoke');
    const exhausted = await second.next();
    expect(exhausted.toolCalls).toBe(2);
    expect(JSON.stringify(exhausted.messages)).toContain('TOOL_CALL_BUDGET_EXHAUSTED');
    await Promise.all([stop(first.child), stop(second.child)]);
  }, 45000);

  test('a stopped owner leaves its unknown operation and claim; age cannot steal it', async () => {
    const session = await newSession();
    const first = host(session.sessionId, true);
    expect(await first.next()).toEqual({ type: 'ready' });
    first.child.send('invoke');
    expect(await first.next()).toEqual({ type: 'entered' });
    await stop(first.child);
    const file = path.join(temporary, 'public-tool-sessions', `${session.sessionId}.json`);
    const claim = `${file}.claim`;
    const saved = fs.readFileSync(file, 'utf8'), owner = fs.readFileSync(claim, 'utf8');
    fs.utimesSync(claim, new Date('2000-01-01'), new Date('2000-01-01'));
    const second = host(session.sessionId);
    expect(await second.next()).toMatchObject({ type: 'error', message: expect.stringContaining('PUBLIC_SESSION_BUSY_OR_OUTCOME_UNKNOWN') });
    expect(fs.readFileSync(file, 'utf8')).toBe(saved);
    expect(fs.readFileSync(claim, 'utf8')).toBe(owner);
    expect(JSON.parse(saved).pendingCall.name).toBe('calculate');
    const inspected = await inspectPublicToolSession(session.sessionId);
    expect(inspected.status).toBe('outcome_unknown');
    expect(inspected.usage.toolCalls).toBe(1);
    await expect(recoverPublicToolSession({ sessionId: session.sessionId, expectedStateHash: inspected.stateHash,
      expectedClaimToken: inspected.claim.token })).rejects.toThrow('PUBLIC_TOOL_OUTCOME_UNKNOWN');
    expect(fs.readFileSync(file, 'utf8')).toBe(saved);
    expect(fs.readFileSync(claim, 'utf8')).toBe(owner);
    // The claim is per session, not a global application lock.
    const separate = await newSession();
    expect((await separate.invoke('calculate', { expression: '2+3' })).usage.toolCalls).toBe(1);
    await stop(second.child);
  }, 45000);

  test('release never removes a claim replaced by another owner', async () => {
    const file = path.join(temporary, 'ownership-only.json');
    const release = await acquirePersistentSessionLock(file);
    const replacement = JSON.stringify({ token: 'another-owner', pid: process.pid });
    fs.writeFileSync(`${file}.claim`, replacement);
    await expect(release()).rejects.toThrow('PUBLIC_SESSION_CLAIM_CHANGED');
    expect(fs.readFileSync(`${file}.claim`, 'utf8')).toBe(replacement);
  });

  test('calls in one host still queue and both updates survive', async () => {
    const session = await newSession();
    const results = await Promise.all([
      session.invoke('calculate', { expression: '1+2' }),
      session.invoke('calculate', { expression: '3+4' }),
    ]);
    expect(results.map(result => result.usage.toolCalls)).toEqual([1, 2]);
    expect(session.snapshot().usage.toolCalls).toBe(2);
  });

  test.each(['crash-before-commit', 'crash-after-commit'])('explicit recovery after %s keeps the completed result and budgets without invoking the tool', async mode => {
    const session = await newSession();
    const first = host(session.sessionId, mode);
    expect(await first.next()).toEqual({ type: 'ready' });
    const exited = once(first.child, 'exit');
    first.child.send('invoke');
    expect((await exited)[0]).toBe(mode === 'crash-before-commit' ? 72 : 73);
    const inspected = await inspectPublicToolSession(session.sessionId);
    expect(inspected).toMatchObject({ status: 'recoverable', claim: { alive: false }, usage: { toolCalls: 1 } });
    const request = { sessionId: session.sessionId, expectedStateHash: inspected.stateHash, expectedClaimToken: inspected.claim.token };
    await expect(recoverPublicToolSession({ ...request, expectedStateHash: '0'.repeat(64) })).rejects.toThrow('PUBLIC_SESSION_STATE_CHANGED');
    await expect(recoverPublicToolSession({ ...request, expectedClaimToken: 'not-the-inspected-owner' })).rejects.toThrow('PUBLIC_SESSION_CLAIM_CHANGED');
    const restored = await recoverPublicToolSession(request);
    expect(restored).toMatchObject({ status: 'idle', claim: null, policy: inspected.policy, usage: { toolCalls: 1 } });
    expect(JSON.stringify(restored.completedCall.messages)).toContain('42');
    expect(JSON.stringify((await inspectPublicToolSession(session.sessionId)).completedCall.messages)).toContain('42');
    const resumed = await createPublicToolSession({ sessionId: session.sessionId, resume: true });
    const second = await resumed.invoke('calculate', { expression: '10 + 3' });
    expect(second.usage.toolCalls).toBe(2);
    expect(JSON.stringify((await inspectPublicToolSession(session.sessionId)).completedCall.messages)).toContain('13');
    expect(second.usage.events.filter(event => event.kind === 'tool_finished')).toHaveLength(2);
    const third = await resumed.invoke('calculate', { expression: '99' });
    expect(JSON.stringify(third.messages)).toContain('TOOL_CALL_BUDGET_EXHAUSTED');
  }, 45000);

  test('a live host cannot be recovered even with an exact state and claim token', async () => {
    const session = await newSession();
    const first = host(session.sessionId, true);
    expect(await first.next()).toEqual({ type: 'ready' });
    first.child.send('invoke');
    expect(await first.next()).toEqual({ type: 'entered' });
    const inspected = await inspectPublicToolSession(session.sessionId);
    expect(inspected.status).toBe('busy');
    await expect(recoverPublicToolSession({ sessionId: session.sessionId, expectedStateHash: inspected.stateHash,
      expectedClaimToken: inspected.claim.token })).rejects.toThrow('PUBLIC_SESSION_OWNER_RUNNING');
    first.child.send('release');
    expect(await first.next()).toMatchObject({ type: 'result', toolCalls: 1 });
    await stop(first.child);
  }, 45000);

  test('a completion with a changed policy or lost ledger is never published', async () => {
    const session = await newSession();
    const first = host(session.sessionId, 'crash-before-commit');
    expect(await first.next()).toEqual({ type: 'ready' });
    const exited = once(first.child, 'exit');
    first.child.send('invoke');
    await exited;
    const file = path.join(temporary, 'public-tool-sessions', `${session.sessionId}.json`);
    const receiptFile = `${file}.completed`;
    const original = fs.readFileSync(receiptFile, 'utf8');
    const receipt = JSON.parse(original);
    receipt.record.policy.activeToolIds.push('shell');
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    await expect(inspectPublicToolSession(session.sessionId)).rejects.toThrow('PUBLIC_SESSION_COMPLETION_INVALID');
    fs.writeFileSync(receiptFile, original);
    const inspected = await inspectPublicToolSession(session.sessionId);
    const ledger = path.join(temporary, 'run-records', `${inspected.usage.runId}.json`);
    const usage = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    usage.usage.toolCalls = 0;
    fs.writeFileSync(ledger, JSON.stringify(usage));
    await expect(recoverPublicToolSession({ sessionId: session.sessionId, expectedStateHash: inspected.stateHash,
      expectedClaimToken: inspected.claim.token })).rejects.toThrow('PUBLIC_SESSION_COMPLETION_LEDGER_MISMATCH');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pendingCall).toBeDefined();
  }, 45000);
});
