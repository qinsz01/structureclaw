import path from 'node:path';
import type { AgentState } from '../state.js';
import { readRunUsage, type RunUsage } from '../../runtime/run-context.js';
import { runtimeBaseDir } from '../../config/index.js';
import type { ConversationRuntimeSnapshot } from '../../types/conversation-runtime.js';
import type { AnalysisExecutionService } from '../../services/analysis-execution.js';
import { normalizeClarificationOptions } from '../../utils/clarification-options.js';
import { supportedClarificationOptions } from '../../agent-runtime/template-properties.js';
import { pendingToolCalls } from '../sequential-tools.js';
import { contentHash, currentAnalysisError } from '../../engineering/model-state.js';
import { activeInputEvidence, assertInputEvidenceMatchesModel, unresolvedInputEvidence } from '../../engineering/input-evidence.js';
import { resultCatalogEntry } from '../../engineering/result-selection.js';
import { nativeDesignReview } from '../../engineering/native-design-options.js';
import { isRecord } from '../attachments/attachment-analysis.js';

export const INPUT_REVIEW_TOOLS = ['analyze_file', 'review_input', 'query_model', 'edit_model', 'validate_model'] as const;

export type InputReviewTool = typeof INPUT_REVIEW_TOOLS[number];

export const RESULT_REVIEW_TOOLS = ['query_results', 'generate_report', 'run_code_check'] as const;

export type ResultReviewTool = typeof RESULT_REVIEW_TOOLS[number];

export function clarificationState(state: AgentState, tasks: ReadonlyArray<{ interrupts?: readonly unknown[] }> = []) {
  const call = state.messages?.length ? pendingToolCalls(state)[0] : undefined;
  const waitingForReply = tasks.some(task => task.interrupts?.length) || call?.name === 'ask_user_clarification';
  const args = call?.name === 'ask_user_clarification' ? call.args : undefined;
  return { waitingForReply, question: typeof args?.question === 'string' ? args.question : null,
    options: supportedClarificationOptions(normalizeClarificationOptions(args?.options ?? args?.optionsJson), state.draftState) };
}

/** A revision covers evidence and excitation settings as well as the physical model. */
export function inputReviewRevision(state: Partial<AgentState>): string {
  return contentHash({ model: state.model, revision: state.modelRevision, pending: state.modelPending,
    evidence: state.inputEvidence, workflow: state.contextSeismicWorkflow, policy: state.runPolicy,
    usage: state.runUsage, analysisRequest: state.analysisRequest, currentRun: state.analysisResult?.runId,
    runs: Object.keys(state.analysisRuns ?? {}), quantities: state.resultQuantities, messages: state.messages?.map(message => message.id) });
}

/** Ownership comes only from this checkpoint and its existing ledger, never a global job scan. */
export function conversationJobReferences(state: AgentState, usage: RunUsage | null) {
  const references = new Map<string, { operation: string; runId?: string; inHistory: boolean }>();
  const runs = { ...(state.analysisRuns ?? {}) };
  if (typeof state.analysisResult?.runId === 'string') runs[state.analysisResult.runId] = state.analysisResult;
  for (const run of Object.values(runs)) {
    if (typeof run.requestId !== 'string' || typeof run.runId !== 'string') continue;
    const parameters = isRecord(run.meta) && isRecord(run.meta.requestParameters) ? run.meta.requestParameters : {};
    references.set(run.requestId, { operation: isRecord(parameters.design) && parameters.design.requested === true ? 'native-design' : 'analysis',
      runId: run.runId, inHistory: true });
  }
  for (const event of usage?.events ?? []) {
    if (event.kind !== 'analysis_request' || typeof event.requestId !== 'string') continue;
    references.set(event.requestId, { ...references.get(event.requestId), operation: String(event.operation),
      inHistory: references.get(event.requestId)?.inHistory ?? false });
  }
  return references;
}

/** Run-usage ledger of the checkpointed policy, read from the run-record store. */
export function sessionRunUsage(state: AgentState): RunUsage | null {
  const policy = state.runPolicy ?? null;
  return policy && state.runUsage ? readRunUsage(policy, state.runUsage, path.join(runtimeBaseDir, 'run-records')) : null;
}

/** Job receipts for every analysis/native-design request owned by this conversation. */
export function conversationJobSnapshots(
  execution: AnalysisExecutionService,
  state: AgentState,
  usage: RunUsage | null,
  allowed: string[],
): Promise<ConversationRuntimeSnapshot['jobs']> {
  return Promise.all([...conversationJobReferences(state, usage)].map(async ([requestId, reference]) => {
    let receipt: Record<string, unknown>;
    try { receipt = await execution.getRequest(requestId); } catch { receipt = { status: 'outcome_unknown' }; }
    const tool = reference.operation === 'analysis' ? 'run_analysis' : reference.operation === 'native-design' ? 'run_code_check' : null;
    const permitted = Boolean(tool && allowed.includes(tool));
    const matched = !reference.runId || reference.runId === receipt.runId;
    return { requestId, kind: reference.operation, status: String(receipt.status),
      runId: typeof receipt.runId === 'string' ? receipt.runId : null,
      stateHash: typeof receipt.stateHash === 'string' ? receipt.stateHash : undefined,
      ownerAlive: typeof receipt.ownerAlive === 'boolean' ? receipt.ownerAlive : null, inHistory: reference.inHistory,
      cancellationAvailable: matched && permitted && receipt.status === 'running' && receipt.cancellationAvailable === true,
      recoveryAvailable: matched && permitted && allowed.includes('query_results') && !reference.inHistory
        && typeof receipt.runId === 'string' && typeof receipt.stateHash === 'string'
        && (receipt.status === 'completed' || receipt.status === 'outcome_unknown' && receipt.ownerAlive === false) };
  }));
}

/** Session snapshot (draft, interaction and runtime projection) for a checkpointed conversation state. */
export function buildConversationSessionSnapshot(input: {
  conversationId: string;
  state: AgentState;
  clarification: ReturnType<typeof clarificationState>;
  usage: RunUsage | null;
  jobs: ConversationRuntimeSnapshot['jobs'];
  busy: boolean;
}): { snapshot: Record<string, unknown>; state: AgentState } {
  const { conversationId, state, clarification, usage, jobs } = input;
  const policy = state.runPolicy ?? null;
  const reason = currentAnalysisError(state);
  const runId = typeof state.analysisResult?.runId === 'string' ? state.analysisResult.runId : null;
  const reportMeta = isRecord(state.report?.meta) ? state.report.meta : isRecord(state.report?.json) && isRecord(state.report.json.meta) ? state.report.json.meta : {};
  const reportCurrent = Boolean(state.report && !reason && runId && reportMeta.runId === runId);
  const runtime: ConversationRuntimeSnapshot = { conversationId, busy: input.busy, ...clarification,
    modelRevision: state.modelRevision ?? 0, modelPending: state.modelPending ?? false, policy,
    usage: usage ? { runId: usage.runId, policyHash: usage.policyHash, toolCalls: usage.toolCalls,
      llmCalls: usage.llmCalls, recoveries: usage.recoveries } : null,
    analysis: { runId, resultKey: typeof state.analysisResult?.selectedResultKey === 'string' ? state.analysisResult.selectedResultKey : null,
      current: !reason, reason: reason ?? null }, report: { current: reportCurrent, runId: reportCurrent ? runId : null }, jobs };

  return {
    snapshot: {
      draft: state.draftState || null,
      requestScope: state.requestScope ?? null,
      interaction: {
        state: clarification.waitingForReply ? 'waiting' : 'ready',
        stage: 'model',
        turnId: conversationId,
      },
      runtime,
      model: state.model ?? undefined,
      modelRevision: state.modelRevision ?? 0,
      modelPending: state.modelPending ?? false,
      updatedAt: new Date().toISOString(),
    },
    state,
  };
}

/** Input-review projection of the chat state; `allowed` is the session's active tool list. */
export function buildInputReview(
  conversationId: string,
  state: AgentState,
  tasks: ReadonlyArray<{ interrupts?: readonly unknown[] }>,
  allowed: string[],
) {
  const inputIssues = unresolvedInputEvidence(state.inputEvidence);
  if (state.model && !inputIssues.length) {
    try { assertInputEvidenceMatchesModel(state.model, state.inputEvidence); }
    catch (error) { inputIssues.push({ field: 'model', reason: error instanceof Error ? error.message : String(error) }); }
  }
  return { conversationId, revisionToken: inputReviewRevision(state), model: state.model ?? null,
    modelRevision: state.modelRevision ?? 0, modelPending: state.modelPending ?? false,
    inputEvidence: state.inputEvidence ?? [], activeEvidenceIds: activeInputEvidence(state.inputEvidence).map(item => item.id),
    inputIssues,
    groundMotionRecords: isRecord(state.contextSeismicWorkflow?.groundMotionSet)
      ? state.contextSeismicWorkflow.groundMotionSet.records ?? [] : [],
    allowedTools: INPUT_REVIEW_TOOLS.filter(id => allowed.includes(id)),
    runUsage: state.runUsage ?? null, waitingForReply: tasks.some(task => task.interrupts?.length)
      || Boolean(state.messages?.length && pendingToolCalls(state)[0]?.name === 'ask_user_clarification'),
    analysisCurrent: !currentAnalysisError(state), reportCurrent: Boolean(state.report),
  };
}

/** Result-review catalog; archived numerical data are queried through the permitted tool path. */
export function buildResultReview(conversationId: string, state: AgentState, allowed: string[], busy: boolean) {
  const policy = state.runPolicy;
  const runs = { ...(state.analysisRuns ?? {}) };
  if (typeof state.analysisResult?.runId === 'string') runs[state.analysisResult.runId] = state.analysisResult;
  return { conversationId, revisionToken: inputReviewRevision(state), busy,
    currentRunId: !currentAnalysisError(state) ? state.analysisResult?.runId ?? null : null,
    allowedTools: policy ? RESULT_REVIEW_TOOLS.filter(id => allowed.includes(id)) : [],
    nativeDesign: nativeDesignReview(state, policy ? allowed : []),
    runs: Object.values(runs).map(run => resultCatalogEntry(run,
      run.runId === state.analysisResult?.runId && !currentAnalysisError(state))) };
}
