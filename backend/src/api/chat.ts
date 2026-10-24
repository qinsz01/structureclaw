import { requestScopeInputSchema } from '../engineering/request-scope.js';
import { runPolicyInputSchema } from '../runtime/run-policy.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ConversationService } from '../services/conversation.js';
import { config } from '../config/index.js';
import { isLlmTimeoutError, toLlmApiError } from '../utils/llm-error.js';
import { prisma } from '../utils/database.js';
import { createEmptyAssistantPresentation, buildCompletedAssistantPresentation as rebuildAssistantPresentationFromResult, reducePresentationEvent, type AssistantPresentation } from '../services/chat-presentation.js';
import { getAgentService } from '../agent-langgraph/index.js';
import type { AgentState } from '../agent-langgraph/state.js';
import { buildPersistedDebugDetails, persistLatestConversationResult, persistConversationWithState } from '../services/chat-persistence.js';
import { runSseTurn, type SseTurnSession } from './chat-sse.js';
import { parseRequest } from './request-validation.js';

const conversationService = new ConversationService();

const agentService = getAgentService();

const optionalIdSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return value;
}, z.string().optional());

const localeSchema = z.enum(['en', 'zh']).optional();

const seismicWorkflowSchema = z.record(z.string(), z.any()).optional();

// 请求验证
const sendMessageSchema = z.object({
  message: z.string().min(1).max(10000),
  conversationId: optionalIdSchema,
  traceId: optionalIdSchema,
  context: z.object({
    runPolicy: runPolicyInputSchema.optional(),
    requestScope: requestScopeInputSchema.optional(),
    locale: localeSchema,
    skillIds: z.array(z.string()).optional(),
    enabledToolIds: z.array(z.string()).optional(),
    disabledToolIds: z.array(z.string()).optional(),
    engineId: z.string().optional(),
    model: z.record(z.string(), z.any()).optional(),
    modelFormat: z.string().optional(),
    modelRevision: z.number().int().nonnegative().optional(),
    analysisType: z.enum(['static', 'dynamic', 'seismic', 'nonlinear']).optional(),
    parameters: z.record(z.string(), z.any()).optional(),
    autoAnalyze: z.boolean().optional(),
    autoCodeCheck: z.boolean().optional(),
    designCode: z.string().optional(),
    codeCheckElements: z.array(z.string()).optional(),
    includeReport: z.boolean().optional(),
    reportFormat: z.enum(['json', 'markdown', 'both']).optional(),
    reportOutput: z.enum(['inline', 'file']).optional(),
    seismicWorkflow: seismicWorkflowSchema,
    userDecision: z.enum(['provide_values', 'confirm_all', 'allow_auto_decide', 'revise']).optional(),
    providedValues: z.record(z.string(), z.any()).optional(),
    attachments: z.array(z.object({
      fileId: z.string(),
      originalName: z.string(),
      relPath: z.string(),
      mimeType: z.string().optional(),
      size: z.number().optional(),
    })).optional(),
  }).optional(),
});

const createConversationSchema = z.object({
  title: z.string().optional(),
  type: z.enum(['general', 'analysis', 'design', 'code-check']),
  locale: localeSchema,
});

const conversationDetailQuerySchema = z.object({
  locale: localeSchema,
});

const streamMessageSchema = z.object({
  message: z.string().min(1).max(10000),
  conversationId: optionalIdSchema,
  traceId: optionalIdSchema,
  context: z.object({
    runPolicy: runPolicyInputSchema.optional(),
    requestScope: requestScopeInputSchema.optional(),
    locale: localeSchema,
    skillIds: z.array(z.string()).optional(),
    enabledToolIds: z.array(z.string()).optional(),
    disabledToolIds: z.array(z.string()).optional(),
    engineId: z.string().optional(),
    model: z.record(z.string(), z.any()).optional(),
    modelFormat: z.string().optional(),
    modelRevision: z.number().int().nonnegative().optional(),
    analysisType: z.enum(['static', 'dynamic', 'seismic', 'nonlinear']).optional(),
    parameters: z.record(z.string(), z.any()).optional(),
    autoAnalyze: z.boolean().optional(),
    autoCodeCheck: z.boolean().optional(),
    designCode: z.string().optional(),
    codeCheckElements: z.array(z.string()).optional(),
    includeReport: z.boolean().optional(),
    reportFormat: z.enum(['json', 'markdown', 'both']).optional(),
    reportOutput: z.enum(['inline', 'file']).optional(),
    seismicWorkflow: seismicWorkflowSchema,
    userDecision: z.enum(['provide_values', 'confirm_all', 'allow_auto_decide', 'revise']).optional(),
    providedValues: z.record(z.string(), z.any()).optional(),
    attachments: z.array(z.object({
      fileId: z.string(),
      originalName: z.string(),
      relPath: z.string(),
      mimeType: z.string().optional(),
      size: z.number().optional(),
    })).optional(),
  }).optional(),
});

const resumeStreamSchema = z.object({
  conversationId: z.string().min(1),
  resumeValue: z.string().min(1).max(10000),
  attachments: streamMessageSchema.shape.context.unwrap().shape.attachments,
});

const persistMessagesSchema = z.object({
  userMessage: z.string().min(1).max(10000),
  assistantContent: z.string().max(10000).default(''),
  assistantAborted: z.boolean().optional(),
  traceId: optionalIdSchema,
  assistantPresentation: z.record(z.string(), z.any()).optional(),
  userMessageAttachments: z.array(z.object({
    fileId: z.string(),
    originalName: z.string(),
    relPath: z.string(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
  })).optional(),
});

export async function chatRoutes(fastify: FastifyInstance) {
  // 发送消息
  fastify.post('/message', {
    schema: {
      tags: ['Chat'],
      summary: '发送消息给 AI 助手',
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string' },
          conversationId: { type: 'string' },
          traceId: { type: 'string' },
          context: { type: 'object' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof sendMessageSchema> }>, reply: FastifyReply) => {
    try {
      const body = sendMessageSchema.parse(request.body);
      const effectiveMessage = body.message.trim();
      const conversationId = body.conversationId || (await conversationService.createConversation({
        title: body.message.slice(0, 48),
        type: 'general',
        locale: body.context?.locale,
      })).id;

      const result = await agentService.run({
        ...body,
        conversationId,
        message: effectiveMessage,
      });
      await persistLatestConversationResult({
        conversationId: result.conversationId,
        latestResult: result,
      });
      const assistantText = result.response || '';
      const assistantPresentation = rebuildAssistantPresentationFromResult({
        base: createEmptyAssistantPresentation({
          traceId: result.traceId ?? body.traceId,
          mode: Array.isArray(result.toolCalls) && result.toolCalls.length > 0 ? 'execution' : 'conversation',
          startedAt: result.startedAt,
        }),
        result: result as any,
        mode: Array.isArray(result.toolCalls) && result.toolCalls.length > 0 ? 'execution' : 'conversation',
        locale: body.context?.locale ?? 'en',
        traceId: result.traceId ?? body.traceId,
        startedAt: result.startedAt,
      });
      const debugDetails = buildPersistedDebugDetails({
        userMessage: body.message,
        context: body.context,
        result,
      });
      // Fetch LangGraph snapshot for intermediate messages (tool calls/outputs).
      // Both user+assistant and intermediate messages are persisted in a single
      // write so that `createdAt` timestamps reflect correct conversational order.
      let snapshotState: AgentState | undefined;
      try {
        const snapshot = await agentService.getConversationSessionSnapshot(
          result.conversationId,
          body.context?.locale ?? 'en',
        );
        snapshotState = snapshot?.state;
      } catch { /* best-effort */ }

      await persistConversationWithState({
        conversationId: result.conversationId,
        userMessage: body.message,
        assistantContent: assistantText,
        traceId: body.traceId,
        assistantMetadata: debugDetails ? { debugDetails } : undefined,
        assistantPresentation,
        userMessageAttachments: body.context?.attachments,
        state: snapshotState,
      });

      return reply.send({ result });
    } catch (error) {
      const mappedError = toLlmApiError(error);
      if (isLlmTimeoutError(error)) {
        request.log.warn({
          err: error,
          llmModel: config.llmModel,
          llmTimeoutMs: config.llmTimeoutMs,
          llmMaxRetries: config.llmMaxRetries,
        }, 'LLM request timeout in /api/v1/chat/message');
      } else {
        request.log.error({ err: error }, 'Unexpected error in /api/v1/chat/message');
      }
      return reply.code(mappedError.statusCode).send(mappedError.body);
    }
  });

  // 创建会话
  fastify.post('/conversation', {
    schema: {
      tags: ['Chat'],
      summary: '创建新会话',
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof createConversationSchema> }>, reply: FastifyReply) => {
    const body = createConversationSchema.parse(request.body);

    const conversation = await conversationService.createConversation({
      title: body.title,
      type: body.type,
      locale: body.locale,
    });

    return reply.send(conversation);
  });

  // The projection reads the checkpoint and existing ledgers; it never starts/resumes an agent.
  fastify.get('/conversation/:id/session', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!await conversationService.conversationExists(request.params.id)) return reply.code(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    const session = await agentService.getConversationSessionSnapshot(request.params.id, 'en');
    if (!session) return reply.code(503).send({ error: 'CONVERSATION_STATE_UNAVAILABLE' });
    return reply.send(session.snapshot.runtime);
  });

  fastify.post('/conversation/:id/turn/end', async (request: FastifyRequest<{
    Params: { id: string }; Body: { expectedRunId: string };
  }>, reply) => {
    const parsed = z.object({ expectedRunId: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'EXPECTED_RUN_ID_REQUIRED' });
    const body = parsed.data;
    const conversation = await prisma.conversation.findFirst({ where: { id: request.params.id }, select: { id: true } });
    if (!conversation) return reply.code(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    try {
      const ended = await agentService.endWaitingTurn(request.params.id, body.expectedRunId);
      let presentation = createEmptyAssistantPresentation({ traceId: ended.traceId, mode: 'conversation' });
      presentation = reducePresentationEvent(presentation, { type: 'summary_replace', summaryText: ended.response });
      presentation = reducePresentationEvent(presentation, { type: 'presentation_complete', completedAt: ended.completedAt });
      await persistConversationWithState({ conversationId: request.params.id, userMessage: ended.userMessage,
        assistantContent: ended.response, assistantPresentation: presentation, state: ended.state, traceId: ended.traceId,
        assistantMetadata: { turnEnded: true, runId: body.expectedRunId },
      });
      return reply.send({ success: true, runtime: ended.runtime });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'CONVERSATION_TURN_END_FAILED';
      if (['CONVERSATION_BUSY', 'CONVERSATION_TURN_CONFLICT', 'CONVERSATION_NOT_WAITING_FOR_REPLY', 'CONVERSATION_WAITING_STATE_INVALID'].includes(code)) {
        return reply.code(409).send({ error: code });
      }
      request.log.error({ err: error }, 'Failed to end the waiting conversation turn');
      return reply.code(500).send({ error: code });
    }
  });

  // 获取会话历史
  fastify.get('/conversation/:id', {
    schema: {
      tags: ['Chat'],
      summary: '获取会话历史',
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Querystring: z.infer<typeof conversationDetailQuerySchema> }>, reply: FastifyReply) => {
    const { id } = request.params;
    const query = conversationDetailQuerySchema.parse(request.query);

    const conversation = await conversationService.getConversation(id);
    if (!conversation) {
      return reply.send(conversation);
    }

    const session = await agentService.getConversationSessionSnapshot(id, query.locale ?? 'en');
    const snapshots = await conversationService.getConversationSnapshot(id);
    return reply.send({
      ...conversation,
      session: session?.snapshot ?? null,
      snapshots,
    });
  });

  // 获取用户所有会话
  fastify.get('/conversations', {
    schema: {
      tags: ['Chat'],
      summary: '获取用户所有会话',
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const conversations = await conversationService.getConversations();
    return reply.send(conversations);
  });

  fastify.delete('/conversation/:id', {
    schema: {
      tags: ['Chat'],
      summary: '删除会话',
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    const deleted = await conversationService.deleteConversation(id);
    if (!deleted) {
      return reply.code(404).send({
        error: 'Conversation not found',
      });
    }

    await agentService.clearConversationSession(id);
    return reply.send({
      success: true,
      id,
    });
  });

  // 保存会话快照
  const saveSnapshotSchema = z.object({
    modelSnapshot: z.record(z.string(), z.any()).nullable().optional(),
    resultSnapshot: z.record(z.string(), z.any()).nullable().optional(),
    latestResult: z.record(z.string(), z.any()).nullable().optional(),
  });

  fastify.post('/conversation/:id/snapshot', {
    schema: {
      tags: ['Chat'],
      summary: '保存会话快照',
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: z.infer<typeof saveSnapshotSchema> }>, reply: FastifyReply) => {
    const { id } = request.params;
    const body = saveSnapshotSchema.parse(request.body);

    const conversation = await prisma.conversation.findFirst({
      where: { id },
    });

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    await conversationService.saveConversationSnapshot({
      conversationId: id,
      modelSnapshot: body.modelSnapshot,
      resultSnapshot: body.resultSnapshot,
      latestResult: body.latestResult,
    });

    return reply.send({ success: true });
  });

  fastify.post('/conversation/:id/messages', {
    schema: {
      tags: ['Chat'],
      summary: '保存会话消息',
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: z.infer<typeof persistMessagesSchema> }>, reply: FastifyReply) => {
    const { id } = request.params;
    const body = persistMessagesSchema.parse(request.body);

    await persistConversationWithState({
      conversationId: id,
      userMessage: body.userMessage,
      assistantContent: body.assistantContent,
      assistantAborted: body.assistantAborted,
      traceId: body.traceId,
      assistantPresentation: body.assistantPresentation as AssistantPresentation | undefined,
      userMessageAttachments: body.userMessageAttachments,
    });

    return reply.send({ success: true });
  });

  // 流式响应 (SSE)
  fastify.post('/stream', {
    schema: {
      tags: ['Chat'],
      summary: '流式对话 (Server-Sent Events)',
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof streamMessageSchema> }>, reply: FastifyReply) => {
    const body = parseRequest(streamMessageSchema, request.body);
    const conversationId = body.conversationId || (await conversationService.createConversation({
      title: body.message.slice(0, 48),
      type: 'general',
      locale: body.context?.locale,
    })).id;
    let streamConversationId = conversationId;
    const effectiveMessage = body.message.trim();

    let assistantContent = '';
    let assistantMetadata: Record<string, unknown> | undefined;
    let streamTraceId = body.traceId;
    let assistantPresentation = createEmptyAssistantPresentation({
      traceId: streamTraceId,
      mode: 'execution',
    });
    let messagesPersisted = false;
    let streamStarted = false;

    const persistStreamMessages = async (assistantAborted?: boolean) => {
      if (messagesPersisted || !streamStarted) {
        return;
      }
      const persistedPresentation = assistantAborted && assistantPresentation.status === 'streaming'
        ? {
            ...assistantPresentation,
            status: 'aborted' as const,
            completedAt: assistantPresentation.completedAt ?? new Date().toISOString(),
          }
        : assistantPresentation;

      // Fetch LangGraph snapshot for intermediate tool-call messages so
      // everything is written in a single createMany with correct ordering.
      let snapshotState: AgentState | undefined;
      if (streamConversationId) {
        try {
          const snapshot = await agentService.getConversationSessionSnapshot(
            streamConversationId,
            body.context?.locale ?? 'en',
          );
          snapshotState = snapshot?.state;
        } catch { /* best-effort */ }
      }

      await persistConversationWithState({
        conversationId: streamConversationId,
        userMessage: body.message,
        assistantContent,
        assistantAborted,
        traceId: streamTraceId,
        assistantMetadata,
        assistantPresentation: persistedPresentation,
        userMessageAttachments: body.context?.attachments,
        state: snapshotState,
      });
      messagesPersisted = true;
    };

    const relay = async (session: SseTurnSession) => {
      const stream = agentService.runStream({
        ...body,
        conversationId,
        message: effectiveMessage,
        signal: session.signal,
      });

      for await (const chunk of stream) {
        if (session.signal.aborted) break;
        if (chunk.type === 'start') streamStarted = true;
        if (
          chunk
          && typeof chunk === 'object'
          && (chunk as { type?: string }).type === 'start'
          && (chunk as { content?: { conversationId?: string } }).content?.conversationId
        ) {
          const startContent = (chunk as { content: { conversationId: string; traceId?: string } }).content;
          streamConversationId = startContent.conversationId;
          if (startContent.traceId) streamTraceId = startContent.traceId;
        }
        if (
          chunk
          && typeof chunk === 'object'
          && (chunk as { type?: string }).type === 'presentation_init'
          && (chunk as { presentation?: unknown }).presentation
        ) {
          assistantPresentation = (chunk as { presentation: AssistantPresentation }).presentation;
        }
        if (
          chunk
          && typeof chunk === 'object'
          && (chunk as { type?: string }).type === 'phase_upsert'
          && (chunk as { phase?: unknown }).phase
        ) {
          assistantPresentation = reducePresentationEvent(
            assistantPresentation,
            chunk as Parameters<typeof reducePresentationEvent>[1],
          );
        }
        if (
          chunk
          && typeof chunk === 'object'
          && (chunk as { type?: string }).type === 'step_upsert'
          && (chunk as { step?: unknown }).step
        ) {
          assistantPresentation = reducePresentationEvent(
            assistantPresentation,
            chunk as Parameters<typeof reducePresentationEvent>[1],
          );
        }
        if (
          chunk
          && typeof chunk === 'object'
          && (chunk as { type?: string }).type === 'artifact_upsert'
          && (chunk as { artifact?: unknown }).artifact
        ) {
          assistantPresentation = reducePresentationEvent(
            assistantPresentation,
            chunk as Parameters<typeof reducePresentationEvent>[1],
          );
        }
        if (
          chunk
          && typeof chunk === 'object'
          && (chunk as { type?: string }).type === 'summary_replace'
          && typeof (chunk as { summaryText?: unknown }).summaryText === 'string'
        ) {
          assistantPresentation = reducePresentationEvent(
            assistantPresentation,
            chunk as Parameters<typeof reducePresentationEvent>[1],
          );
          assistantContent = (chunk as { summaryText: string }).summaryText;
        }
        if (
          chunk
          && typeof chunk === 'object'
          && (chunk as { type?: string }).type === 'presentation_complete'
          && typeof (chunk as { completedAt?: unknown }).completedAt === 'string'
        ) {
          assistantPresentation = reducePresentationEvent(
            assistantPresentation,
            chunk as Parameters<typeof reducePresentationEvent>[1],
          );
        }
        if (
          chunk
          && typeof chunk === 'object'
          && (chunk as { type?: string }).type === 'presentation_error'
          && (chunk as { phase?: unknown }).phase
        ) {
          assistantPresentation = reducePresentationEvent(
            assistantPresentation,
            chunk as Parameters<typeof reducePresentationEvent>[1],
          );
          const errorPayload = chunk as { message?: string };
          if (typeof errorPayload.message === 'string' && errorPayload.message.trim().length > 0) {
            assistantContent = errorPayload.message;
          }
        }
        if (
          chunk
          && typeof chunk === 'object'
          && (chunk as { type?: string }).type === 'token'
          && typeof (chunk as { content?: unknown }).content === 'string'
        ) {
          assistantContent += (chunk as { content: string }).content;
        }
        if (
          chunk
          && typeof chunk === 'object'
          && (chunk as { type?: string }).type === 'result'
        ) {
          await persistLatestConversationResult({
            conversationId: streamConversationId,
            latestResult: (chunk as { content?: unknown }).content,
          });
          const resultContent = (chunk as { content?: { response?: string; clarification?: { question?: string } } }).content;
          if (resultContent?.response) {
            assistantContent = resultContent.response;
          } else if (resultContent?.clarification?.question) {
            assistantContent = resultContent.clarification.question;
          }
          if (resultContent && typeof resultContent === 'object') {
            const preStepIds = new Set(
              assistantPresentation.phases.flatMap((p) => p.steps.map((s) => s.id)),
            );
            assistantPresentation = rebuildAssistantPresentationFromResult({
              base: assistantPresentation,
              result: resultContent as Parameters<typeof rebuildAssistantPresentationFromResult>[0]['result'],
              mode: assistantPresentation.mode,
              locale: body.context?.locale ?? 'en',
              traceId: streamTraceId,
              startedAt: assistantPresentation.startedAt,
            });
            // Emit only steps added by the rebuild (new IDs not present in streaming)
            for (const phase of assistantPresentation.phases) {
              for (const step of phase.steps) {
                if (!preStepIds.has(step.id)) {
                  session.writeEvent({ type: 'phase_upsert', phase: { phaseId: phase.phaseId, phase: phase.phase, title: phase.title, status: phase.status, steps: [] } });
                  session.writeEvent({ type: 'step_upsert', phaseId: phase.phaseId, step });
                }
              }
            }
          }
          if (!assistantPresentation.summaryText && assistantContent.trim().length > 0) {
            assistantPresentation = reducePresentationEvent(assistantPresentation, {
              type: 'summary_replace',
              summaryText: assistantContent,
            });
          }
          const debugDetails = buildPersistedDebugDetails({
            userMessage: body.message,
            context: body.context,
            result: resultContent,
          });
          assistantMetadata = debugDetails ? { debugDetails } : undefined;
        }
        if (
          chunk
          && typeof chunk === 'object'
          && (chunk as { type?: string }).type === 'interaction_update'
          && (chunk as { content?: unknown }).content
        ) {
          const interactionContent = (chunk as { content: Record<string, unknown> }).content;
          if (typeof interactionContent.guidanceText === 'string') {
            assistantContent = interactionContent.guidanceText;
          } else if (
            Array.isArray(interactionContent.questions)
            && interactionContent.questions.length > 0
            && typeof (interactionContent.questions[0] as { question?: string })?.question === 'string'
          ) {
            assistantContent = (interactionContent.questions[0] as { question: string }).question;
          }
        }
        session.writeChunk(chunk);
      }
    };

    await runSseTurn(request, reply, {
      route: '/api/v1/chat/stream',
      abortedMessage: 'Stream aborted by client',
      conversationId: () => streamConversationId,
      relay,
      persist: persistStreamMessages,
      onFailure: (message) => {
        assistantContent = message;
        assistantPresentation = reducePresentationEvent(assistantPresentation, { type: 'presentation_error', phase: 'modeling', message });
      },
      interruptedPersistMessage: 'Failed to persist interrupted stream',
      onFinalPersistError: persistError => request.log.error({ err: persistError }, 'Failed to persist stream'),
    });
  });

  // Resume a paused LangGraph agent (human-in-the-loop clarification response)
  fastify.post('/stream/resume', {
    schema: {
      tags: ['Chat'],
      summary: 'Resume a paused agent after human clarification',
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof resumeStreamSchema> }>, reply: FastifyReply) => {
    const body = parseRequest(resumeStreamSchema, request.body);

    let resumeAssistantContent = '';
    let resumePresentation = createEmptyAssistantPresentation({ mode: 'execution' });
    let resumeLatestResult: Record<string, unknown> | undefined;
    let resumeTraceId: string | undefined;
    let resumePersisted = false;
    let resumeStarted = false;
    const persistResume = async (assistantAborted = false) => {
      if (resumePersisted || !resumeStarted) return;
      let state: AgentState | undefined;
      try { state = (await agentService.getConversationSessionSnapshot(body.conversationId, 'en'))?.state; }
      catch { /* The durable graph checkpoint remains authoritative if its read fails. */ }
      await persistConversationWithState({ conversationId: body.conversationId, userMessage: body.resumeValue,
        assistantContent: resumeAssistantContent, assistantAborted, traceId: resumeTraceId,
        assistantPresentation: resumePresentation, state, userMessageAttachments: body.attachments });
      resumePersisted = true;
      if (resumeLatestResult) await persistLatestConversationResult({
        conversationId: body.conversationId, latestResult: resumeLatestResult,
      });
    };

    const relay = async (session: SseTurnSession) => {
      const stream = agentService.resumeStream(body.conversationId, body.resumeValue, session.signal, body.attachments);

      for await (const chunk of stream) {
        if (session.signal.aborted) break;
        if (chunk.type === 'start') resumeStarted = true;
        if (chunk.type === 'start' && chunk.content && typeof chunk.content === 'object') {
          const traceId = (chunk.content as { traceId?: unknown }).traceId;
          if (typeof traceId === 'string') resumeTraceId = traceId;
        }
        if (chunk.type === 'token' && 'content' in chunk) {
          resumeAssistantContent += (chunk as any).content || '';
        }
        if (chunk.type === 'presentation_init' && 'presentation' in chunk) {
          resumePresentation = (chunk as any).presentation;
        }
        if (chunk.type === 'phase_upsert' || chunk.type === 'step_upsert' || chunk.type === 'artifact_upsert'
          || chunk.type === 'summary_replace' || chunk.type === 'presentation_complete' || chunk.type === 'presentation_error') {
          resumePresentation = reducePresentationEvent(resumePresentation, chunk);
          if (chunk.type === 'summary_replace') resumeAssistantContent = chunk.summaryText;
          if (chunk.type === 'presentation_error') resumeAssistantContent = chunk.message;
        }
        if (chunk.type === 'result' && 'content' in chunk) {
          resumeLatestResult = (chunk as any).content;
          if (typeof resumeLatestResult?.response === 'string') {
            resumeAssistantContent = resumeLatestResult.response;
            resumePresentation = reducePresentationEvent(resumePresentation, { type: 'summary_replace', summaryText: resumeAssistantContent });
          }
        }
        if (chunk.type === 'interaction_update' && chunk.content && typeof chunk.content === 'object') {
          const interaction = chunk.content as { guidanceText?: string; questions?: Array<{ question?: string }> };
          const question = interaction.questions?.[0]?.question;
          if (typeof interaction.guidanceText === 'string') resumeAssistantContent = interaction.guidanceText;
          else if (question && !resumeAssistantContent.includes(question)) {
            resumeAssistantContent = [resumeAssistantContent, question].filter(Boolean).join('\n\n');
          }
          resumePresentation = reducePresentationEvent(resumePresentation, { type: 'summary_replace', summaryText: resumeAssistantContent });
        }
        session.writeChunk(chunk);
      }
    };

    await runSseTurn(request, reply, {
      route: '/api/v1/chat/stream/resume',
      abortedMessage: 'Resume stream aborted by client',
      conversationId: () => body.conversationId,
      relay,
      persist: persistResume,
      onFailure: (message) => {
        resumeAssistantContent = message;
        resumePresentation = reducePresentationEvent(resumePresentation, { type: 'presentation_error', phase: 'modeling', message });
      },
      interruptedPersistMessage: 'Failed to persist interrupted resume',
      onFinalPersistError: persistError => request.log.error({ err: persistError }, 'Failed to persist resume'),
    });
  });

}
