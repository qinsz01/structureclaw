import { afterEach, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { createServer, get } from 'node:http';
import { runSseTurn } from '../dist/api/chat-sse.js';

afterEach(() => jest.useRealTimers());

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const fixture = (relay) => {
  const raw = Object.assign(new EventEmitter(), {
    setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn(),
    destroyed: false, writableEnded: false,
  });
  const request = { headers: {}, socket: new EventEmitter(), log: { info: jest.fn(), error: jest.fn() } };
  const handlers = { route: '/stream', abortedMessage: 'aborted', conversationId: () => 'idle', relay,
    persist: jest.fn(async () => {}), onFailure: jest.fn(), interruptedPersistMessage: 'persist error', onFinalPersistError: jest.fn() };
  return { raw, request, handlers, run: () => runSseTurn(request, { raw, hijack: jest.fn() }, handlers) };
};

test('silent work sends SSE comments and completion clears the timer', async () => {
  jest.useFakeTimers();
  const gate = deferred();
  const ctx = fixture(() => gate.promise);
  const running = ctx.run();
  await jest.advanceTimersByTimeAsync(30_000);
  expect(ctx.raw.write.mock.calls.map(([value]) => value)).toEqual([': heartbeat\n\n', ': heartbeat\n\n']);
  gate.resolve();
  await running;
  expect(jest.getTimerCount()).toBe(0);
  expect(ctx.raw.write).toHaveBeenLastCalledWith('data: [DONE]\n\n');
});

test('provider failure stays an explicit failure and clears the timer', async () => {
  jest.useFakeTimers();
  const gate = deferred();
  const ctx = fixture(() => gate.promise);
  const running = ctx.run();
  await jest.advanceTimersByTimeAsync(15_000);
  gate.reject(new Error('LLM request timeout'));
  await running;
  const events = ctx.raw.write.mock.calls.map(([value]) => value).filter(value => value.startsWith('data: {')).map(value => JSON.parse(value.slice(6)));
  expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'LLM_TIMEOUT' })]);
  expect(ctx.handlers.onFailure).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test.each(['destroyed', 'writableEnded'])('does not send keepalive data to a %s response', async flag => {
  jest.useFakeTimers();
  const gate = deferred();
  const ctx = fixture(() => gate.promise);
  const running = ctx.run();
  ctx.raw[flag] = true;
  await jest.advanceTimersByTimeAsync(30_000);
  expect(ctx.raw.write).not.toHaveBeenCalled();
  gate.resolve();
  await running;
  expect(jest.getTimerCount()).toBe(0);
});

test('an idle HTTP client receives a late provider error instead of losing the socket', async () => {
  const server = createServer((request, response) => {
    const handlers = {
      route: '/stream', abortedMessage: 'aborted', conversationId: () => 'idle',
      relay: session => new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('LLM request timeout')), 31_000);
        session.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('client aborted')); }, { once: true });
      }),
      persist: async () => {}, onFailure: () => {}, interruptedPersistMessage: 'persist error', onFinalPersistError: () => {},
    };
    void runSseTurn({ headers: request.headers, socket: request.socket, log: { info() {}, error() {} } },
      { raw: response, hijack() {} }, handlers);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const wire = await new Promise((resolve, reject) => {
      const request = get(`http://127.0.0.1:${server.address().port}/stream`, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve(text));
        response.on('error', reject);
      });
      request.setTimeout(18_000, () => request.destroy(new Error('SSE client idle timeout')));
      request.on('error', reject);
    });
    expect(wire).toContain(': heartbeat\n\n');
    const events = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'LLM_TIMEOUT' })]);
    expect(wire).toContain('data: [DONE]');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}, 45_000);
