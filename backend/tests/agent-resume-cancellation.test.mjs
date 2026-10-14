import { test, expect, jest } from '@jest/globals';
import { LangGraphAgentService } from '../dist/agent-langgraph/agent-service.js';

function serviceWithGraph(stream) {
  const service = Object.create(LangGraphAgentService.prototype);
  const release = jest.fn();
  service.sessionLock = { acquire: jest.fn(async () => release) };
  const runtime = { policy: { budgets: { maxToolCallsPerTurn: 200 }, activeToolIds: ['run_analysis'], activeSkillIds: ['beam'] },
    runId: 'preserved-run', usage: { toolCalls: 7, recoveries: 1 } };
  service.prepareRunContext = jest.fn(async () => runtime);
  service.getGraph = async () => ({ getState: async () => ({ values: { locale: 'en', lastUserMessage: 'continue calculation' }, tasks: [{ interrupts: [{ value: 'Confirm?' }] }] }), stream });
  return { service, release, runtime };
}

test('resume sends the actual cancellation signal and the original runtime to LangGraph', async () => {
  const controller = new AbortController();
  let graphConfig;
  const { service, release, runtime } = serviceWithGraph(async (_, config) => {
    graphConfig = config;
    return (async function* () { config.signal.throwIfAborted(); })();
  });
  const stream = service.resumeStream('conversation', 'confirmed input', controller.signal);
  await stream.next(); // The streaming adapter first emits the start event.
  expect(graphConfig.signal).toBe(controller.signal);
  expect(graphConfig.configurable.runContext).toBe(runtime);
  expect(service.prepareRunContext.mock.calls[0][2]).toBe(true);
  controller.abort();
  const chunks = [];
  try { for await (const chunk of stream) chunks.push(chunk); } catch (error) { expect(error.name).toBe('AbortError'); }
  expect(release).toHaveBeenCalledTimes(1);
  expect(runtime.usage).toEqual({ toolCalls: 7, recoveries: 1 });
});

test('an already cancelled resume never acquires the conversation or starts a graph', async () => {
  const graphStream = jest.fn();
  const { service } = serviceWithGraph(graphStream);
  const controller = new AbortController(); controller.abort();
  await expect(service.resumeStream('c', 'answer', controller.signal).next()).rejects.toMatchObject({ name: 'AbortError' });
  expect(service.sessionLock.acquire).not.toHaveBeenCalled();
  expect(graphStream).not.toHaveBeenCalled();
});

test('cancellation while queued releases the acquired lock without resuming', async () => {
  const graphStream = jest.fn();
  const { service, release } = serviceWithGraph(graphStream);
  const controller = new AbortController();
  service.sessionLock.acquire = async () => { controller.abort(); return release; };
  await expect(service.resumeStream('c', 'answer', controller.signal).next()).rejects.toMatchObject({ name: 'AbortError' });
  expect(release).toHaveBeenCalledTimes(1);
  expect(service.prepareRunContext).not.toHaveBeenCalled();
  expect(graphStream).not.toHaveBeenCalled();
});
