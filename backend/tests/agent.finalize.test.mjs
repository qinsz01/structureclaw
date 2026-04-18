import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

describe('agent service finalization', () => {
  let AgentService;
  let prisma;

  beforeAll(async () => {
    ({ prisma } = await import('../dist/utils/database.js'));
    ({ AgentService } = await import('../dist/services/agent.js'));
  });

  beforeEach(() => {
    prisma.conversation.findUnique = jest.fn(async () => ({ id: 'conv-finalize' }));
    prisma.message.createMany = jest.fn(async ({ data }) => ({ count: data.length }));
  });

  test('does not persist messages inside finalizeRunResult', async () => {
    const service = new AgentService();
    service.buildResolvedRouting = jest.fn(() => undefined);
    service.annotateToolCalls = jest.fn(async () => {});
    service.logRunResult = jest.fn();

    const result = {
      traceId: 'trace-finalize',
      startedAt: '2026-04-18T00:00:00.000Z',
      completedAt: '2026-04-18T00:00:01.000Z',
      durationMs: 1000,
      success: true,
      orchestrationMode: 'directed',
      needsModelInput: false,
      plan: [],
      toolCalls: [],
      response: 'ok',
    };

    const finalized = await service.finalizeRunResult(
      'trace-finalize',
      'conv-finalize',
      '设计一个简支梁',
      result,
    );

    expect(finalized).toMatchObject({
      conversationId: 'conv-finalize',
      response: 'ok',
    });
    expect(prisma.message.createMany).not.toHaveBeenCalled();
  });
});
