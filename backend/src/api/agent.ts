import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentService } from '../services/agent.js';

const agentService = new AgentService();

const agentRunSchema = z.object({
  message: z.string().min(1).max(10000),
  mode: z.enum(['chat', 'execute', 'auto']).optional(),
  context: z.object({
    model: z.record(z.any()).optional(),
    modelFormat: z.string().optional(),
    analysisType: z.enum(['static', 'dynamic', 'seismic', 'nonlinear']).optional(),
    parameters: z.record(z.any()).optional(),
    autoAnalyze: z.boolean().optional(),
  }).optional(),
});

export async function agentRoutes(fastify: FastifyInstance) {
  fastify.get('/tools', {
    schema: {
      tags: ['Agent'],
      summary: '查询 Agent 工具协议与错误码',
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(AgentService.getProtocol());
  });

  fastify.post('/run', {
    schema: {
      tags: ['Agent'],
      summary: 'OpenClaw 风格 Agent 编排入口',
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string' },
          context: { type: 'object' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof agentRunSchema> }>, reply: FastifyReply) => {
    const body = agentRunSchema.parse(request.body);
    const result = await agentService.run(body);
    return reply.send(result);
  });
}
