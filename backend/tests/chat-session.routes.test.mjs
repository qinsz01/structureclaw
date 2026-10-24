import { afterEach, describe, expect, jest, test } from '@jest/globals';
import Fastify from 'fastify';
import { chatRoutes } from '../dist/api/chat.js';
import { ConversationService } from '../dist/services/conversation.js';
import { LangGraphAgentService } from '../dist/agent-langgraph/agent-service.js';

afterEach(() => jest.restoreAllMocks());
describe('chat checkpoint projection HTTP boundary', () => {
  test('history exposes the flat snapshot and status reads the same projection without leaking agent state', async () => {
    const runtime = { conversationId: 'c', busy: false, waitingForReply: true, policy: { policyHash: 'saved' }, usage: { toolCalls: 7 } };
    const snapshot = { model: { nodes: [{ id: 'A' }] }, runtime };
    const fullConversation = jest.spyOn(ConversationService.prototype, 'getConversation').mockResolvedValue({ id: 'c', messages: [] });
    jest.spyOn(ConversationService.prototype, 'conversationExists').mockResolvedValue(true);
    jest.spyOn(ConversationService.prototype, 'getConversationSnapshot').mockResolvedValue({ latestResult: null });
    jest.spyOn(LangGraphAgentService.prototype, 'getConversationSessionSnapshot').mockResolvedValue({ snapshot, state: { messages: ['internal'] } });
    const run = jest.spyOn(LangGraphAgentService.prototype, 'run');
    const server = Fastify(); await server.register(chatRoutes);
    try {
      const history = await server.inject('/conversation/c');
      expect(history.statusCode).toBe(200);
      expect(history.json().session).toEqual(snapshot);
      expect(history.json().session.state).toBeUndefined();
      const response = await server.inject('/conversation/c/session');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(runtime);
      expect(fullConversation).toHaveBeenCalledTimes(1); // Only the explicit history read.
      expect(run).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
  test('an unavailable checkpoint is not reported as an idle conversation', async () => {
    jest.spyOn(ConversationService.prototype, 'conversationExists').mockResolvedValue(true);
    const fullConversation = jest.spyOn(ConversationService.prototype, 'getConversation').mockImplementation(() => { throw new Error('Numerical snapshots are not needed for status polling'); });
    jest.spyOn(LangGraphAgentService.prototype, 'getConversationSessionSnapshot').mockResolvedValue(undefined);
    const server = Fastify(); await server.register(chatRoutes);
    try {
      expect((await server.inject('/conversation/c/session')).statusCode).toBe(503);
      expect(fullConversation).not.toHaveBeenCalled();
    }
    finally { await server.close(); }
  });
});
