import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ChatService } from '../services/chat.js';
import { AgentService } from '../services/agent.js';

const chatService = new ChatService();
const agentService = new AgentService();

// 请求验证
const sendMessageSchema = z.object({
  message: z.string().min(1).max(10000),
  mode: z.enum(['chat', 'execute', 'auto']).optional(),
  conversationId: z.string().optional(),
  context: z.object({
    projectId: z.string().optional(),
    model: z.record(z.any()).optional(),
    modelFormat: z.string().optional(),
    analysisType: z.enum(['static', 'dynamic', 'seismic', 'nonlinear']).optional(),
    parameters: z.record(z.any()).optional(),
    autoAnalyze: z.boolean().optional(),
  }).optional(),
});

const createConversationSchema = z.object({
  title: z.string().optional(),
  type: z.enum(['general', 'analysis', 'design', 'code-check']),
});

const executeSchema = z.object({
  message: z.string().min(1).max(10000),
  context: z.object({
    model: z.record(z.any()).optional(),
    modelFormat: z.string().optional(),
    analysisType: z.enum(['static', 'dynamic', 'seismic', 'nonlinear']).optional(),
    parameters: z.record(z.any()).optional(),
    autoAnalyze: z.boolean().optional(),
  }).optional(),
});

const streamMessageSchema = z.object({
  message: z.string().min(1).max(10000),
  mode: z.enum(['chat', 'execute', 'auto']).optional(),
  conversationId: z.string().optional(),
  context: z.object({
    projectId: z.string().optional(),
    model: z.record(z.any()).optional(),
    modelFormat: z.string().optional(),
    analysisType: z.enum(['static', 'dynamic', 'seismic', 'nonlinear']).optional(),
    parameters: z.record(z.any()).optional(),
    autoAnalyze: z.boolean().optional(),
  }).optional(),
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
          context: { type: 'object' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof sendMessageSchema> }>, reply: FastifyReply) => {
    const body = sendMessageSchema.parse(request.body);
    const userId = request.user?.id;
    const mode = body.mode || 'auto';

    const shouldExecute = mode === 'execute'
      || (mode === 'auto' && Boolean(body.context?.model));

    if (shouldExecute) {
      const result = await agentService.run({
        message: body.message,
        mode: 'execute',
        context: {
          model: body.context?.model,
          modelFormat: body.context?.modelFormat,
          analysisType: body.context?.analysisType,
          parameters: body.context?.parameters,
          autoAnalyze: body.context?.autoAnalyze,
        },
      });
      return reply.send({
        mode: 'execute',
        result,
      });
    }

    const result = await chatService.sendMessage({
      message: body.message,
      conversationId: body.conversationId,
      userId,
      context: body.context,
    });

    return reply.send({
      mode: 'chat',
      result,
    });
  });

  // 创建会话
  fastify.post('/conversation', {
    schema: {
      tags: ['Chat'],
      summary: '创建新会话',
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof createConversationSchema> }>, reply: FastifyReply) => {
    const body = createConversationSchema.parse(request.body);
    const userId = request.user?.id;

    const conversation = await chatService.createConversation({
      title: body.title,
      type: body.type,
      userId,
    });

    return reply.send(conversation);
  });

  // 获取会话历史
  fastify.get('/conversation/:id', {
    schema: {
      tags: ['Chat'],
      summary: '获取会话历史',
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const userId = request.user?.id;

    const conversation = await chatService.getConversation(id, userId);
    return reply.send(conversation);
  });

  // 获取用户所有会话
  fastify.get('/conversations', {
    schema: {
      tags: ['Chat'],
      summary: '获取用户所有会话',
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.id;
    const conversations = await chatService.getUserConversations(userId);
    return reply.send(conversations);
  });

  // 流式响应 (SSE)
  fastify.post('/stream', {
    schema: {
      tags: ['Chat'],
      summary: '流式对话 (Server-Sent Events)',
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof streamMessageSchema> }>, reply: FastifyReply) => {
    const body = streamMessageSchema.parse(request.body);
    const userId = request.user?.id;
    const mode = body.mode || 'auto';

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    const shouldExecute = mode === 'execute'
      || (mode === 'auto' && Boolean(body.context?.model));

    if (shouldExecute) {
      const stream = agentService.runStream({
        message: body.message,
        mode: 'execute',
        context: {
          model: body.context?.model,
          modelFormat: body.context?.modelFormat,
          analysisType: body.context?.analysisType,
          parameters: body.context?.parameters,
          autoAnalyze: body.context?.autoAnalyze,
        },
      });

      for await (const chunk of stream) {
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return;
    }

    const stream = await chatService.streamMessage({
      message: body.message,
      conversationId: body.conversationId,
      userId,
      context: {
        projectId: body.context?.projectId,
        analysisType: body.context?.analysisType,
      },
    });

    for await (const chunk of stream) {
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  });

  // 执行模式：复用 Agent 工具编排链路
  fastify.post('/execute', {
    schema: {
      tags: ['Chat'],
      summary: '执行结构化任务（Agent 工具编排）',
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string' },
          context: { type: 'object' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof executeSchema> }>, reply: FastifyReply) => {
    const body = executeSchema.parse(request.body);
    const result = await agentService.run(body);
    return reply.send(result);
  });
}
