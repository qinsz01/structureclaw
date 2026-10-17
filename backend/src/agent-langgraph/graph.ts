/**
 * LangGraph StateGraph for the StructureClaw ReAct agent.
 *
 * Graph structure:
 *   START → agent (LLM reasoning) → [has tool_calls?]
 *     → Yes  → tools (one call, checkpoint) → tools until complete → agent
 *     → No   → END (final response)
 *
 * Dependency injection: services are passed via config.configurable
 * (AgentConfigurable) so tools and nodes never read globalThis.
 *
 * Artifact-writing tools return Command({ update }) objects to write
 * directly into graph state channels — no intermediary node needed.
 */
import {
  StateGraph,
  START,
  END,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { executeToolsSequentially, pendingToolCalls } from './sequential-tools.js';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { createChatModel, getReasoningContentLength } from '../utils/llm.js';
import {
  AgentStateAnnotation,
  type AgentState,
} from './state.js';
import { createRegisteredTools, type AgentToolFactoryDeps, type AgentToolDefinition } from './tool-registry.js';
import { loadUserTools } from './user-tool-loader.js';
import { getWorkspaceToolRoot } from './config.js';
import { buildSystemMessages } from './system-prompt.js';
import type { SkillManifest } from '../shared/types/agent.js';
import type { AgentConfigurable } from './configurable.js';
import { deriveToolContext, type LegacyToolConfigurable, type ToolContext } from './tool-context.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { getLogger } from '../utils/agent-logger.js';
import { compactMessagesForContext, estimateMessagesCharLength } from './context-window.js';
import { repairToolMessageProtocol } from './message-protocol.js';
import { withRunContext, snapshotRunUsage } from '../runtime/run-context.js';
import { compactCodeCheckFeedback } from '../engineering/code-checks.js';
import { extractMessageText, getMessageType, getToolName } from './message-inspect.js';
import { applyFinalAnswerPolicy } from './delivery/final-answer.js';
import { DEFAULT_MAX_TOOL_CALLS_PER_TURN } from '../runtime/limits.js';

export { buildEmptyFinalResponseFallback, shouldReplaceEmptyFinalResponse } from './delivery/final-answer.js';

function getAgentLogger(config: LangGraphRunnableConfig) {
  return getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
}

/** Tool context for a graph node: derived from the turn's frozen policy and the node state. */
export function toolContextForNode(state: AgentState, configurable: Partial<AgentConfigurable> & LegacyToolConfigurable): ToolContext {
  return deriveToolContext(state, configurable.runContext?.policy, {
    allowShell: configurable.allowShell ?? false,
    fileAccessAllowlist: configurable.fileAccessAllowlist,
    // Only consulted without a run policy (direct hosts and pre-policy checkpoints).
    enabledToolIds: configurable.enabledToolIds,
    disabledToolIds: configurable.disabledToolIds,
    maxToolCallsPerTurn: configurable.maxToolCallsPerTurn,
  });
}

// ---------------------------------------------------------------------------
// Max ReAct iterations guard
// ---------------------------------------------------------------------------

export { DEFAULT_MAX_TOOL_CALLS_PER_TURN };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function buildAiMessageFields(content: unknown, name: unknown, source: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    content: typeof content === 'string' ? content : content as any[],
  };
  if (typeof name === 'string' && name.trim().length > 0) fields.name = name;

  const additionalKwargs = asRecord(source.additional_kwargs);
  if (additionalKwargs) fields.additional_kwargs = additionalKwargs;

  const responseMetadata = asRecord(source.response_metadata);
  if (responseMetadata) fields.response_metadata = responseMetadata;

  if (typeof source.id === 'string' && source.id.trim().length > 0) fields.id = source.id;
  if (source.usage_metadata !== undefined) fields.usage_metadata = source.usage_metadata;
  const additionalToolCalls = Array.isArray(additionalKwargs?.tool_calls)
    ? additionalKwargs.tool_calls
    : undefined;
  if (Array.isArray(source.tool_calls) && source.tool_calls.length > 0) fields.tool_calls = source.tool_calls;
  else if (additionalToolCalls && additionalToolCalls.length > 0) fields.tool_calls = additionalToolCalls;
  else if (Array.isArray(source.tool_calls)) fields.tool_calls = source.tool_calls;
  else if (additionalToolCalls) fields.tool_calls = additionalToolCalls;
  if (Array.isArray(source.invalid_tool_calls)) fields.invalid_tool_calls = source.invalid_tool_calls;

  return fields;
}

function hasRestorableAiMetadata(source: Record<string, unknown>): boolean {
  const additionalKwargs = asRecord(source.additional_kwargs);
  return (
    (Array.isArray(source.tool_calls) && source.tool_calls.length > 0)
    || (Array.isArray(additionalKwargs?.tool_calls) && additionalKwargs.tool_calls.length > 0)
    || (additionalKwargs !== undefined && 'reasoning_content' in additionalKwargs)
  );
}

// ---------------------------------------------------------------------------
// Multimodal: strip image binaries from ToolMessages before the main agent LLM.
// Images are summarized by the independent vision model before reaching the main agent.
// ---------------------------------------------------------------------------

const IMAGE_JSON_REGEX = /"type"\s*:\s*"image"/;

export function projectToolMessagesForContext(messages: BaseMessage[]): BaseMessage[] {
  const result: BaseMessage[] = [];
  for (const message of messages) {
    if (getMessageType(message) !== 'tool') {
      result.push(message);
      continue;
    }
    const content = typeof message.content === 'string' ? message.content : '';
    if (getToolName(message) === 'run_code_check') {
      try {
        const parsed = JSON.parse(content);
        if (asRecord(parsed)) {
          const projected = JSON.stringify(compactCodeCheckFeedback(parsed));
          if (projected.length < content.length) {
            result.push(new ToolMessage({ ...message, content: projected, tool_call_id: (message as ToolMessage).tool_call_id }));
            continue;
          }
        }
      } catch { /* Unstructured errors are preserved verbatim. */ }
    }
    if (!content || !IMAGE_JSON_REGEX.test(content)) {
      result.push(message);
      continue;
    }
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(content); } catch { result.push(message); continue; }
    if (parsed.type !== 'image' || typeof parsed.base64DataUri !== 'string') {
      result.push(message);
      continue;
    }

    const rest = { ...parsed };
    delete rest.base64DataUri;
    const sanitizedContent = JSON.stringify({
      ...rest,
      note: 'Image binary omitted from main agent context. Use the existing attachment vision summary, or ask for missing details if no summary is available.',
    });
    result.push(new ToolMessage({
      content: sanitizedContent,
      tool_call_id: (message as any).tool_call_id || '',
      name: (message as any).name,
    }));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Node: agent (LLM reasoning)
// ---------------------------------------------------------------------------

function createCallModelNode(
  skillManifests: SkillManifest[],
  tools: ReturnType<typeof createRegisteredTools>,
) {
  return async function callModel(
    state: AgentState,
    config: LangGraphRunnableConfig,
  ): Promise<Partial<AgentState>> {
    const log = getAgentLogger(config);
    const configurable = config.configurable as (Partial<AgentConfigurable> & LegacyToolConfigurable) | undefined;
    // Receive long reasoning responses incrementally; the provider adapter aggregates
    // complete, typed assistant/tool-call messages before any tool can execute.
    const model = createChatModel(0, { streaming: true });
    if (!model) {
      return {
        messages: [
          new AIMessage(
            state.locale === 'zh'
              ? 'LLM 未配置，无法处理请求。请检查 LLM_API_KEY 设置。'
              : 'LLM is not configured. Please check LLM_API_KEY settings.',
          ),
        ],
      };
    }

    const skillRuntime = configurable?.skillRuntime;
    if (!skillRuntime) {
      return {
        messages: [
          new AIMessage(
            state.locale === 'zh'
              ? '技能运行时未配置。'
              : 'Skill runtime is not configured.',
          ),
        ],
      };
    }

    const toolContext = toolContextForNode(state, configurable);
    const activeTools = selectActiveTools(tools, toolContext);
    const modelWithTools = model.bindTools(activeTools);

    // Build system prompt
    const systemMessages = buildSystemMessages({ state, skillManifests, maxToolCallsPerTurn: toolContext.maxToolCallsPerTurn,
      activeToolIds: activeTools.map(tool => tool.name) });

    // Validate and reconstruct messages — checkpoint deserialization may
    // strip class methods (_getType), leaving plain objects that the LLM API
    // rejects with "role information cannot be empty". Rebuild them here.
    const rawMsgs: BaseMessage[] = Array.isArray(state.messages) ? state.messages : [];
    const msgs: BaseMessage[] = rawMsgs.map((m): BaseMessage | null => {
      if (m == null || typeof m !== 'object') return null;
      // Check if already a proper class instance with a usable role.
      // ChatMessageChunk / ChatMessage with _getType "generic" and missing
      // role must be reconstructed — the LLM provider rejects them.
      if (typeof (m as any)._getType === 'function') {
        const t = (m as any)._getType();
        if (t === 'generic') {
          // ChatMessage(ChatChunk) — treat as AI if role is missing/assistant
          const role = (m as any).role;
          if (role === 'assistant' || !role) {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
            if (!content && !hasRestorableAiMetadata(m as unknown as Record<string, unknown>)) return null;
            return new AIMessage(buildAiMessageFields(content, (m as any).name, m as unknown as Record<string, unknown>) as any);
          }
        }
        // AIMessageChunk is not a proper AIMessage — convert it so the LLM
        // provider receives a message with a well-defined role.  Chunk
        // instances have undefined .role which causes "角色信息不能为空"
        // errors on some providers (e.g. GLM).
        if (t === 'ai' && !(m instanceof AIMessage)) {
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
          // Skip empty AIMessageChunks — they are streaming artifacts
          // (e.g. the final empty chunk after tool calls) with no value.
          if (!content && !hasRestorableAiMetadata(m as unknown as Record<string, unknown>)) return null;
          return new AIMessage(buildAiMessageFields(content, (m as any).name, m as unknown as Record<string, unknown>) as any);
        }
        return m;
      }
      // Normalize: LangChain serde uses {lc:1, type:"constructor", id:[...], kwargs:{...}}
      const raw = m as unknown as Record<string, unknown>;
      const isLcFormat = raw.lc === 1 && raw.type === 'constructor';
      const plain = isLcFormat ? (raw.kwargs as Record<string, unknown>) ?? {} : raw;
      const lcId = Array.isArray(raw.id) ? (raw.id as string[]).join('/') : '';
      const id = lcId || (plain.id as string) || '';
      const content = plain.content ?? '';
      const name = plain.name as string | undefined;
      if (id.includes('HumanMessage') || plain.role === 'user' || plain.type === 'human') {
        return typeof content === 'string' ? new HumanMessage({ content, name }) : new HumanMessage({ content: content as any[], name });
      }
      if (id.includes('AIMessage') || plain.role === 'assistant' || plain.type === 'ai') {
        return new AIMessage(buildAiMessageFields(content, name, plain) as any);
      }
      if (id.includes('SystemMessage') || plain.role === 'system' || plain.type === 'system') {
        return new SystemMessage(typeof content === 'string' ? content : JSON.stringify(content));
      }
      if (id.includes('ToolMessage') || plain.role === 'tool' || plain.type === 'tool') {
        return new ToolMessage({
          content: typeof content === 'string' ? content : JSON.stringify(content),
          tool_call_id: (plain.tool_call_id as string) || (plain.id as string) || '',
          name,
        });
      }
      // Unknown — skip
      return null;
    }).filter((m): m is BaseMessage => m !== null);

    // Count prior tool calls in this turn to enforce max iterations.
    // Use the original message array so image-binary stripping does not
    // shift the turn boundary or under-count tool calls.
    let lastHumanIndex = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (typeof m === 'object' && m !== null && '_getType' in m && (m as any)._getType?.() === 'human') {
        lastHumanIndex = i;
        break;
      }
    }
    const currentTurnMessages = lastHumanIndex === -1 ? msgs : msgs.slice(lastHumanIndex + 1);
    const toolCallCount = currentTurnMessages.reduce((count, m) => {
      if (
        m != null
        && typeof m === 'object'
        && 'tool_calls' in m
        && Array.isArray((m as any).tool_calls)
      ) {
        return count + (m as any).tool_calls.length;
      }
      return count;
    }, 0);

    const maxToolCalls = toolContext.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;
    if (Math.max(toolCallCount, configurable?.runContext?.usage.toolCalls ?? 0) >= maxToolCalls) {
      log.warn({ node: 'agent', toolCallCount, max: maxToolCalls }, 'max tool call limit reached');
      const warning = state.locale === 'zh'
        ? '已达到本轮最大工具调用次数限制。我将根据已有信息给出回复。'
        : 'Reached the maximum tool call limit for this turn. I will respond with the information gathered so far.';
      return { messages: [new AIMessage(warning)] };
    }

    // Inject current state into configurable so tools can read state channels.
    // Tools access it via config.configurable.agentState.
    // IMPORTANT: mutate config.configurable in-place so the ToolNode (which
    // receives the same config object) also sees agentState.
    const configurableAny = config.configurable as Record<string, unknown>;
    configurableAny.agentState = state;

    // Remove base64 image data from ToolMessages before the main agent LLM.
    // Applied after turn-boundary computation so binary payload stripping
    // does not affect tool-call counting or compaction turn detection.
    const visibleMessages = state.runPolicy?.context.history === 'current-turn' && lastHumanIndex >= 0 ? msgs.slice(lastHumanIndex) : msgs;
    const effectiveMsgs = projectToolMessagesForContext(visibleMessages);

    const compaction = compactMessagesForContext({
      messages: effectiveMsgs,
      locale: state.locale,
      baseCharCount: estimateMessagesCharLength(systemMessages),
    });
    if (compaction.compacted) {
      log.warn({
        node: 'agent',
        originalCharCount: compaction.originalCharCount,
        compactedCharCount: compaction.compactedCharCount,
        compactedMessageCount: compaction.compactedMessageCount,
      }, 'agent context compacted before LLM invocation');
    }

    const protocol = repairToolMessageProtocol(compaction.messages);
    if (protocol.repairedCount > 0) {
      log.warn({
        node: 'agent',
        repairedMessageCount: protocol.repairedCount,
      }, 'agent repaired tool-message protocol before LLM invocation');
    }
    const allMessages = [...systemMessages, ...protocol.messages];

    log.info({ node: 'agent', messageCount: allMessages.length, activeToolCount: activeTools.length, toolCallCount, compacted: compaction.compacted }, 'agent node invoking LLM');
    const llmStart = Date.now();
    const response = await modelWithTools.invoke(allMessages, config);
    const llmDuration = Date.now() - llmStart;

    const hasToolCalls = 'tool_calls' in response && Array.isArray((response as any).tool_calls) && (response as any).tool_calls.length > 0;
    const responseMetadata = (response as { response_metadata?: Record<string, unknown> }).response_metadata;
    const rawFinishReason = responseMetadata?.finish_reason ?? responseMetadata?.stop_reason;
    const finishReason = typeof rawFinishReason === 'string' ? rawFinishReason : undefined;
    log.info({
      node: 'agent',
      durationMs: llmDuration,
      hasToolCalls,
      finishReason,
      contentLength: extractMessageText(response).length,
      reasoningContentLength: getReasoningContentLength(response),
    }, 'agent node LLM response received');

    return { messages: [applyFinalAnswerPolicy({ response, hasToolCalls, currentTurnMessages, state, log })] };
  };
}

// ---------------------------------------------------------------------------
// Conditional edge: should we continue or end?
// ---------------------------------------------------------------------------

export function shouldContinue(
  state: AgentState,
): 'tools' | typeof END {
  const msgs = Array.isArray(state.messages) ? state.messages : [];
  const lastMessage = msgs[msgs.length - 1];
  const hasToolCalls = (
    lastMessage != null &&
    'tool_calls' in lastMessage &&
    Array.isArray((lastMessage as any).tool_calls) &&
    (lastMessage as any).tool_calls.length > 0
  );
  return hasToolCalls ? 'tools' : END;
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

export interface GraphDeps extends AgentToolFactoryDeps {
  skillManifests: SkillManifest[];
  checkpointer?: BaseCheckpointSaver;
}

function selectActiveTools(tools: StructuredToolInterface[], toolContext: ToolContext): StructuredToolInterface[] {
  const activeIds = new Set(toolContext.activeToolIds);
  return tools.filter((toolDefinition) => activeIds.has(toolDefinition.name));
}

export async function buildAgentGraph(deps: GraphDeps) {
  const { skillManifests, checkpointer } = deps;

  // Load user-defined tools from workspace
  let userToolDefinitions: AgentToolDefinition[] = [];
  try {
    const workspaceToolRoot = getWorkspaceToolRoot();
    const result = await loadUserTools(workspaceToolRoot);
    userToolDefinitions = result.tools;
    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        console.warn(`[user-tools] Failed to load tool from ${failure.toolDir}: ${failure.reason} ${failure.detail ?? ''}`);
      }
    }
  } catch (err) {
    console.warn(`[user-tools] Failed to scan workspace tools: ${err instanceof Error ? err.message : err}`);
  }

  // Create tools ONCE — shared between ToolNode and callModel
  const tools = createRegisteredTools({ skillRuntime: deps.skillRuntime, workspaceRoot: deps.workspaceRoot }, userToolDefinitions);
  const invokeModel = createCallModelNode(skillManifests, tools);
  const callModel = async (state: AgentState, config: LangGraphRunnableConfig) => {
    const runtime = (config.configurable as Partial<AgentConfigurable>)?.runContext;
    return withRunContext(runtime, async () => ({ ...await invokeModel(state, config),
      ...(runtime ? { runUsage: snapshotRunUsage(runtime) } : {}) }));
  };

  const log = getLogger(undefined);
  log.info({ toolCount: tools.length, hasCheckpointer: !!checkpointer }, 'building agent graph');

  // Wrap ToolNode so that the current graph state is injected into
  // config.configurable.agentState before each tool runs.  LangGraph
  // does not propagate config mutations across nodes, so the injection
  // done in callModel is invisible to the raw ToolNode.
  const toolsNode = async (state: AgentState, config: LangGraphRunnableConfig) => {
    const nodeLog = getAgentLogger(config);
    const configurable = config.configurable as Partial<AgentConfigurable> & LegacyToolConfigurable;
    const toolContext = toolContextForNode(state, configurable);
    const activeTools = selectActiveTools(tools, toolContext);
    nodeLog.debug({ node: 'tools', activeToolCount: activeTools.length }, 'tools node executing');
    // A fresh config per node: the shared configurable is never mutated with policy.
    const nodeConfig = { ...config, configurable: { ...config.configurable, agentState: state, toolContext } };
    return withRunContext(configurable.runContext, () => executeToolsSequentially(activeTools, state, nodeConfig));
  };

  const workflow = new StateGraph(AgentStateAnnotation)
    .addNode('agent', callModel)
    .addNode('tools', toolsNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue, ['tools', END])
    .addConditionalEdges('tools', state => pendingToolCalls(state).length ? 'tools' : 'agent', ['tools', 'agent']);

  return workflow.compile({ checkpointer });
}
