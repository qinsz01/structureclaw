import { prisma } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import type { InputJsonValue } from '../utils/json.js';
import type { AssistantPresentation } from './chat-presentation.js';
import type { AppLocale } from '../shared/locale.js';
import type { RunPolicyInput } from '../runtime/run-policy.js';
import type { BaseMessage } from '@langchain/core/messages';
import { ConversationService } from './conversation.js';

const conversationService = new ConversationService();

/** Request-context fields recorded in the persisted debug details. */
interface PersistedDebugContext {
  runPolicy?: RunPolicyInput;
  locale?: AppLocale;
  skillIds?: string[];
  enabledToolIds?: string[];
  engineId?: string;
  seismicWorkflow?: Record<string, unknown>;
}

/** The checkpointed agent-state slice whose intermediate tool-call messages are persisted. */
interface PersistableConversationState {
  messages?: BaseMessage[];
}

function toMessageMetadata(value: Record<string, unknown> | undefined): InputJsonValue | undefined {
  if (!value || Object.keys(value).length === 0) {
    return undefined;
  }
  return value as InputJsonValue;
}

function getPersistedMessageTraceId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const traceId = (metadata as Record<string, unknown>).traceId;
  return typeof traceId === 'string' && traceId.trim().length > 0 ? traceId : undefined;
}

export function buildPersistedDebugDetails(params: {
  userMessage: string;
  context?: PersistedDebugContext;
  result: unknown;
}): Record<string, unknown> | undefined {
  const resultRecord = params.result && typeof params.result === 'object' && !Array.isArray(params.result)
    ? params.result as Record<string, unknown>
    : null;
  if (!resultRecord) {
    return undefined;
  }

  const skillIds = Array.isArray(params.context?.skillIds)
    ? params.context.skillIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const toolIds = Array.isArray(params.context?.enabledToolIds)
    ? params.context.enabledToolIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const routing = resultRecord.routing && typeof resultRecord.routing === 'object' && !Array.isArray(resultRecord.routing)
    ? resultRecord.routing as Record<string, unknown>
    : undefined;
  const plan = Array.isArray(resultRecord.plan)
    ? resultRecord.plan.filter((value): value is string => typeof value === 'string')
    : [];
  const toolCalls = Array.isArray(resultRecord.toolCalls) ? resultRecord.toolCalls : [];

  if (
    skillIds.length === 0
    && toolIds.length === 0
    && !routing
    && plan.length === 0
    && toolCalls.length === 0
    && typeof resultRecord.response !== 'string'
  ) {
    return undefined;
  }

  // Build a compact context snapshot, omitting large fields like model/parameters
  // to avoid DB bloat.
  const compactContext: Record<string, unknown> = {};
  if (params.context?.runPolicy) compactContext.runPolicy = params.context.runPolicy;
  if (params.context?.locale) compactContext.locale = params.context.locale;
  if (params.context?.skillIds) compactContext.skillIds = params.context.skillIds;
  if (params.context?.enabledToolIds) compactContext.enabledToolIds = params.context.enabledToolIds;
  if (params.context?.engineId) compactContext.engineId = params.context.engineId;
  if (params.context?.seismicWorkflow) compactContext.seismicWorkflow = params.context.seismicWorkflow;

  return {
    promptSnapshot: JSON.stringify({
      message: params.userMessage,
      context: compactContext,
    }, null, 2),
    skillIds,
    toolIds,
    routing,
    responseSummary: typeof resultRecord.response === 'string' ? resultRecord.response : '',
    plan,
    toolCalls,
  };
}

export async function persistLatestConversationResult(params: {
  conversationId?: string;
  latestResult: unknown;
}): Promise<void> {
  const conversationId = params.conversationId?.trim();
  if (!conversationId) {
    return;
  }

  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId },
      select: { id: true },
    });

    if (!conversation) {
      return;
    }

    const latestResult =
      params.latestResult && typeof params.latestResult === 'object' && !Array.isArray(params.latestResult)
        ? (params.latestResult as Record<string, unknown>)
        : { response: String(params.latestResult ?? ''), success: false };

    await conversationService.saveConversationSnapshot({
      conversationId: conversation.id,
      latestResult,
    });
  } catch (error) {
    logger.warn({ err: error }, '[chat] skip latestResult persistence');
  }
}

/**
 * Unified persistence: writes user message, intermediate tool-call chain,
 * and final assistant message in ONE createMany call so that `createdAt`
 * timestamps naturally reflect conversational order.
 *
 * Order: user → [AI(tool_calls) → tool(output)]* → assistant(final)
 */
export async function persistConversationWithState(params: {
  conversationId?: string;
  userMessage: string;
  assistantContent: string;
  assistantAborted?: boolean;
  traceId?: string;
  assistantMetadata?: Record<string, unknown>;
  assistantPresentation?: AssistantPresentation;
  userMessageAttachments?: Array<Record<string, unknown>>;
  state?: PersistableConversationState;
}): Promise<void> {
  const conversationId = params.conversationId?.trim();
  const userMessage = params.userMessage.trim();
  const assistantContent = params.assistantContent.length > 10000
    ? params.assistantContent.slice(0, 10000)
    : params.assistantContent;
  const shouldPersistAssistant = assistantContent.trim().length > 0 || Boolean(params.assistantAborted);

  if (!conversationId || !userMessage || !shouldPersistAssistant) return;

  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId },
      select: { id: true },
    });
    if (!conversation) return;

    // Trace-based dedup: if we already persisted this trace, skip entirely.
    if (params.traceId) {
      const recentMessages = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: { metadata: true },
      });
      if (recentMessages.some((msg: { metadata: unknown }) => getPersistedMessageTraceId(msg.metadata) === params.traceId)) {
        return;
      }
    }

    const records: Record<string, unknown>[] = [];
    // Use an explicit base timestamp with 1ms offsets per record so that
    // createdAt reliably reflects conversational order.  SQLite's
    // datetime('now') has only second precision — a single createMany would
    // assign identical createdAt to every row, making order undefined.
    const baseTime = Date.now();

    // 1. User message (always first)
    records.push({
      conversationId,
      role: 'user',
      content: userMessage,
      createdAt: new Date(baseTime),
      metadata: toMessageMetadata({
        ...(params.traceId ? { traceId: params.traceId } : {}),
        ...(params.userMessageAttachments && params.userMessageAttachments.length > 0
          ? { attachments: params.userMessageAttachments }
          : {}),
      }),
    });

    // 2. Intermediate messages from LangGraph state (tool calls + outputs)
    //    These sit BETWEEN user message and final assistant message.
    if (params.state && Array.isArray(params.state.messages)) {
      let seq = records.length; // continues after user message
      const allMessages: BaseMessage[] = params.state.messages;

      // Id-based dedup against existing DB records
      const existingToolMessages = await prisma.message.findMany({
        where: { conversationId, role: 'tool', toolCallId: { not: null } },
        select: { toolCallId: true },
      });
      const existingToolCallIds = new Set(
        existingToolMessages.map((m: { toolCallId: string | null }) => m.toolCallId).filter(Boolean),
      );
      const existingAssistantWithToolCalls = await prisma.message.findMany({
        where: { conversationId, role: 'assistant' },
        select: { toolCalls: true },
      });
      const existingToolCallIdsOnAssistant = new Set<string>();
      for (const row of existingAssistantWithToolCalls) {
        const tcs = Array.isArray(row.toolCalls) ? row.toolCalls : [];
        for (const tc of tcs) {
          const tcRecord = tc as Record<string, unknown>;
          if (typeof tcRecord.id === 'string') existingToolCallIdsOnAssistant.add(tcRecord.id);
        }
      }

      for (const msg of allMessages) {
        if (msg == null || typeof msg !== 'object') continue;

        const getType = typeof (msg as any)._getType === 'function' ? (msg as any)._getType() : null;
        const content = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((b: unknown): b is { type: string; text: string } =>
                  typeof b === 'object' && b !== null && 'text' in b)
                .map((b) => b.text)
                .join('')
            : JSON.stringify(msg.content);

        if (getType === 'tool') {
          const toolCallId = (msg as any).tool_call_id || undefined;
          if (toolCallId && existingToolCallIds.has(toolCallId)) continue;
          records.push({
            conversationId,
            role: 'tool',
            content: typeof content === 'string' ? content : JSON.stringify(content),
            name: (msg as any).name || undefined,
            toolCallId,
            createdAt: new Date(baseTime + seq),
          });
          seq += 1;
        } else if (getType === 'ai') {
          const toolCalls = Array.isArray((msg as any).tool_calls) ? (msg as any).tool_calls : [];
          if (toolCalls.length === 0) continue; // final AI is handled separately below
          const tcIds = toolCalls.map((tc: any) => tc.id ?? '');
          if (tcIds.length > 0 && tcIds.every((id: string) => existingToolCallIdsOnAssistant.has(id))) continue;
          records.push({
            conversationId,
            role: 'assistant',
            // The SSE clarification summary includes its tool-call narration.
            // Keep the call chain, but store that user-visible text only once.
            content: typeof content === 'string' && content.trim() && assistantContent.includes(content.trim())
              ? '' : typeof content === 'string' ? content : JSON.stringify(content),
            toolCalls: toolCalls.map((tc: any) => ({
              id: tc.id ?? '',
              name: tc.name ?? '',
              args: tc.args ?? {},
            })),
            createdAt: new Date(baseTime + seq),
          });
          seq += 1;
        }
      }
    }

    // 3. Final assistant message (always last)
    records.push({
      conversationId,
      role: 'assistant',
      content: assistantContent,
      createdAt: new Date(baseTime + records.length),
      metadata: toMessageMetadata({
        ...(params.assistantMetadata ? params.assistantMetadata : {}),
        ...(params.assistantPresentation ? { presentation: params.assistantPresentation } : {}),
        ...(params.traceId ? { traceId: params.traceId } : {}),
        ...(params.assistantAborted ? { status: 'aborted' } : {}),
      }),
    });

    await prisma.message.createMany({ data: records as any });
  } catch (error) {
    logger.warn({ err: error }, '[chat] skip message persistence');
  }
}
