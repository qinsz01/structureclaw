import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import Fastify from 'fastify';

describe('chat routes message persistence', () => {
  let app;
  let prisma;
  let agentRunSpy;
  let agentRunStreamSpy;
  let agentResumeStreamSpy;
  let endWaitingTurnSpy;
  let getSnapshotSpy;

  beforeAll(async () => {
    ({ prisma } = await import('../dist/utils/database.js'));

    prisma.conversation.create = jest.fn(async ({ data }) => ({
      id: 'created-chat-conv',
      ...data,
    }));
    prisma.conversation.findFirst = jest.fn(async ({ where }) => {
      if (where?.id === 'created-chat-conv') {
        return { id: 'created-chat-conv' };
      }
      return { id: 'conv-paused' };
    });
    prisma.conversation.update = jest.fn(async ({ where, data }) => ({
      id: where.id,
      ...data,
    }));
    prisma.message.count = jest.fn(async () => 0);
    prisma.message.findMany = jest.fn(async () => []);
    prisma.message.createMany = jest.fn(async ({ data }) => ({ count: data.length }));

    const { LangGraphAgentService } = await import('../dist/agent-langgraph/agent-service.js');
    agentRunSpy = jest.spyOn(LangGraphAgentService.prototype, 'run').mockImplementation(async (input) => ({
      conversationId: input.conversationId ?? 'agent-created-unowned',
      traceId: input.traceId ?? 'trace-created',
      startedAt: '2026-04-26T00:00:00.000Z',
      completedAt: '2026-04-26T00:00:01.000Z',
      success: true,
      response: 'assistant reply',
      mode: 'conversation',
      toolCalls: [],
    }));
    agentRunStreamSpy = jest.spyOn(LangGraphAgentService.prototype, 'runStream').mockImplementation(async function* (input) {
      yield {
        type: 'start',
        content: {
          conversationId: input.conversationId ?? 'agent-created-unowned-stream',
          traceId: input.traceId ?? 'trace-stream-created',
        },
      };
      yield {
        type: 'result',
        content: {
          conversationId: input.conversationId ?? 'agent-created-unowned-stream',
          traceId: input.traceId ?? 'trace-stream-created',
          response: 'stream assistant reply',
          success: true,
          mode: 'conversation',
          toolCalls: [],
        },
      };
    });
    agentResumeStreamSpy = jest.spyOn(LangGraphAgentService.prototype, 'resumeStream');
    endWaitingTurnSpy = jest.spyOn(LangGraphAgentService.prototype, 'endWaitingTurn');
    getSnapshotSpy = jest
      .spyOn(LangGraphAgentService.prototype, 'getConversationSessionSnapshot')
      .mockResolvedValue(undefined);

    const { chatRoutes } = await import('../dist/api/chat.js');

    app = Fastify();
    await app.register(chatRoutes);
  });

  beforeEach(() => {
    prisma.conversation.create.mockClear();
    prisma.conversation.findFirst.mockClear();
    prisma.conversation.update.mockClear();
    prisma.message.count.mockClear();
    prisma.message.findMany.mockClear();
    prisma.message.createMany.mockClear();
    agentRunSpy.mockClear();
    agentRunStreamSpy.mockClear();
    agentResumeStreamSpy.mockReset();
    endWaitingTurnSpy.mockReset();
    getSnapshotSpy.mockClear();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  test.each(['/stream', '/stream/resume'])('%s preserves completed tool messages and the user input on a model timeout', async url => {
    const { AIMessage, ToolMessage } = await import('@langchain/core/messages');
    const call = new AIMessage({ content: 'Analyzing', tool_calls: [{ id: 'completed-analysis', name: 'run_analysis', args: {}, type: 'tool_call' }] });
    const output = new ToolMessage({ name: 'run_analysis', tool_call_id: 'completed-analysis', content: '{"success":true,"runId":"retained-run"}' });
    getSnapshotSpy.mockResolvedValueOnce({ snapshot: {}, state: { messages: [call, output] } });
    const spy = url === '/stream' ? agentRunStreamSpy : agentResumeStreamSpy;
    spy.mockImplementationOnce(async function* () {
      yield { type: 'start', content: { conversationId: 'conv-paused', traceId: 'timeout-trace' } };
      throw new Error('Request timed out.');
    });
    const payload = url === '/stream' ? { conversationId: 'conv-paused', message: 'Keep my model' }
      : { conversationId: 'conv-paused', resumeValue: 'Keep my model' };
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.body).toContain('"code":"LLM_TIMEOUT"');
    expect(response.body).toContain('"retriable":true');
    expect(response.body).toContain('Completed tool results are retained');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(prisma.message.createMany).toHaveBeenCalledTimes(1);
    const records = prisma.message.createMany.mock.calls[0][0].data;
    expect(records[0]).toMatchObject({ role: 'user', content: 'Keep my model' });
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', toolCallId: 'completed-analysis', content: output.content })]));
    expect(records.at(-1)).toMatchObject({ role: 'assistant', metadata: { presentation: { status: 'error' } } });
  });

  test.each([
    ['/stream', 'CONVERSATION_WAITING_FOR_REPLY'],
    ['/stream/resume', 'CONVERSATION_NOT_WAITING_FOR_REPLY'],
  ])('%s does not copy a previous turn into history when rejected before start', async (url, error) => {
    const spy = url === '/stream' ? agentRunStreamSpy : agentResumeStreamSpy;
    spy.mockImplementationOnce(async function* () { throw new Error(error); });
    const payload = url === '/stream' ? { conversationId: 'conv-paused', message: 'Duplicate answer' }
      : { conversationId: 'conv-paused', resumeValue: 'Duplicate answer' };
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.body).toContain(error);
    expect(prisma.message.createMany).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(getSnapshotSpy).not.toHaveBeenCalled();
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
    const callData = prisma.message.createMany.mock.calls[0][0];
    expect(callData.data).toHaveLength(2);
    expect(callData.data[0]).toEqual(expect.objectContaining({
      conversationId: 'conv-paused',
      role: 'user',
      content: '继续这个对话',
    }));
    expect(callData.data[0].createdAt).toBeInstanceOf(Date);
    expect(callData.data[1]).toEqual(expect.objectContaining({
      conversationId: 'conv-paused',
      role: 'assistant',
      content: '当前分析尚未完成',
      metadata: { status: 'aborted' },
    }));
    expect(callData.data[1].createdAt).toBeInstanceOf(Date);
    // assistant createdAt must be strictly after user createdAt
    expect(callData.data[1].createdAt.getTime()).toBeGreaterThan(callData.data[0].createdAt.getTime());
  });

  test('skips paused persistence when the same traceId has already been stored', async () => {
    prisma.message.findMany.mockResolvedValueOnce([
      { metadata: { traceId: 'trace-paused-1' } },
    ]);

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

  test('creates a conversation before invoking the agent when /message omits conversationId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/message',
      payload: {
        message: 'Design a steel frame',
        traceId: 'trace-created',
        context: { locale: 'en' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.conversation.create).toHaveBeenCalledWith({
      data: {
        title: 'Design a steel frame',
        type: 'general',
      },
    });
    expect(agentRunSpy).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'created-chat-conv',
      message: 'Design a steel frame',
    }));
    expect(prisma.message.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          conversationId: 'created-chat-conv',
          role: 'user',
          content: 'Design a steel frame',
        }),
        expect.objectContaining({
          conversationId: 'created-chat-conv',
          role: 'assistant',
          content: 'assistant reply',
        }),
      ],
    });
  });

  test('passes structured seismic workflow context through /message', async () => {
    const seismicWorkflow = {
      methodPreference: 'elastic_plastic_time_history',
      groundMotionSet: {
        source: 'local_catalog',
        requiredCount: 3,
        catalogIds: ['GM-001', 'GM-002', 'GM-003'],
      },
    };

    const response = await app.inject({
      method: 'POST',
      url: '/message',
      payload: {
        message: 'Run the selected Chinese seismic workflow',
        conversationId: 'conv-paused',
        traceId: 'trace-seismic-context',
        context: {
          locale: 'en',
          analysisType: 'seismic',
          designCode: 'GB/T 50011-2010-2024',
          seismicWorkflow,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(agentRunSpy).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-paused',
      message: 'Run the selected Chinese seismic workflow',
      context: expect.objectContaining({
        analysisType: 'seismic',
        designCode: 'GB/T 50011-2010-2024',
        seismicWorkflow,
      }),
    }));
  });

  test('passes structured seismic workflow context through /stream', async () => {
    const seismicWorkflow = {
      methodPreference: 'time_history',
      groundMotionSet: {
        source: 'builtin_artificial',
        requiredCount: 3,
        catalogIds: ['SCGM-A1', 'SCGM-A2', 'SCGM-A3'],
      },
    };

    const response = await app.inject({
      method: 'POST',
      url: '/stream',
      payload: {
        message: 'Run selected ground motions with the China seismic workflow',
        conversationId: 'conv-paused',
        traceId: 'trace-seismic-stream-context',
        context: {
          locale: 'en',
          analysisType: 'seismic',
          designCode: 'GB/T 50011-2010-2024',
          seismicWorkflow,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(agentRunStreamSpy).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-paused',
      message: 'Run selected ground motions with the China seismic workflow',
      context: expect.objectContaining({
        analysisType: 'seismic',
        designCode: 'GB/T 50011-2010-2024',
        seismicWorkflow,
      }),
    }));
  });

  test('creates a conversation before invoking the agent when /stream omits conversationId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/stream',
      payload: {
        message: 'Stream a steel frame design',
        traceId: 'trace-stream-created',
        context: { locale: 'en' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.conversation.create).toHaveBeenCalledWith({
      data: {
        title: 'Stream a steel frame design',
        type: 'general',
      },
    });
    expect(agentRunStreamSpy).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'created-chat-conv',
      message: 'Stream a steel frame design',
    }));
    expect(prisma.message.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          conversationId: 'created-chat-conv',
          role: 'user',
          content: 'Stream a steel frame design',
        }),
        expect.objectContaining({
          conversationId: 'created-chat-conv',
          role: 'assistant',
          content: 'stream assistant reply',
        }),
      ],
    });
  });

  test('explicit end-turn endpoint persists its cancellation and completion with the original run identity', async () => {
    const { AIMessage, ToolMessage } = await import('@langchain/core/messages');
    const responseText = 'You ended this turn.';
    endWaitingTurnSpy.mockResolvedValueOnce({ traceId: 'end-trace', completedAt: '2026-10-14T00:00:00Z',
      userMessage: 'End this turn', response: responseText, runtime: { waitingForReply: false, busy: false, usage: { runId: 'old-run', toolCalls: 3 } },
      state: { messages: [new ToolMessage({ content: '{"status":"cancelled","errorCode":"TURN_ENDED_BY_USER"}',
        tool_call_id: 'old-question', name: 'ask_user_clarification', status: 'error' }), new AIMessage(responseText)] },
    });
    const response = await app.inject({ method: 'POST', url: '/conversation/conv-paused/turn/end', payload: { expectedRunId: 'old-run' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, runtime: { waitingForReply: false, busy: false, usage: { runId: 'old-run', toolCalls: 3 } } });
    expect(endWaitingTurnSpy).toHaveBeenCalledWith('conv-paused', 'old-run');
    const records = prisma.message.createMany.mock.calls[0][0].data;
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ role: 'user', content: 'End this turn' });
    expect(records[1]).toMatchObject({ role: 'tool', toolCallId: 'old-question', content: expect.stringContaining('cancelled') });
    expect(records[2]).toMatchObject({ role: 'assistant', content: responseText,
      metadata: { turnEnded: true, runId: 'old-run', presentation: { status: 'done' } } });
  });

  test.each([{}, { expectedRunId: '' }, { expectedRunId: 42 }])('end-turn rejects an invalid run identity before changing state: %j', async payload => {
    const response = await app.inject({ method: 'POST', url: '/conversation/conv-paused/turn/end', payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'EXPECTED_RUN_ID_REQUIRED' });
    expect(endWaitingTurnSpy).not.toHaveBeenCalled();
    expect(prisma.message.createMany).not.toHaveBeenCalled();
  });

  test.each(['CONVERSATION_BUSY', 'CONVERSATION_TURN_CONFLICT', 'CONVERSATION_NOT_WAITING_FOR_REPLY'])('end-turn rejects %s without persisting a false completion', async error => {
    endWaitingTurnSpy.mockRejectedValueOnce(new Error(error));
    const response = await app.inject({ method: 'POST', url: '/conversation/conv-paused/turn/end', payload: { expectedRunId: 'old-run' } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error });
    expect(prisma.message.createMany).not.toHaveBeenCalled();
  });

  test('persists a resumed table, clarification, failed tool and trace without token events', async () => {
    const { AIMessage, ToolMessage } = await import('@langchain/core/messages');
    const { streamGraphToChunks } = await import('../dist/agent-langgraph/streaming.js');
    const table = '| Result | Value |\n| --- | --- |\n| Midspan deflection | -1.51699029 mm |';
    const question = 'Continue creating the report?';
    const query = new AIMessage({ content: '', tool_calls: [
      { id: 'query-resume', name: 'query_results', args: {}, type: 'tool_call' },
    ] });
    const failed = new ToolMessage({ name: 'query_results', tool_call_id: 'query-resume',
      content: '{"success":false,"errorCode":"MEMBER_POSITION_REQUIRED"}' });
    const ask = new AIMessage({ content: table, tool_calls: [
      { id: 'ask-resume', name: 'ask_user_clarification', args: { question }, type: 'tool_call' },
    ] });
    getSnapshotSpy.mockResolvedValueOnce({ snapshot: {}, state: { messages: [query, failed, ask] } });
    agentResumeStreamSpy.mockImplementationOnce(async function* () {
      async function* events() {
        yield ['updates', { agent: { messages: [query] } }];
        yield ['updates', { tools: { messages: [failed] } }];
        yield ['updates', { agent: { messages: [ask] } }];
        yield ['updates', { __interrupt__: [{ value: { question, options: ['Continue', 'Skip'] } }] }];
      }
      yield* streamGraphToChunks(events(), ['messages', 'updates'], {
        conversationId: 'conv-paused', traceId: 'resume-table-trace', startedAt: '2026-10-14T00:00:00Z',
      });
    });
    const response = await app.inject({ method: 'POST', url: '/stream/resume',
      payload: { conversationId: 'conv-paused', resumeValue: 'Density is 7850 kg/m3' } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('"type":"token"');
    expect(prisma.message.createMany).toHaveBeenCalledTimes(1);
    const records = prisma.message.createMany.mock.calls[0][0].data;
    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({ role: 'user', content: 'Density is 7850 kg/m3', metadata: { traceId: 'resume-table-trace' } });
    expect(records[2]).toMatchObject({ role: 'tool', toolCallId: 'query-resume' });
    const final = records.at(-1);
    expect(final.content).toBe(`${table}\n\n${question}`);
    expect(final.metadata).toMatchObject({ traceId: 'resume-table-trace', presentation: {
      summaryText: `${table}\n\n${question}`, traceId: 'resume-table-trace', status: 'streaming',
    } });
    expect(final.metadata.presentation.phases.flatMap(phase => phase.steps)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'step-query-resume', status: 'error', errorMessage: 'MEMBER_POSITION_REQUIRED' }),
      expect.objectContaining({ id: 'step-ask-resume', status: 'running' }),
    ]));
  });

  test('persists a completed resumed result without token events', async () => {
    agentResumeStreamSpy.mockImplementationOnce(async function* () {
      yield { type: 'start', content: { conversationId: 'conv-paused', traceId: 'resume-completed-trace' } };
      yield { type: 'result', content: { response: 'The beam analysis is complete.', success: true } };
      yield { type: 'presentation_complete', completedAt: '2026-10-14T00:00:01Z' };
    });
    const response = await app.inject({ method: 'POST', url: '/stream/resume',
      payload: { conversationId: 'conv-paused', resumeValue: 'Continue' } });
    expect(response.statusCode).toBe(200);
    const records = prisma.message.createMany.mock.calls[0][0].data;
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ role: 'assistant', content: 'The beam analysis is complete.', metadata: {
      traceId: 'resume-completed-trace', presentation: { status: 'done', summaryText: 'The beam analysis is complete.' },
    } });
  });

  test('persists user, intermediate tool_calls, tool outputs, and final assistant in a single write', async () => {
    getSnapshotSpy.mockResolvedValueOnce({
      snapshot: {},
      state: {
        messages: [
          { _getType: () => 'human', content: 'Search files' },
          {
            _getType: () => 'ai',
            content: '',
            tool_calls: [{ id: 'call-grep', name: 'grep_files', args: { query: 'needle' } }],
          },
          {
            _getType: () => 'tool',
            name: 'grep_files',
            tool_call_id: 'call-grep',
            content: '{"totalMatches":1}',
          },
          { _getType: () => 'ai', content: 'Found it.' },
        ],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/stream',
      payload: {
        message: 'Search files',
        conversationId: 'conv-paused',
        traceId: 'trace-tools',
        context: { locale: 'en' },
      },
    });

    expect(response.statusCode).toBe(200);
    // Dedup queries: find existing tool messages and assistant tool_calls
    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv-paused', role: 'tool', toolCallId: { not: null } },
      select: { toolCallId: true },
    });
    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv-paused', role: 'assistant' },
      select: { toolCalls: true },
    });
    // Single createMany call with all messages in conversational order
    expect(prisma.message.createMany).toHaveBeenCalledTimes(1);
    const callData = prisma.message.createMany.mock.calls[0][0];
    expect(callData.data).toHaveLength(4);
    // 1. User message
    expect(callData.data[0]).toEqual(expect.objectContaining({
      conversationId: 'conv-paused',
      role: 'user',
      content: 'Search files',
    }));
    expect(callData.data[0].createdAt).toBeInstanceOf(Date);
    // 2. Intermediate AI with tool_calls (input args)
    expect(callData.data[1]).toEqual(expect.objectContaining({
      conversationId: 'conv-paused',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-grep', name: 'grep_files', args: { query: 'needle' } }],
    }));
    expect(callData.data[1].createdAt).toBeInstanceOf(Date);
    // 3. Tool output
    expect(callData.data[2]).toEqual(expect.objectContaining({
      conversationId: 'conv-paused',
      role: 'tool',
      content: '{"totalMatches":1}',
      name: 'grep_files',
      toolCallId: 'call-grep',
    }));
    expect(callData.data[2].createdAt).toBeInstanceOf(Date);
    // 4. Final assistant message with presentation
    expect(callData.data[3]).toEqual(expect.objectContaining({
      conversationId: 'conv-paused',
      role: 'assistant',
      content: 'stream assistant reply',
    }));
    expect(callData.data[3].metadata).toHaveProperty('presentation');
    // Verify strict chronological ordering via createdAt
    const timestamps = callData.data.map((d) => d.createdAt.getTime());
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
  });
});
