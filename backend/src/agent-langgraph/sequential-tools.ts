import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Command, isCommand, messagesStateReducer, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentState } from './state.js';
import { reserveToolCall, recordToolOutcome, currentRunContext, snapshotRunUsage } from '../runtime/run-context.js';
import { toolMessageFailure } from '../utils/tool-outcome.js';
import { clarificationStateToken, guardLedger, preflightToolCall, recordToolResult } from './guards/tool-guards.js';
import { structuredToolError } from './guards/tool-errors.js';
import { assertNoTerminalSemanticFailure } from './guards/terminal-failures.js';
import { draftChangedFields } from '../agent-runtime/draft/changes.js';

/** Only messages after the current assistant request acknowledge its calls. */
export function pendingToolCalls(state: AgentState) {
  let index = state.messages.length - 1;
  while (index >= 0 && state.messages[index]!.getType() !== 'ai') index--;
  if (index < 0) return [];
  const message = state.messages[index] as AIMessage;
  const completed = new Set(state.messages.slice(index + 1).filter(item => item.getType() === 'tool')
    .map(item => (item as ToolMessage).tool_call_id));
  return (message.tool_calls ?? []).filter(call => !call.id || !completed.has(call.id));
}

function unexecuted(call: { name: string; id: string }, content: string) {
  const runtime = currentRunContext();
  return new Command({ update: { messages: [new ToolMessage({ name: call.name, tool_call_id: call.id, status: 'error', content })],
    ...(runtime ? { runUsage: snapshotRunUsage(runtime) } : {}) } });
}

/** Rewrites failed tool messages into the structured error shape (guards/tool-errors.ts). */
function structureFailures(messages: BaseMessage[], state: AgentState): BaseMessage[] {
  return messages.map((item) => {
    if (item.getType() !== 'tool') return item;
    const message = item as ToolMessage;
    const failure = toolMessageFailure(message);
    const content = typeof message.content === 'string' ? message.content : undefined;
    const structured = failure && content !== undefined ? structuredToolError(content, failure, state) : undefined;
    return structured ? new ToolMessage({ content: structured, name: message.name, tool_call_id: message.tool_call_id,
      status: message.status, artifact: message.artifact, id: message.id }) : item;
  });
}

/** One call per graph node invocation: the resulting checkpoint survives a later interrupt. */
export async function executeToolsSequentially(tools: StructuredToolInterface[], state: AgentState, config: LangGraphRunnableConfig) {
  assertNoTerminalSemanticFailure(state.messages, state.locale);
  const call = pendingToolCalls(state)[0];
  if (!call) return new Command({ update: {} });
  if (!call.id) throw new Error('TOOL_CALL_ID_REQUIRED');
  const callRef = { name: call.name, id: call.id };
  const runContext = currentRunContext();
  const ledger = guardLedger(runContext);
  // Guards run before the budget ledger: a guarded call is never executed and never reserved.
  const rejection = preflightToolCall({ call, toolNames: tools.map(item => item.name), messages: state.messages, ledger,
    repairEnabled: runContext?.policy.repair.enabled ?? true, stateToken: clarificationStateToken(state) });
  if (rejection) {
    if (rejection.kind === 'rejected') recordToolResult(ledger, call, toolMessageFailure({ content: rejection.content, status: 'error' }), false);
    return unexecuted(callRef, rejection.content);
  }
  let assistantIndex = state.messages.length - 1;
  while (assistantIndex >= 0 && state.messages[assistantIndex]!.getType() !== 'ai') assistantIndex--;
  const invocationId = `${assistantIndex}:${call.id}`;
  try {
    reserveToolCall(call.name, invocationId);
  } catch (error) {
    const content = JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) });
    recordToolResult(ledger, call, toolMessageFailure({ content, status: 'error' }), false);
    return unexecuted(callRef, content);
  }
  const update: Record<string, unknown> = { messages: [] };
  let current = state;
  let stateChanged = false;
  const touched = new Set<string>();
  // Tools invalidate only after accepting a draft/model change or reserving a
  // solver request. A schema/provider failure must preserve the committed state.
  const invocationConfig = { ...config, configurable: { ...config.configurable, agentState: current,
    onAnalysisRequest: (reservation: Partial<AgentState>) => {
      stateChanged = true;
      current = { ...current, ...reservation, analysisRuns: { ...current.analysisRuns, ...reservation.analysisRuns } };
      Object.assign(update, reservation, { analysisRuns: current.analysisRuns });
      invocationConfig.configurable.agentState = current;
      if (reservation.analysisResult === null) config.writer?.({ type: 'artifact_payload_sync', artifact: 'analysis', invalidated: true });
      if (reservation.report === null) config.writer?.({ type: 'artifact_payload_sync', artifact: 'report', invalidated: true });
    },
  } };
  const node = new ToolNode(tools);
  const output = await node.invoke({ ...current, messages: [new AIMessage({ content: '', tool_calls: [call] })] }, invocationConfig);
  for (const item of Array.isArray(output) ? output : [output]) {
    const changes = (isCommand(item) ? item.update : item) as Partial<AgentState>;
    if (isCommand(item) && item.graph) throw new Error('CROSS_GRAPH_TOOL_COMMAND_UNSUPPORTED');
    for (const key of Object.keys(changes)) if (key !== 'messages' && key !== 'runUsage') touched.add(key);
    const messages = changes.messages ?? [];
    const artifacts = { ...current.artifacts, ...changes.artifacts };
    const analysisRuns = { ...current.analysisRuns, ...changes.analysisRuns };
    current = { ...current, ...changes, artifacts, analysisRuns, messages: messagesStateReducer(current.messages, messages) };
    Object.assign(update, changes, { artifacts, analysisRuns, messages: [...update.messages as BaseMessage[], ...messages] });
  }
  const messages = structureFailures(update.messages as BaseMessage[], current);
  update.messages = messages;
  if (!messages.some(item => item.getType() === 'tool' && (item as ToolMessage).tool_call_id === call.id)) {
    messages.push(new ToolMessage({ content: JSON.stringify({ status: 'completed' }), name: call.name, tool_call_id: call.id }));
  }
  let failure: string | undefined;
  for (const item of messages) {
    if (item.getType() !== 'tool') continue;
    failure = toolMessageFailure(item as ToolMessage) ?? failure;
  }
  recordToolOutcome(call.name, invocationId, failure ? String(failure) : undefined);
  // Progress means a state value actually changed (an identical re-query rewrites the same value).
  const progressed = call.name === 'extract_draft_params'
    ? draftChangedFields(state.draftState ?? undefined, current.draftState ?? undefined).length > 0
    : stateChanged || [...touched].some(key => JSON.stringify(state[key as keyof AgentState]) !== JSON.stringify(current[key as keyof AgentState]));
  recordToolResult(ledger, call, failure, progressed);
  const runtime = currentRunContext();
  if (runtime) update.runUsage = snapshotRunUsage(runtime);
  return new Command({ update });
}
