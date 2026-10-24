import { afterEach, expect, jest, test } from '@jest/globals';
import Fastify from 'fastify';
import { agentRoutes } from '../dist/api/agent.js';
import { ConversationService } from '../dist/services/conversation.js';
import { LangGraphAgentService } from '../dist/agent-langgraph/agent-service.js';

afterEach(() => jest.restoreAllMocks());
const routes = [
  ['GET', '/input-review/c', undefined, 'getInputReview'],
  ['POST', '/input-review/c/tools', { revisionToken: 'v', tool: 'query_model', args: {} }, 'invokeInputReviewTool'],
  ['GET', '/result-review/c', undefined, 'getResultReview'],
  ['POST', '/result-review/c/tools', { revisionToken: 'v', tool: 'query_results', args: {} }, 'invokeResultReviewTool'],
  ['POST', '/jobs/c/request/cancel', { expectedStateHash: 'a'.repeat(64) }, 'manageConversationJob'],
];

test.each(routes)('%s %s reads the authoritative review without loading chat snapshot caches', async (method, url, payload, operation) => {
  jest.spyOn(ConversationService.prototype, 'conversationExists').mockResolvedValue(true);
  const full = jest.spyOn(ConversationService.prototype, 'getConversation').mockImplementation(() => { throw new Error('Unneeded archive read'); });
  const invoke = jest.spyOn(LangGraphAgentService.prototype, operation).mockResolvedValue({ conversationId: 'c', success: true });
  const server = Fastify(); await server.register(agentRoutes);
  try {
    const response = await server.inject({ method, url, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ conversationId: 'c', success: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(full).not.toHaveBeenCalled();
  } finally { await server.close(); }
});

test.each(routes)('%s %s still rejects a missing conversation before reading or executing its tools', async (method, url, payload, operation) => {
  jest.spyOn(ConversationService.prototype, 'conversationExists').mockResolvedValue(false);
  const invoke = jest.spyOn(LangGraphAgentService.prototype, operation);
  const server = Fastify(); await server.register(agentRoutes);
  try {
    const response = await server.inject({ method, url, payload });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'CONVERSATION_NOT_FOUND' });
    expect(invoke).not.toHaveBeenCalled();
  } finally { await server.close(); }
});
