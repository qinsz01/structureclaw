import { runPolicyInputSchema } from '../runtime/run-policy.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAgentService, LangGraphAgentService } from '../agent-langgraph/index.js';
import { AgentCapabilityService } from '../services/agent-capability.js';
import { listAgentToolDefinitions } from '../agent-langgraph/tool-registry.js';
import { AgentSkillHubService } from '../services/agent-skillhub.js';
import type { SkillDomain } from '../shared/types/agent.js';
import { ConversationService } from '../services/conversation.js';
import { assessCurrentEngineeringInput } from '../engineering/capability-assessment.js';

const agentService = getAgentService();
const capabilityService = new AgentCapabilityService();
const skillHubService = new AgentSkillHubService();

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

const attachmentSchema = z.object({
  fileId: z.string(), originalName: z.string(), relPath: z.string(), mimeType: z.string().optional(),
});

const agentRunSchema = z.object({
  message: z.string().min(1).max(10000),
  conversationId: optionalIdSchema,
  traceId: optionalIdSchema,
  context: z.object({
    runPolicy: runPolicyInputSchema.optional(),
    locale: z.enum(['en', 'zh']).optional(),
    attachments: z.array(attachmentSchema).optional(),
    restrictFileAccessToAttachments: z.boolean().optional(),
    seismicWorkflow: z.record(z.string(), z.unknown()).optional(),
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
    userDecision: z.enum(['provide_values', 'confirm_all', 'allow_auto_decide', 'revise']).optional(),
    providedValues: z.record(z.string(), z.any()).optional(),
  }).optional(),
});

// A reply resumes the saved policy and ledger; it cannot configure a new turn.
const agentResumeSchema = z.object({
  conversationId: z.string().min(1),
  resumeValue: z.string().min(1).max(10000),
}).strict();

const capabilityMatrixQuerySchema = z.object({
  analysisType: z.enum(['static', 'dynamic', 'seismic', 'nonlinear']).optional(),
  conversationId: z.string().min(1).max(256).optional(),
});

const skillHubDomainSchema = z.enum([
  'structure-type',
  'analysis',
  'load-boundary',
  'code-check',
  'data-input',
  'design',
  'drawing',
  'general',
  'material',
  'result-postprocess',
  'report-export',
  'section',
  'validation',
  'visualization',
] as const);

const skillHubSearchQuerySchema = z.object({
  q: z.string().optional(),
  domain: skillHubDomainSchema.optional(),
});

const skillHubMutationSchema = z.object({
  skillId: z.string().min(1),
});

const inputReviewBodySchema = z.object({
  revisionToken: z.string().min(1),
  tool: z.enum(['analyze_file', 'review_input', 'query_model', 'edit_model', 'validate_model']),
  args: z.record(z.string(), z.unknown()),
  initialContext: z.object({
    locale: z.enum(['en', 'zh']).optional(), runPolicy: runPolicyInputSchema.optional(),
    skillIds: z.array(z.string()).optional(), enabledToolIds: z.array(z.string()).optional(), disabledToolIds: z.array(z.string()).optional(),
    restrictFileAccessToAttachments: z.boolean().optional(),
    attachments: z.array(attachmentSchema).optional(),
  }).optional(),
});

export async function agentRoutes(fastify: FastifyInstance) {
  fastify.post('/jobs/:conversationId/:requestId/:action', async (request: FastifyRequest<{ Params: { conversationId: string; requestId: string; action: string } }>, reply) => {
    const { conversationId, requestId } = request.params;
    if (!await new ConversationService().getConversation(conversationId)) return reply.code(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    const action = z.enum(['cancel', 'recover']).parse(request.params.action);
    const { expectedStateHash } = z.object({ expectedStateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
    try { return reply.send(await agentService.manageConversationJob(conversationId, { requestId, action, expectedStateHash })); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(/OUTSIDE_CONVERSATION|PERMISSION_DENIED/.test(message) ? 403 : 409).send({ error: message });
    }
  });
  fastify.get('/input-review/:conversationId', async (request: FastifyRequest<{ Params: { conversationId: string } }>, reply) => {
    const id = request.params.conversationId;
    if (!await new ConversationService().getConversation(id)) return reply.code(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    return reply.send(await agentService.getInputReview(id));
  });
  fastify.post('/input-review/:conversationId/tools', async (request: FastifyRequest<{ Params: { conversationId: string } }>, reply) => {
    const id = request.params.conversationId;
    if (!await new ConversationService().getConversation(id)) return reply.code(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    const body = inputReviewBodySchema.parse(request.body);
    try { return reply.send(await agentService.invokeInputReviewTool(id, body)); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.startsWith('INPUT_REVIEW_REVISION_CONFLICT') ? 409 : message.startsWith('TOOL_NOT_ALLOWED') ? 403 : 400)
        .send({ error: message });
    }
  });
  fastify.get('/result-review/:conversationId', async (request: FastifyRequest<{ Params: { conversationId: string } }>, reply) => {
    const id = request.params.conversationId;
    if (!await new ConversationService().getConversation(id)) return reply.code(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    return reply.send(await agentService.getResultReview(id));
  });
  fastify.post('/result-review/:conversationId/tools', async (request: FastifyRequest<{ Params: { conversationId: string } }>, reply) => {
    const id = request.params.conversationId;
    if (!await new ConversationService().getConversation(id)) return reply.code(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    const body = z.object({ revisionToken: z.string().min(1), tool: z.enum(['query_results', 'generate_report', 'run_code_check']),
      args: z.record(z.string(), z.unknown()) }).parse(request.body);
    try { return reply.send(await agentService.invokeResultReviewTool(id, body)); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.startsWith('INPUT_REVIEW_REVISION_CONFLICT') ? 409
        : /^(TOOL_NOT_ALLOWED|RUN_OUTSIDE_CONVERSATION)/.test(message) ? 403 : 400).send({ error: message });
    }
  });
  fastify.get('/tools', {
    schema: {
      tags: ['Agent'],
      summary: '查询 Agent 工具协议与错误码',
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(LangGraphAgentService.getProtocol());
  });

  fastify.get('/skills', {
    schema: {
      tags: ['Agent'],
      summary: '查询本地内置 Agent Skill 目录',
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(await agentService.listSkills());
  });

  fastify.get('/capability-matrix', {
    schema: {
      tags: ['Agent'],
      summary: '查询技能与分析引擎能力矩阵',
    },
  }, async (request: FastifyRequest<{ Querystring: z.infer<typeof capabilityMatrixQuerySchema> }>, reply: FastifyReply) => {
    const query = capabilityMatrixQuerySchema.parse(request.query);
    const matrix = await capabilityService.getCapabilityMatrix({ analysisType: query.analysisType, toolDefinitions: listAgentToolDefinitions() });
    let session;
    if (query.conversationId) {
      // Follow the same conversation lookup as GET /chat/conversation/:id.
      const conversation = await new ConversationService().getConversation(query.conversationId);
      if (!conversation) return reply.code(404).send({ error: 'CONVERSATION_NOT_FOUND' });
      session = await agentService.getConversationSessionSnapshot(query.conversationId, 'en');
    }
    return reply.send({ ...matrix, currentAssessment: assessCurrentEngineeringInput(session?.state, query.conversationId) });
  });

  fastify.get('/skillhub/search', {
    schema: {
      tags: ['Agent'],
      summary: '搜索外部 SkillHub 扩展技能',
    },
  }, async (request: FastifyRequest<{ Querystring: z.infer<typeof skillHubSearchQuerySchema> }>, reply: FastifyReply) => {
    const query = skillHubSearchQuerySchema.parse(request.query);
    return reply.send(await skillHubService.search({ keyword: query.q, domain: query.domain as SkillDomain | undefined }));
  });

  fastify.get('/skillhub/installed', {
    schema: {
      tags: ['Agent'],
      summary: '列出已安装 SkillHub 扩展技能',
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ items: await skillHubService.listInstalled() });
  });

  fastify.post('/skillhub/install', {
    schema: {
      tags: ['Agent'],
      summary: '安装 SkillHub 扩展技能',
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof skillHubMutationSchema> }>, reply: FastifyReply) => {
    const body = skillHubMutationSchema.parse(request.body);
    return reply.send(await skillHubService.install(body.skillId));
  });

  fastify.post('/skillhub/enable', {
    schema: {
      tags: ['Agent'],
      summary: '启用已安装 SkillHub 技能',
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof skillHubMutationSchema> }>, reply: FastifyReply) => {
    const body = skillHubMutationSchema.parse(request.body);
    return reply.send(await skillHubService.enable(body.skillId));
  });

  fastify.post('/skillhub/disable', {
    schema: {
      tags: ['Agent'],
      summary: '禁用已安装 SkillHub 技能',
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof skillHubMutationSchema> }>, reply: FastifyReply) => {
    const body = skillHubMutationSchema.parse(request.body);
    return reply.send(await skillHubService.disable(body.skillId));
  });

  fastify.post('/skillhub/uninstall', {
    schema: {
      tags: ['Agent'],
      summary: '卸载已安装 SkillHub 技能',
    },
  }, async (request: FastifyRequest<{ Body: z.infer<typeof skillHubMutationSchema> }>, reply: FastifyReply) => {
    const body = skillHubMutationSchema.parse(request.body);
    return reply.send(await skillHubService.uninstall(body.skillId));
  });

  fastify.post('/run', {
    schema: {
      tags: ['Agent'],
      summary: 'Agent 编排入口 (LangGraph ReAct)',
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
  }, async (request: FastifyRequest<{ Body: z.infer<typeof agentRunSchema> }>, reply: FastifyReply) => {
    const body = agentRunSchema.parse(request.body);
    try { return reply.send(await agentService.run(body)); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('CONVERSATION_WAITING_FOR_REPLY')) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  fastify.post('/resume', {
    schema: { tags: ['Agent'], summary: 'Resume a saved clarification / 回复已保存的澄清问题' },
  }, async (request, reply) => {
    const parsed = agentResumeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_RESUME_REQUEST', details: parsed.error.issues });
    try { return reply.send(await agentService.resume(parsed.data.conversationId, parsed.data.resumeValue)); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('CONVERSATION_NOT_WAITING_FOR_REPLY')) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });
}
