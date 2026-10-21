import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import Fastify from 'fastify';

// A failure of the final (finally-block) persistence must reach the request logger on both SSE routes.
const persistence = await import('../dist/services/chat-persistence.js');
jest.unstable_mockModule('../dist/services/chat-persistence.js', () => ({ ...persistence,
  persistConversationWithState: async () => { throw new Error('PERSIST_FIXTURE_FAILURE'); } }));

describe('SSE turn persistence failures are logged', () => {
  const records = [];
  let resumeSpy;
  let app;

  beforeAll(async () => {
    const { prisma } = await import('../dist/utils/database.js');
    prisma.conversation.findFirst = jest.fn(async () => ({ id: 'conv-log' }));
    const { LangGraphAgentService } = await import('../dist/agent-langgraph/agent-service.js');
    const turn = async function* () {
      yield { type: 'start', content: { conversationId: 'conv-log', traceId: 'trace-log' } };
      yield { type: 'result', content: { conversationId: 'conv-log', traceId: 'trace-log', response: 'ok', success: true, toolCalls: [] } };
    };
    jest.spyOn(LangGraphAgentService.prototype, 'runStream').mockImplementation(turn);
    resumeSpy = jest.spyOn(LangGraphAgentService.prototype, 'resumeStream').mockImplementation(turn);
    jest.spyOn(LangGraphAgentService.prototype, 'getConversationSessionSnapshot').mockResolvedValue(undefined);
    const { chatRoutes } = await import('../dist/api/chat.js');
    app = Fastify({ logger: { level: 'error', stream: { write: line => records.push(JSON.parse(line)) } } });
    await app.register(chatRoutes);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  test('resume forwards attachment references', async () => {
    const attachments = [{ fileId: 'section', originalName: 'section.csv', relPath: '.uploads/conv-log/section.csv' }];
    const response = await app.inject({ method: 'POST', url: '/stream/resume', payload: { conversationId: 'conv-log', resumeValue: 'Use table', attachments } });
    expect(response.statusCode).toBe(200);
    expect(resumeSpy).toHaveBeenLastCalledWith('conv-log', 'Use table', expect.any(AbortSignal), attachments);
  });

  test.each([
    ['/stream', { conversationId: 'conv-log', message: 'Persist me' }, 'Failed to persist stream'],
    ['/stream/resume', { conversationId: 'conv-log', resumeValue: 'Persist me' }, 'Failed to persist resume'],
  ])('%s logs the final persistence error', async (url, payload, message) => {
    records.length = 0;
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data: [DONE]');
    const logged = records.filter(record => record.msg === message);
    expect(logged).toHaveLength(1);
    expect(logged[0].err.message).toContain('PERSIST_FIXTURE_FAILURE');
  });
});
