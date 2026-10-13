import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Command, isCommand, messagesStateReducer, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentState } from './state.js';
import { invalidateAnalysis } from '../engineering/model-state.js';

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

/** One call per graph node invocation: the resulting checkpoint survives a later interrupt. */
export async function executeToolsSequentially(tools: StructuredToolInterface[], state: AgentState, config: LangGraphRunnableConfig) {
  const call = pendingToolCalls(state)[0];
  if (!call) return new Command({ update: {} });
  if (!call.id) throw new Error('TOOL_CALL_ID_REQUIRED');
  const update: Record<string, unknown> = { messages: [] };
  let current = state;
  if (['run_analysis', 'build_model', 'extract_draft_params'].includes(call.name)) {
    const invalidation = invalidateAnalysis(current);
    const analysisRuns = { ...current.analysisRuns, ...invalidation.analysisRuns };
    current = { ...current, ...invalidation, analysisRuns };
    Object.assign(update, invalidation, { analysisRuns });
    config.writer?.({ type: 'artifact_payload_sync', artifact: 'analysis', invalidated: true });
    config.writer?.({ type: 'artifact_payload_sync', artifact: 'report', invalidated: true });
  }
  const invocationConfig = { ...config, configurable: { ...config.configurable, agentState: current,
    onAnalysisRequest: (reservation: Partial<AgentState>) => {
      current = { ...current, ...reservation, analysisRuns: { ...current.analysisRuns, ...reservation.analysisRuns } };
      Object.assign(update, reservation, { analysisRuns: current.analysisRuns });
      invocationConfig.configurable.agentState = current;
    },
  } };
  const node = new ToolNode(tools);
  const output = await node.invoke({ ...current, messages: [new AIMessage({ content: '', tool_calls: [call] })] }, invocationConfig);
  for (const item of Array.isArray(output) ? output : [output]) {
    const changes = (isCommand(item) ? item.update : item) as Partial<AgentState>;
    if (isCommand(item) && item.graph) throw new Error('CROSS_GRAPH_TOOL_COMMAND_UNSUPPORTED');
    const messages = changes.messages ?? [];
    const artifacts = { ...current.artifacts, ...changes.artifacts };
    const analysisRuns = { ...current.analysisRuns, ...changes.analysisRuns };
    current = { ...current, ...changes, artifacts, analysisRuns, messages: messagesStateReducer(current.messages, messages) };
    Object.assign(update, changes, { artifacts, analysisRuns, messages: [...update.messages as BaseMessage[], ...messages] });
  }
  const messages = update.messages as BaseMessage[];
  if (!messages.some(item => item.getType() === 'tool' && (item as ToolMessage).tool_call_id === call.id)) {
    messages.push(new ToolMessage({ content: JSON.stringify({ status: 'completed' }), name: call.name, tool_call_id: call.id }));
  }
  return new Command({ update });
}
