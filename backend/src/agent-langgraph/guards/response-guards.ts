/**
 * Provider-level tool-call repair for an LLM response, before it is written to graph state.
 *
 * - A tool call without an id cannot be acknowledged by a ToolMessage; it gets a generated id.
 *   Adapters may report such a call in `invalid_tool_calls` although its arguments are valid
 *   JSON; it is restored as an ordinary call.
 * - A tool call whose arguments are not valid JSON would otherwise end the turn silently (a
 *   "tool-call-only" response with no executable call). It is kept as a tool call whose
 *   arguments carry the raw text under MALFORMED_ARGUMENTS_KEY, so the tools node answers it
 *   with a structured error without executing.
 */
import { randomUUID } from 'node:crypto';
import { AIMessage, type AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { recordGuardEvent } from '../../runtime/run-context.js';
import { MALFORMED_ARGUMENTS_KEY } from './tool-guards.js';

interface RawToolCall { id?: string; name?: string; args?: unknown; type?: string }

function listOf(value: unknown): RawToolCall[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as RawToolCall[] : [];
}

function parsedObject(args: unknown): Record<string, unknown> | undefined {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args !== 'string') return undefined;
  try {
    const value = JSON.parse(args);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

const generatedId = (): string => `call_guard_${randomUUID()}`;

/** The response itself when its tool calls are executable, otherwise a repaired copy. */
export function repairResponseToolCalls(response: AIMessageChunk | BaseMessage): AIMessageChunk | BaseMessage {
  const source = response as unknown as { tool_calls?: unknown; invalid_tool_calls?: unknown; additional_kwargs?: Record<string, unknown> };
  const reported = listOf(source.invalid_tool_calls);
  if (!reported.length && !listOf(source.tool_calls).some(call => !call.id)) return response;
  const usable = reported.filter(call => call.name && parsedObject(call.args));
  const malformed = reported.filter(call => !usable.includes(call));
  const valid = [...listOf(source.tool_calls), ...usable.map(call => ({ ...call, args: parsedObject(call.args) }))];
  const missingIds = valid.filter(call => !call.id).length;
  const toolCalls = [
    ...valid.map(call => ({ ...call, type: 'tool_call' as const, id: call.id || generatedId() })),
    ...malformed.map(call => ({ name: call.name || 'unknown', id: call.id || generatedId(), type: 'tool_call' as const,
      args: { [MALFORMED_ARGUMENTS_KEY]: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? '') } })),
  ];
  if (missingIds) recordGuardEvent('missing-tool-call-id', { action: 'repaired', calls: missingIds });
  // The provider-format copy may still hold the unparseable arguments; tool_calls are authoritative.
  const { tool_calls: _raw, ...additionalKwargs } = source.additional_kwargs ?? {};
  const message = response as unknown as Record<string, unknown>;
  return new AIMessage({
    content: response.content as string,
    tool_calls: toolCalls as AIMessage['tool_calls'],
    invalid_tool_calls: [],
    additional_kwargs: additionalKwargs,
    ...(typeof message.id === 'string' ? { id: message.id } : {}),
    ...(message.response_metadata ? { response_metadata: message.response_metadata as Record<string, unknown> } : {}),
    ...(message.usage_metadata ? { usage_metadata: message.usage_metadata as AIMessage['usage_metadata'] } : {}),
  });
}
