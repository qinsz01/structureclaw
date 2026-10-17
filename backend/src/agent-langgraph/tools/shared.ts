import { type LangGraphRunnableConfig, Command } from '@langchain/langgraph';
import { ToolMessage } from '@langchain/core/messages';
import { mergeLlmTokenUsage, type LlmTokenUsage } from '../../utils/llm.js';
import type { AgentState } from '../state.js';
import type { AgentConfigurable } from '../configurable.js';
import type { LegacyToolConfigurable } from '../tool-context.js';
import { currentRunPolicy } from '../../runtime/run-context.js';
import { missingInputNextAction, type MissingInputNextAction } from '../../runtime/ablation-profiles.js';

/** Whether ask_user_clarification is exposed in this run (no policy: direct host, full system). */
export function clarificationAvailable(): boolean {
  const policy = currentRunPolicy();
  return !policy || policy.activeToolIds.includes('ask_user_clarification');
}

/** Single emission point for the next action after a missing engineering input. */
export function nextActionForMissingInput(): MissingInputNextAction {
  return missingInputNextAction(clarificationAvailable());
}

/** Get the AgentConfigurable from the LangGraph run config. */
export function getConfigurable(config: LangGraphRunnableConfig): AgentConfigurable & { agentState?: AgentState } {
  return config.configurable as AgentConfigurable & { agentState?: AgentState };
}

/** Skills a tool may resolve: the host's derived ToolContext, else a direct host's injected scope. */
export function toolSkillScope(config: LangGraphRunnableConfig): string[] | undefined {
  const configurable = getConfigurable(config) as AgentConfigurable & LegacyToolConfigurable;
  return configurable.toolContext ? configurable.toolContext.skillScope : configurable.skillScope;
}

/** Get the tool call ID from the LangChain config. */
export function getToolCallId(config: LangGraphRunnableConfig): string {
  const id = (config as any).toolCall?.id;
  if (!id) throw new Error('Tool call ID not available in config');
  return id;
}

/**
 * Create a Command that updates graph state channels AND adds a ToolMessage.
 * This is the recommended LangGraph pattern for tools that produce artifacts.
 */
export function toolResult(
  toolCallId: string,
  toolName: string,
  content: string,
  stateUpdate?: Partial<AgentState>,
  llmUsage?: LlmTokenUsage,
): Command {
  return new Command({
    update: {
      ...(stateUpdate || {}),
      messages: [new ToolMessage({
        content,
        tool_call_id: toolCallId,
        name: toolName,
        ...(llmUsage
          ? {
              response_metadata: {
                tokenUsage: {
                  promptTokens: llmUsage.inputTokens,
                  completionTokens: llmUsage.outputTokens,
                  totalTokens: llmUsage.totalTokens,
                },
                tokenUsageSource: 'nested-model-call',
              },
            }
          : {}),
      })],
    },
  });
}

export function nestedLlmUsageCollector(): {
  onUsage: ((usage: LlmTokenUsage) => void) | undefined;
  total: () => LlmTokenUsage | undefined;
} {
  const usages: LlmTokenUsage[] = [];
  return {
    onUsage: (usage) => usages.push(usage),
    total: () => mergeLlmTokenUsage(usages),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function countRecordEntries(value: unknown): number | undefined {
  return isRecord(value) ? Object.keys(value).length : undefined;
}

export function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

export function pickNumberLike(record: Record<string, unknown>, key: string): number | string | null | undefined {
  const value = record[key];
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

export function pickStringLike(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) return null;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function omitEmptyRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
