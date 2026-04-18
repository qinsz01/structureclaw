import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import Fastify from 'fastify';

describe('chat routes message persistence', () => {
  let app;
  let prisma;

  beforeAll(async () => {
    ({ prisma } = await import('../dist/utils/database.js'));

    prisma.conversation.findFirst = async () => ({ id: 'conv-paused' });
    prisma.message.createMany = jest.fn(async ({ data }) => ({ count: data.length }));

    const { chatRoutes } = await import('../dist/api/chat.js');

    app = Fastify();
    await app.register(chatRoutes);
  });

  beforeEach(() => {
    prisma.message.createMany.mockClear();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  test('persists paused messages with aborted metadata instead of mutating the content', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/conversation/conv-paused/messages',
      payload: {
        userMessage: '继续这个对话',
        assistantContent: '当前分析尚未完成',
        assistantAborted: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.message.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.message.createMany).toHaveBeenCalledWith({
      data: [
        {
          conversationId: 'conv-paused',
          role: 'user',
          content: '继续这个对话',
        },
        {
          conversationId: 'conv-paused',
          role: 'assistant',
          content: '当前分析尚未完成',
          metadata: {
            status: 'aborted',
          },
        },
      ],
    });
  });

  test('skips paused persistence when the same traceId has already been stored', async () => {
    prisma.message.findMany = jest.fn(async () => ([
      { metadata: { traceId: 'trace-paused-1' } },
    ]));

    const response = await app.inject({
      method: 'POST',
      url: '/conversation/conv-paused/messages',
      payload: {
        userMessage: '继续这个对话',
        assistantContent: '当前分析尚未完成',
        assistantAborted: true,
        traceId: 'trace-paused-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.message.createMany).not.toHaveBeenCalled();
  });
});
