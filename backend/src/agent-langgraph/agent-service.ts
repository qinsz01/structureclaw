import { resetClarificationGuards } from './guards/tool-guards.js';
/**
 * LangGraph-based AgentService — the sole agent implementation.
 *
 * Provides streaming, synchronous, and resumption entry points for the
 * LangGraph ReAct agent, plus conversation/session management methods.
 *
 * Dependency injection uses config.configurable (no globalThis).
 * The graph is built once and cached for the process lifetime.
 */
import { requestScopeInputSchema } from '../engineering/request-scope.js';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { randomUUID } from 'crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { AgentSkillRuntime } from '../agent-runtime/index.js';
import type { SkillManifest } from '../shared/types/agent.js';
import { buildAgentGraph } from './graph.js';
import { FileCheckpointer } from './file-checkpointer.js';
import { streamGraphToChunks, type StreamContext } from './streaming.js';
import type { AgentState } from './state.js';
import { getAllowShellTools, getCheckpointerDataDir, getWorkspaceRoot, getWorkspaceSkillRoot } from './config.js';
import { config, runtimeBaseDir } from '../config/index.js';
import { resolveApplicationRunPolicy, skillCatalog } from './policy-resolver.js';
import { createRunContext, resetClarificationRecovery, withRunContext, snapshotRunUsage, readRunUsage, recordRunEvent, type RunContext, type RunUsage } from '../runtime/run-context.js';
import type { ConversationRuntimeSnapshot } from '../types/conversation-runtime.js';
import type { AgentStreamChunk } from '../types/agent-stream.js';
import type { AppLocale } from '../shared/locale.js';
import { AnalysisExecutionService, createLocalAnalysisEngineClient } from '../services/analysis-execution.js';
import { createLocalCodeCheckClient } from '../services/code-check-execution.js';
import { createLocalStructureProtocolClient } from '../skill-shared/structure-protocol-execution.js';
import { prisma } from '../utils/database.js';
import { Command } from '@langchain/langgraph';
import { logger } from '../utils/logger.js';
import { createAgentLogger } from '../utils/agent-logger.js';
import type { AgentConfigurable } from './configurable.js';
import { createRegisteredTools, listAgentToolDefinitions } from './tool-registry.js';
import { executeToolsSequentially, pendingToolCalls } from './sequential-tools.js';
import { deriveToolContext } from './tool-context.js';
import { isPathWithinRoot, resolveUploadPath } from './file-tools.js';
import { summarizeFileImages } from './attachment-vision.js';
import { collectVisionEvidence } from '../engineering/vision-evidence.js';
import { SessionLock } from '../engineering/session-lock.js';
import { applyInputEvidence, commitModel, invalidateStaleResults, staleResultsKept } from '../engineering/model-state.js';
import { nativeDesignReview } from '../engineering/native-design-options.js';
import { normalizeEngineeringModel } from '../engineering/model-boundary.js';
import { conversationSectionEvidence } from './tools/input-message.js';
import { isRecord } from './attachments/attachment-analysis.js';
import { extractContextSeismicWorkflow } from './attachments/ground-motion.js';
import { toInitialHumanMessage, buildInitialHumanMessagePayload } from './attachments/initial-message.js';
import type { AttachmentInfo, LangGraphRunInput, LangGraphRunResult } from './service-types.js';
import { INPUT_REVIEW_TOOLS, type InputReviewTool, RESULT_REVIEW_TOOLS, type ResultReviewTool, clarificationState, inputReviewRevision, conversationJobReferences, sessionRunUsage, conversationJobSnapshots, buildConversationSessionSnapshot, buildInputReview, buildResultReview } from './session/snapshot.js';
import { getLangGraphRecursionLimit, buildToolAccessPolicy } from './turn-config.js';

let singleton: LangGraphAgentService | undefined;

export function getAgentService(): LangGraphAgentService {
  if (!singleton) {
    singleton = new LangGraphAgentService(new AgentSkillRuntime({
      workspaceSkillRoot: getWorkspaceSkillRoot(),
    }));
  }
  return singleton;
}

export class LangGraphAgentService {
  private readonly sessionLock = new SessionLock();
  private readonly resultQuerySnapshots = new Map<string, { state: AgentState; clarification: ReturnType<typeof clarificationState> }>();
  readonly skillRuntime: AgentSkillRuntime;
  private readonly checkpointer: FileCheckpointer;
  private readonly workspaceRoot: string;

  // Execution clients (created once, injected via config.configurable)
  private readonly engineClient: ReturnType<typeof createLocalAnalysisEngineClient>;
  private readonly codeCheckClient: ReturnType<typeof createLocalCodeCheckClient>;
  private readonly structureProtocolClient: ReturnType<typeof createLocalStructureProtocolClient>;

  // Cached graph — built once, reused across requests
  private graphPromise: Promise<Awaited<ReturnType<typeof buildAgentGraph>>> | undefined;

  constructor(skillRuntime: AgentSkillRuntime) {
    this.skillRuntime = skillRuntime;
    this.checkpointer = new FileCheckpointer(getCheckpointerDataDir());
    this.workspaceRoot = getWorkspaceRoot();

    // Create execution clients once (lifetime of the process)
    this.engineClient = createLocalAnalysisEngineClient();
    this.codeCheckClient = createLocalCodeCheckClient();
    this.structureProtocolClient = createLocalStructureProtocolClient();
  }

  // ---------------------------------------------------------------------------
  // Configurable builder (DI container for tools/nodes)
  // ---------------------------------------------------------------------------

  private buildConfigurable(input?: LangGraphRunInput, traceId?: string, conversationId?: string): AgentConfigurable & { _logger?: unknown } {
    const childLogger = (traceId && conversationId)
      ? createAgentLogger(traceId, conversationId)
      : undefined;
    return {
      skillRuntime: this.skillRuntime,
      engineClient: this.engineClient,
      codeCheckClient: this.codeCheckClient,
      structureProtocolClient: this.structureProtocolClient,
      workspaceRoot: this.workspaceRoot,
      fileAccessAllowlist: input?.context?.restrictFileAccessToAttachments
        ? (input.context.attachments || []).map((attachment) => attachment.relPath)
        : undefined,
      allowShell: getAllowShellTools(),
      summarizeFileImages: (analysis, filePath, signal) => summarizeFileImages(analysis, filePath, input?.context?.locale ?? 'zh', input?.message ?? '', signal),
      _logger: childLogger,
    };
  }

  private buildGraphRuntimeConfig(input?: LangGraphRunInput, traceId?: string, conversationId?: string, runContext?: RunContext) {
    return {
      recursionLimit: getLangGraphRecursionLimit(runContext?.policy.budgets.maxToolCallsPerTurn ?? config.agentMaxToolCallsPerTurn),
      signal: input?.signal,
      configurable: {
        thread_id: conversationId,
        ...this.buildConfigurable(input, traceId, conversationId),
        ...(runContext ? { runContext } : {}),
      },
    };
  }

  private async prepareRunContext(input: LangGraphRunInput, conversationId: string, resume = false, savedState?: AgentState): Promise<RunContext> {
    const graph = await this.getGraph();
    const saved = savedState ?? (await graph.getState({ configurable: { thread_id: conversationId } })).values as AgentState;
    const journalDir = path.join(runtimeBaseDir, 'run-records');
    if (resume && saved.runPolicy && saved.runUsage) {
      return createRunContext(saved.runPolicy, { runId: saved.runUsage.runId, usage: saved.runUsage, journalDir, resume: true });
    }
    const policy = resolveApplicationRunPolicy({ previous: saved.runPolicy ?? undefined, requested: input.context?.runPolicy,
      legacy: { skillIds: input.context?.skillIds ?? (!saved.runPolicy && saved.selectedSkillIds?.length ? saved.selectedSkillIds : undefined),
        enabledToolIds: input.context?.enabledToolIds, disabledToolIds: input.context?.disabledToolIds },
      ...skillCatalog(await this.skillRuntime.listSkillManifests()),
    });
    if (policy.routing.mode === 'fixed' && !await this.skillRuntime.resolvePluginForType(policy.routing.skillId, policy.activeSkillIds)) throw new Error('FIXED_SKILL_NOT_A_MODELING_PROVIDER');
    const runtime = createRunContext(policy, { journalDir });
    // An unfinished job outlives a chat turn. Keep its original request reference in
    // the existing ledger until it has entered analysis history; never allocate a new job.
    const previousUsage = saved.runPolicy && saved.runUsage ? readRunUsage(saved.runPolicy, saved.runUsage, journalDir) : null;
    const priorJobs = conversationJobReferences(saved, previousUsage);
    withRunContext(runtime, () => {
      for (const [requestId, reference] of priorJobs) {
        if (reference.inHistory) continue;
        const original = previousUsage?.events.find(event => event.kind === 'analysis_request' && event.requestId === requestId);
        recordRunEvent({ ...original, kind: 'analysis_request', requestId, operation: reference.operation,
          originRunId: original?.originRunId ?? previousUsage?.runId,
          originPolicyHash: original?.originPolicyHash ?? previousUsage?.policyHash });
      }
    });
    // Persist policy and ledger before attachment processing can call a model or interrupt.
    await graph.updateState({ configurable: { thread_id: conversationId } }, { runPolicy: policy, runUsage: snapshotRunUsage(runtime) });
    return runtime;
  }

  // ---------------------------------------------------------------------------
  // Conversation auto-creation
  // ---------------------------------------------------------------------------

  private async ensureConversationRecord(
    conversationId: string | undefined,
    message: string,
  ): Promise<string> {
    if (conversationId) return conversationId;

    const conversation = await prisma.conversation.create({
      data: {
        title: message.slice(0, 50),
        type: 'general',
      },
    });
    return conversation.id;
  }

  // ---------------------------------------------------------------------------
  // Graph construction (cached)
  // ---------------------------------------------------------------------------

  /** Get or build the compiled graph. Thread-safe for concurrent first calls. */
  private async getGraph(): Promise<Awaited<ReturnType<typeof buildAgentGraph>>> {
    if (!this.graphPromise) {
      this.graphPromise = (async () => {
        const skillManifests = await this.skillRuntime.listSkillManifests();
        return await buildAgentGraph({
          skillRuntime: this.skillRuntime,
          skillManifests,
          checkpointer: this.checkpointer,
        });
      })();
    }
    return this.graphPromise;
  }

  /** Force rebuild the graph (e.g. after skill install/uninstall). */
  resetGraph(): void {
    this.graphPromise = undefined;
  }

  private async contextModelUpdate(input: LangGraphRunInput, conversationId: string, evidence: Record<string, unknown>[] = []): Promise<Partial<AgentState>> {
    if (!input.context && !evidence.length) return {};
    const graph = await this.getGraph();
    const snapshot = await graph.getState({ configurable: { thread_id: conversationId } });
    const state = snapshot.values as AgentState;
    if (input.context?.modelRevision !== undefined && input.context.modelRevision !== (state.modelRevision ?? 0)) {
      throw new Error(`MODEL_VERSION_CONFLICT: expected ${state.modelRevision ?? 0}`);
    }
    const update: Partial<AgentState> = {};
    if (input.context?.requestScope) update.requestScope = requestScopeInputSchema.parse(input.context.requestScope);
    if (input.context?.model) {
      const model = await normalizeEngineeringModel(input.context.model, this.structureProtocolClient, input.context.modelFormat,
        conversationSectionEvidence({ ...state, lastUserMessage: input.message }));
      Object.assign(update, commitModel(state, model, 'import_model'));
    }
    if (input.context?.analysisType && input.context.analysisType !== state.policy?.analysisType
      || input.context?.skillIds && JSON.stringify([...input.context.skillIds].sort()) !== JSON.stringify([...(state.selectedSkillIds ?? [])].sort())) {
      Object.assign(update, invalidateStaleResults(state));
    } else if (input.context?.designCode && input.context.designCode !== state.policy?.designCode && !staleResultsKept(state)) {
      Object.assign(update, { codeCheckResult: null, report: null });
    }
    if (evidence.length) Object.assign(update, applyInputEvidence({ ...state, ...update }, evidence));
    return update;
  }

  // ---------------------------------------------------------------------------
  // Streaming entry point
  // ---------------------------------------------------------------------------

  private async assertTurnState(conversationId: string | undefined, resume: boolean): Promise<void> {
    if (!conversationId) return;
    const snapshot = await (await this.getGraph()).getState({ configurable: { thread_id: conversationId } });
    const waiting = clarificationState(snapshot.values as AgentState, snapshot.tasks).waitingForReply;
    if (resume && !waiting) throw new Error('CONVERSATION_NOT_WAITING_FOR_REPLY');
    if (!resume && waiting) throw new Error('CONVERSATION_WAITING_FOR_REPLY: resume the saved turn / 请继续已保存的回合');
  }

  async *runStream(input: LangGraphRunInput): AsyncGenerator<AgentStreamChunk> {
    const release = await this.sessionLock.acquire(input.conversationId ?? randomUUID());
    try { await this.assertTurnState(input.conversationId, false); yield* this.runStreamUnlocked(input); } finally { release(); }
  }

  private async *runStreamUnlocked(input: LangGraphRunInput): AsyncGenerator<AgentStreamChunk> {
    const locale = input.context?.locale || 'zh';
    const conversationId = await this.ensureConversationRecord(
      input.conversationId, input.message,
    );
    const traceId = input.traceId || randomUUID();
    const startedAt = new Date().toISOString();
    const reqStart = Date.now();

    const graph = await this.getGraph();

    const runtime = await this.prepareRunContext(input, conversationId);
    const config = this.buildGraphRuntimeConfig(input, traceId, conversationId, runtime);

    const reqLogger = createAgentLogger(traceId, conversationId);
    reqLogger.info({ message: input.message.slice(0, 100) }, 'LangGraph agent stream started');

    const initialPayload = await withRunContext(runtime, () => buildInitialHumanMessagePayload(
      input.message,
      input.context?.attachments,
      locale,
      this.workspaceRoot,
      { summarizeImages: true, signal: input.signal },
    ));
    const contextSeismicWorkflow = extractContextSeismicWorkflow(input.context, initialPayload.attachmentAnalyses);
    const initialUpdate = await this.contextModelUpdate(input, conversationId,
      initialPayload.attachmentAnalyses.flatMap(({ analysis }) => collectVisionEvidence(analysis)));
    if (initialUpdate.analysisResult === null) yield { type: 'artifact_payload_sync', artifact: 'analysis', invalidated: true };
    if (initialUpdate.report === null) yield { type: 'artifact_payload_sync', artifact: 'report', invalidated: true };
    const stream = await graph.stream(
      {
        ...initialUpdate,
        runPolicy: runtime.policy, runUsage: snapshotRunUsage(runtime),
        messages: [toInitialHumanMessage(initialPayload.content)],
        locale,
        workspaceRoot: this.workspaceRoot,
        selectedSkillIds: runtime.policy.activeSkillIds,
        toolAccessPolicy: buildToolAccessPolicy(input.context),
        lastUserMessage: initialPayload.canonicalMessage,
        contextSeismicWorkflow,
        policy: {
          analysisType: input.context?.analysisType,
          designCode: input.context?.designCode,
        },
      },
      { ...config, streamMode: ['messages', 'updates', 'custom'] as any },
    );

    const ctx: StreamContext = { conversationId, traceId, startedAt };
    try {
      yield* streamGraphToChunks(stream, ['messages', 'updates', 'custom'], ctx);
    } finally {
      reqLogger.info({ durationMs: Date.now() - reqStart, mode: 'stream' }, 'LangGraph agent stream completed');
    }
  }

  // ---------------------------------------------------------------------------
  // Resume after interrupt
  // ---------------------------------------------------------------------------

  async *resumeStream(
    conversationId: string,
    resumeValue: string,
    signal?: AbortSignal,
    attachments?: AttachmentInfo[],
  ): AsyncGenerator<AgentStreamChunk> {
    signal?.throwIfAborted();
    const release = await this.sessionLock.acquire(conversationId);
    try {
      signal?.throwIfAborted();
      await this.assertTurnState(conversationId, true);
      yield* this.resumeStreamUnlocked(conversationId, resumeValue, signal, attachments);
    } finally { release(); }
  }

  /** JSON entry point consumes the same checkpoint resumption as Web streaming. */
  async resume(conversationId: string, resumeValue: string, signal?: AbortSignal): Promise<LangGraphRunResult> {
    signal?.throwIfAborted();
    const release = await this.sessionLock.acquire(conversationId);
    try {
      signal?.throwIfAborted();
      await this.assertTurnState(conversationId, true);
      let start: StreamContext | undefined;
      for await (const chunk of this.resumeStreamUnlocked(conversationId, resumeValue, signal)) {
        if (chunk.type === 'start') start = chunk.content as StreamContext;
        if (chunk.type === 'error') throw new Error(chunk.error || 'AGENT_RESUME_FAILED');
      }
      if (!start) throw new Error('AGENT_RESUME_RESULT_MISSING');
      const snapshot = await (await this.getGraph()).getState({ configurable: { thread_id: conversationId } });
      const state = snapshot.values as AgentState;
      const result = this.extractResult(state, conversationId, start.traceId, start.startedAt);
      Object.assign(result, clarificationState(state, snapshot.tasks));
      result.runPolicy = state.runPolicy ?? undefined;
      result.runUsage = state.runPolicy && state.runUsage
        ? readRunUsage(state.runPolicy, state.runUsage, path.join(runtimeBaseDir, 'run-records')) : undefined;
      return result;
    } finally { release(); }
  }

  private async *resumeStreamUnlocked(conversationId: string, resumeValue: string, signal?: AbortSignal, attachments?: AttachmentInfo[]): AsyncGenerator<AgentStreamChunk> {
    const traceId = randomUUID();
    const startedAt = new Date().toISOString();
    const reqStart = Date.now();

    const graph = await this.getGraph();

    const resumedState = (await graph.getState({ configurable: { thread_id: conversationId } })).values as AgentState;
    const resumeInput = { conversationId, message: resumedState.lastUserMessage ?? '', signal, context: { locale: resumedState.locale ?? 'zh', attachments } };
    const runtime = await this.prepareRunContext(resumeInput, conversationId, true);
    resetClarificationRecovery(runtime);
    resetClarificationGuards(runtime);
    const config = this.buildGraphRuntimeConfig(resumeInput, traceId, conversationId, runtime);
    signal?.throwIfAborted();

    const reqLogger = createAgentLogger(traceId, conversationId);
    reqLogger.info('LangGraph agent resume started');

    const payload = await withRunContext(runtime, () => buildInitialHumanMessagePayload(
      resumeValue, attachments, resumedState.locale ?? 'zh', this.workspaceRoot, { summarizeImages: true, signal },
    ));
    const evidence = payload.attachmentAnalyses.flatMap(({ analysis }) => collectVisionEvidence(analysis));
    const update: Partial<AgentState> = attachments?.length ? {
      ...applyInputEvidence(resumedState, evidence),
      lastUserMessage: payload.canonicalMessage,
      contextSeismicWorkflow: extractContextSeismicWorkflow({ seismicWorkflow: resumedState.contextSeismicWorkflow ?? undefined }, payload.attachmentAnalyses),
      ...(resumedState.toolAccessPolicy?.fileAccessAllowlist ? {
        toolAccessPolicy: { ...resumedState.toolAccessPolicy,
          fileAccessAllowlist: [...new Set([...resumedState.toolAccessPolicy.fileAccessAllowlist, ...attachments.map(file => file.relPath)])] },
      } : {}),
    } : {};
    const stream = await graph.stream(
      new Command({ resume: payload.canonicalMessage, update }),
      { ...config, streamMode: ['messages', 'updates', 'custom'] as any },
    );

    const ctx: StreamContext = { conversationId, traceId, startedAt };
    try {
      yield* streamGraphToChunks(stream, ['messages', 'updates', 'custom'], ctx);
    } finally {
      reqLogger.info({ durationMs: Date.now() - reqStart, mode: 'resume' }, 'LangGraph agent resume completed');
    }
  }

  // ---------------------------------------------------------------------------
  // Synchronous entry point
  // ---------------------------------------------------------------------------

  async run(input: LangGraphRunInput): Promise<LangGraphRunResult> {
    const release = await this.sessionLock.acquire(input.conversationId ?? randomUUID());
    try { await this.assertTurnState(input.conversationId, false); return await this.runUnlocked(input); } finally { release(); }
  }

  private async runUnlocked(input: LangGraphRunInput): Promise<LangGraphRunResult> {
    const locale = input.context?.locale || 'zh';
    const conversationId = await this.ensureConversationRecord(
      input.conversationId, input.message,
    );
    const traceId = input.traceId || randomUUID();
    const startedAt = new Date().toISOString();
    const reqStart = Date.now();

    const graph = await this.getGraph();

    const runtime = await this.prepareRunContext(input, conversationId);
    const config = this.buildGraphRuntimeConfig(input, traceId, conversationId, runtime);

    const reqLogger = createAgentLogger(traceId, conversationId);
    reqLogger.info({ message: input.message.slice(0, 100) }, 'LangGraph agent run started');

    const initialPayload = await withRunContext(runtime, () => buildInitialHumanMessagePayload(
      input.message,
      input.context?.attachments,
      locale,
      this.workspaceRoot,
      { summarizeImages: true, signal: input.signal },
    ));
    const contextSeismicWorkflow = extractContextSeismicWorkflow(input.context, initialPayload.attachmentAnalyses);
    const result = await graph.invoke(
      {
        ...await this.contextModelUpdate(input, conversationId, initialPayload.attachmentAnalyses.flatMap(({ analysis }) => collectVisionEvidence(analysis))),
        runPolicy: runtime.policy, runUsage: snapshotRunUsage(runtime),
        messages: [toInitialHumanMessage(initialPayload.content)],
        locale,
        workspaceRoot: this.workspaceRoot,
        selectedSkillIds: runtime.policy.activeSkillIds,
        toolAccessPolicy: buildToolAccessPolicy(input.context),
        lastUserMessage: initialPayload.canonicalMessage,
        contextSeismicWorkflow,
        policy: {
          analysisType: input.context?.analysisType,
          designCode: input.context?.designCode,
        },
      },
      config,
    );

    const runResult = this.extractResult(result, conversationId, traceId, startedAt);
    runResult.runPolicy = runtime.policy;
    runResult.runUsage = snapshotRunUsage(runtime);
    reqLogger.info({ durationMs: Date.now() - reqStart, mode: runResult.mode, toolCallCount: runResult.toolCalls.length, success: runResult.success }, 'LangGraph agent run completed');
    return runResult;
  }

  /**
   * Run the agent and return the full final AgentState (not just the summary).
   * Used by integrations that need the full model, analysis and delivery state.
   */
  async runFull(input: LangGraphRunInput): Promise<AgentState> {
    const release = await this.sessionLock.acquire(input.conversationId ?? randomUUID());
    try { await this.assertTurnState(input.conversationId, false); return await this.runFullUnlocked(input); } finally { release(); }
  }

  private async runFullUnlocked(input: LangGraphRunInput): Promise<AgentState> {
    const locale = input.context?.locale || 'zh';
    const conversationId = input.conversationId || `run-${randomUUID()}`;
    const traceId = input.traceId || randomUUID();
    const reqStart = Date.now();
    const graph = await this.getGraph();
    const runtime = await this.prepareRunContext(input, conversationId);
    const config = this.buildGraphRuntimeConfig(input, traceId, conversationId, runtime);

    const reqLogger = createAgentLogger(traceId, conversationId);
    reqLogger.info({ message: input.message.slice(0, 100) }, 'LangGraph agent runFull started');

    const initialPayload = await withRunContext(runtime, () => buildInitialHumanMessagePayload(
      input.message,
      input.context?.attachments,
      locale,
      this.workspaceRoot,
      { summarizeImages: true, signal: input.signal },
    ));
    const contextSeismicWorkflow = extractContextSeismicWorkflow(input.context, initialPayload.attachmentAnalyses);
    const result = await graph.invoke(
      {
        ...await this.contextModelUpdate(input, conversationId, initialPayload.attachmentAnalyses.flatMap(({ analysis }) => collectVisionEvidence(analysis))),
        runPolicy: runtime.policy, runUsage: snapshotRunUsage(runtime),
        messages: [toInitialHumanMessage(initialPayload.content)],
        locale,
        workspaceRoot: this.workspaceRoot,
        selectedSkillIds: runtime.policy.activeSkillIds,
        toolAccessPolicy: buildToolAccessPolicy(input.context),
        lastUserMessage: initialPayload.canonicalMessage,
        contextSeismicWorkflow,
        policy: {
          analysisType: input.context?.analysisType,
          designCode: input.context?.designCode,
        },
      },
      config,
    ) as AgentState;

    reqLogger.info({ durationMs: Date.now() - reqStart, mode: 'full' }, 'LangGraph agent runFull completed');
    return result;
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  /** Explicit user action: close an idle clarification without running its pending tools. */
  async endWaitingTurn(conversationId: string, expectedRunId: string) {
    // acquire reserves synchronously; no await may separate this check from acquisition.
    if (this.sessionLock.isBusy(conversationId)) throw new Error('CONVERSATION_BUSY');
    const release = await this.sessionLock.acquire(conversationId);
    try {
      const graph = await this.getGraph();
      const graphConfig = { configurable: { thread_id: conversationId } };
      const snapshot = await graph.getState(graphConfig);
      const state = snapshot.values as AgentState;
      if (state.runUsage?.runId !== expectedRunId) throw new Error('CONVERSATION_TURN_CONFLICT');
      if (!clarificationState(state, snapshot.tasks).waitingForReply) throw new Error('CONVERSATION_NOT_WAITING_FOR_REPLY');
      const calls = pendingToolCalls(state);
      if (calls[0]?.name !== 'ask_user_clarification' || calls.some(call => !call.id)) throw new Error('CONVERSATION_WAITING_STATE_INVALID');
      // Verify the durable usage before changing the checkpoint, without rewriting the ledger.
      if (state.runPolicy && state.runUsage) readRunUsage(state.runPolicy, state.runUsage, path.join(runtimeBaseDir, 'run-records'));
      const traceId = randomUUID();
      const completedAt = new Date().toISOString();
      const response = state.locale === 'zh'
        ? '本轮已由你结束。待回复的问题及本批尚未执行的工具已取消；模型、历史结果和本轮用量记录均保留。你可以发送新消息开始下一轮。'
        : 'You ended this turn. The pending question and remaining tools in this batch were cancelled. The model, historical results and usage record are preserved. Send a new message to begin the next turn.';
      const cancelled = calls.map(call => new ToolMessage({ name: call.name, tool_call_id: call.id!, status: 'error',
        content: JSON.stringify({ success: false, status: 'cancelled', errorCode: 'TURN_ENDED_BY_USER',
          message: 'Cancelled by the user without execution / 用户结束本轮，未执行此工具' }) }));
      const ended = new AIMessage({ id: traceId, content: response, additional_kwargs: {
        turnEnd: { runId: expectedRunId, cancelledCallIds: calls.map(call => call.id), completedAt },
      } });
      await graph.updateState(graphConfig, { messages: [...cancelled, ended] }, 'agent');
      const updated = await graph.getState(graphConfig);
      if (updated.next.length || updated.tasks.some(task => task.interrupts?.length)) throw new Error('CONVERSATION_TURN_END_INCOMPLETE');
      const session = await this.getConversationSessionSnapshot(conversationId, state.locale);
      if (!session) throw new Error('CONVERSATION_STATE_UNAVAILABLE');
      return { traceId, completedAt, response,
        userMessage: state.locale === 'zh' ? '结束本轮' : 'End this turn',
        state: updated.values as AgentState,
        runtime: { ...session.snapshot.runtime as ConversationRuntimeSnapshot, busy: false },
      };
    } finally { release(); }
  }

  private async currentJobTools(state: AgentState): Promise<string[]> {
    if (!state.runPolicy) return [];
    // Recheck current server limits without changing the saved policy or its usage ledger.
    const policy = resolveApplicationRunPolicy({ previous: state.runPolicy,
      ...skillCatalog(await this.skillRuntime.listSkillManifests()) });
    return deriveToolContext(state, policy, { allowShell: false }).activeToolIds
      .filter(id => state.runPolicy!.activeToolIds.includes(id));
  }

  private async conversationJobs(state: AgentState, usage: RunUsage | null): Promise<ConversationRuntimeSnapshot['jobs']> {
    const execution = new AnalysisExecutionService();
    let allowed: string[] = [];
    try { allowed = await this.currentJobTools(state); } catch { /* Revoked/removed scope cannot authorize a job action. */ }
    return conversationJobSnapshots(execution, state, usage, allowed);
  }

  /** Cancellation deliberately bypasses the long-running chat lock; the service owns the controller. */
  async manageConversationJob(conversationId: string, input: {
    requestId: string; expectedStateHash: string; action: 'cancel' | 'recover';
  }) {
    if (!/^[a-f0-9]{64}$/.test(input.expectedStateHash)) throw new Error('ANALYSIS_REQUEST_STATE_HASH_INVALID');
    const release = input.action === 'recover' ? await this.sessionLock.acquire(conversationId) : undefined;
    try {
      const graph = await this.getGraph();
      const graphConfig = { configurable: { thread_id: conversationId } };
      const state = (await graph.getState(graphConfig)).values as AgentState;
      const usage = state.runPolicy && state.runUsage
        ? readRunUsage(state.runPolicy, state.runUsage, path.join(runtimeBaseDir, 'run-records')) : null;
      const reference = conversationJobReferences(state, usage).get(input.requestId);
      if (!reference) throw new Error('ANALYSIS_REQUEST_OUTSIDE_CONVERSATION');
      const allowed = await this.currentJobTools(state);
      const tool = reference.operation === 'analysis' ? 'run_analysis' : reference.operation === 'native-design' ? 'run_code_check' : null;
      if (!tool || !allowed.includes(tool) || input.action === 'recover' && !allowed.includes('query_results')) throw new Error('ANALYSIS_REQUEST_PERMISSION_DENIED');
      const execution = new AnalysisExecutionService();
      let receipt = await execution.getRequest(input.requestId);
      if (receipt.stateHash !== input.expectedStateHash) throw new Error('ANALYSIS_REQUEST_STATE_CHANGED');
      if (reference.runId && reference.runId !== receipt.runId) throw new Error('ANALYSIS_REQUEST_ARCHIVE_MISMATCH');
      if (input.action === 'cancel') {
        if (receipt.status !== 'running' || receipt.cancellationAvailable !== true) throw new Error('ANALYSIS_REQUEST_NOT_OWNED');
        return execution.cancelRequest(input.requestId);
      }
      // A crash after receipt recovery but before checkpoint publication is recoverable without a second solve.
      if (receipt.status !== 'completed') receipt = await execution.recoverRequest(input.requestId, input.expectedStateHash);
      if (typeof receipt.runId !== 'string') throw new Error('ANALYSIS_REQUEST_ARCHIVE_UNAVAILABLE');
      const run = await execution.getRun(receipt.runId);
      if (run.runId !== receipt.runId || run.requestId !== input.requestId || run.requestHash !== receipt.requestHash
        || !['completed', 'incomplete'].includes(String(run.executionStatus))) throw new Error('ANALYSIS_REQUEST_ARCHIVE_MISMATCH');
      // Historical addition only. Pending questions, budgets and current model/results remain unchanged.
      if (!reference.inHistory) await graph.updateState(graphConfig, { analysisRuns: { [receipt.runId]: run } });
      return { requestId: input.requestId, status: 'history_restored', runId: receipt.runId };
    } finally { release?.(); }
  }

  async getConversationSessionSnapshot(
    conversationId: string,
    _locale: AppLocale,
  ): Promise<{ snapshot: Record<string, unknown>; state?: AgentState } | undefined> {
    try {
      const graph = await this.getGraph();
      const config = { configurable: { thread_id: conversationId } };
      // Result reads cannot change the physical model or its runs. Polling their
      // busy status can reuse the locked snapshot instead of decoding the same
      // native archive concurrently with the read itself.
      const queried = this.resultQuerySnapshots.get(conversationId);
      const stateSnapshot = queried ? null : await graph.getState(config);
      const state = queried?.state ?? stateSnapshot!.values as AgentState;
      const clarification = queried?.clarification ?? clarificationState(state, stateSnapshot!.tasks);
      const usage = sessionRunUsage(state);
      const jobs = await this.conversationJobs(state, usage);
      return buildConversationSessionSnapshot({ conversationId, state, clarification, usage, jobs,
        busy: this.sessionLock.isBusy(conversationId) });
    } catch (error) {
      logger.debug({ conversationId, error }, 'Failed to load session snapshot');
      return undefined;
    }
  }

  async clearConversationSession(conversationId: string): Promise<void> {
    const release = await this.sessionLock.acquire(conversationId);
    try { await this.checkpointer.deleteThread(conversationId); } finally { release(); }
  }

  /** Read the same state used by chat; this projection neither starts a turn nor spends a tool call. */
  async getInputReview(conversationId: string) {
    const graph = await this.getGraph();
    const snapshot = await graph.getState({ configurable: { thread_id: conversationId } });
    const state = snapshot.values as AgentState;
    const policy = state.runPolicy ?? resolveApplicationRunPolicy({
      ...skillCatalog(await this.skillRuntime.listSkillManifests()),
    });
    const allowed = [...deriveToolContext({ ...state, selectedSkillIds: state.selectedSkillIds ?? [] }, policy, { allowShell: false }).activeToolIds];
    return buildInputReview(conversationId, state, snapshot.tasks, allowed);
  }

  /** Catalog only: archived numerical data are queried through the same permitted tool path. */
  async getResultReview(conversationId: string) {
    const graph = await this.getGraph();
    const snapshot = await graph.getState({ configurable: { thread_id: conversationId } });
    const state = snapshot.values as AgentState;
    const allowed = [...deriveToolContext(state, state.runPolicy ?? undefined, { allowShell: false }).activeToolIds];
    return buildResultReview(conversationId, state, allowed, this.sessionLock.isBusy(conversationId));
  }

  async invokeResultReviewTool(conversationId: string, input: {
    revisionToken: string; tool: ResultReviewTool; args: Record<string, unknown>; signal?: AbortSignal;
  }) {
    if (!RESULT_REVIEW_TOOLS.includes(input.tool)) throw new Error('RESULT_REVIEW_TOOL_NOT_ALLOWED');
    return this.invokeConversationTool(conversationId, input, 'result');
  }

  /** Deterministic user actions share the chat lock, registered tools and persisted policy ledger. */
  async invokeInputReviewTool(conversationId: string, input: {
    revisionToken: string; tool: InputReviewTool; args: Record<string, unknown>;
    initialContext?: LangGraphRunInput['context']; signal?: AbortSignal;
  }) {
    if (!INPUT_REVIEW_TOOLS.includes(input.tool)) throw new Error('INPUT_REVIEW_TOOL_NOT_ALLOWED');
    return this.invokeConversationTool(conversationId, input, 'input');
  }

  private async invokeConversationTool(conversationId: string, input: {
    revisionToken: string; tool: InputReviewTool | ResultReviewTool; args: Record<string, unknown>;
    initialContext?: LangGraphRunInput['context']; signal?: AbortSignal;
  }, purpose: 'input' | 'result') {
    const release = await this.sessionLock.acquire(conversationId);
    try {
      input.signal?.throwIfAborted();
      const graph = await this.getGraph();
      const graphConfig = { configurable: { thread_id: conversationId } };
      const snapshot = await graph.getState(graphConfig);
      let state = snapshot.values as AgentState;
      if (input.revisionToken !== inputReviewRevision(state)) throw new Error('INPUT_REVIEW_REVISION_CONFLICT');
      if (input.tool === 'query_results') this.resultQuerySnapshots.set(conversationId,
        { state, clarification: clarificationState(state, snapshot.tasks) });
      const initialized = Boolean(state.runPolicy && state.runUsage);
      if (purpose === 'result') {
        if (!initialized) throw new Error('CONVERSATION_POLICY_REQUIRED');
        if (input.tool === 'run_code_check') {
          // The result selector may be historical. Design always operates on the current
          // model/run and cannot switch engines, inject a model, or select a historical run.
          if (Object.keys(input.args).some(key => !['designCode', 'provider', 'design'].includes(key))
            || input.args.provider !== 'native') throw new Error('NATIVE_DESIGN_ARGUMENTS_REQUIRED');
          const review = nativeDesignReview(state, ['run_code_check']);
          if (!review.available) throw new Error(String(review.reason));
        } else {
          const selection = input.tool === 'generate_report' && isRecord(input.args.selection) ? input.args.selection : input.args;
          const runId = selection.runId;
          if (typeof runId !== 'string' || (!state.analysisRuns?.[runId] && state.analysisResult?.runId !== runId)) throw new Error('RUN_OUTSIDE_CONVERSATION');
        }
      }
      const request: LangGraphRunInput = { conversationId, message: `${purpose === 'input' ? 'Input review / 输入复核' : 'Result review / 结果查看'}: ${input.tool}`, signal: input.signal,
        context: initialized ? { locale: state.locale } : input.initialContext };
      // The session lock keeps this snapshot current. A resumed review only reads
      // its saved ledger; do not deserialize a large result archive twice more.
      const runtime = await this.prepareRunContext(request, conversationId, initialized, state);
      if (!initialized) state = (await graph.getState(graphConfig)).values as AgentState;
      if (!initialized) {
        const update = { selectedSkillIds: runtime.policy.activeSkillIds, toolAccessPolicy: buildToolAccessPolicy(input.initialContext),
          locale: input.initialContext?.locale ?? 'zh' as AppLocale, workspaceRoot: this.workspaceRoot };
        await graph.updateState(graphConfig, update);
        state = { ...state, ...update };
      }
      const executionConfig = this.buildGraphRuntimeConfig(request, randomUUID(), conversationId, runtime);
      const toolContextFor = (current: AgentState) => deriveToolContext(current, runtime.policy,
        { allowShell: false, fileAccessAllowlist: executionConfig.configurable.fileAccessAllowlist });
      let toolContext = toolContextFor(state);
      if (!toolContext.activeToolIds.includes(input.tool)) throw new Error(`TOOL_NOT_ALLOWED: ${input.tool}`);
      // A user may add a drawing while the chat is waiting. Only an explicitly supplied,
      // existing upload in this conversation can extend its attachment list; tool scope stays fixed.
      if (initialized && input.tool === 'analyze_file' && typeof input.args.filePath === 'string'
        && Array.isArray(state.toolAccessPolicy?.fileAccessAllowlist)) {
        const requestedPath = resolveUploadPath(input.args.filePath, this.workspaceRoot);
        const alreadyAllowed = state.toolAccessPolicy.fileAccessAllowlist.some(file => resolveUploadPath(file, this.workspaceRoot) === requestedPath);
        if (!alreadyAllowed) {
          const attachment = input.initialContext?.attachments?.find(item => resolveUploadPath(item.relPath, this.workspaceRoot) === requestedPath);
          if (!attachment) throw new Error('INPUT_ATTACHMENT_NOT_SUPPLIED');
          const [actual, uploadDirectory] = await Promise.all([fs.realpath(requestedPath), fs.realpath(path.join(runtimeBaseDir, '.uploads', conversationId))]);
          if (!isPathWithinRoot(actual, uploadDirectory) || !(await fs.stat(actual)).isFile()) throw new Error('INPUT_ATTACHMENT_OUTSIDE_CONVERSATION');
          const toolAccessPolicy = { ...state.toolAccessPolicy, fileAccessAllowlist: [...state.toolAccessPolicy.fileAccessAllowlist, attachment.relPath] };
          await graph.updateState(graphConfig, { toolAccessPolicy });
          state = { ...state, toolAccessPolicy };
          toolContext = toolContextFor(state);
        }
      }
      const tools = createRegisteredTools({ skillRuntime: this.skillRuntime, workspaceRoot: this.workspaceRoot })
        .filter(tool => tool.name === input.tool);
      const callId = `input-review-${randomUUID()}`;
      const actionState = { ...state, ...(state.requestScope && ['run_code_check','generate_report'].includes(input.tool)
        ? {requestScope:{...state.requestScope, ...(input.tool==='run_code_check'?{design:true}:{report:true})}} : {}), lastUserMessage: `${request.message}\n${JSON.stringify(input.args)}`,
        messages: [...(state.messages ?? []), new AIMessage({ content: '', tool_calls: [{ id: callId, name: input.tool, args: input.args }] })] };
      return await withRunContext(runtime, async () => {
        recordRunEvent({ kind: purpose === 'input' ? 'user_input_review' : 'user_result_review', tool: input.tool, callId, args: input.args });
        const command = await executeToolsSequentially(tools, actionState,
          { ...executionConfig, configurable: { ...executionConfig.configurable, agentState: state, toolContext } });
        const { messages, ...update } = command.update as Partial<AgentState>;
        // Synthetic calls are not appended to chat: the pending clarification call must stay current.
        // State updates follow LangGraph's normal human-in-the-loop update semantics.
        const runUsage = snapshotRunUsage(runtime);
        await graph.updateState(graphConfig, { ...update, runUsage });
        const output = messages?.find(message => message.getType() === 'tool') as ToolMessage | undefined;
        let result: unknown = output?.content;
        if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* plain tool output */ } }
        const failed = (value: unknown) => isRecord(value) && (value.success === false || value.valid === false || Boolean(value.error) || value.status === 'failed');
        // A result query changes saved quantities and usage only. Project the
        // committed update using the same quantity merge as the state channel,
        // rather than rereading all native cases just to return its revision.
        const queried = input.tool === 'query_results' ? { ...state, ...update, runUsage,
          resultQuantities: { ...state.resultQuantities, ...update.resultQuantities } } : null;
        const review = queried ? buildResultReview(conversationId, queried,
          [...deriveToolContext(queried, queried.runPolicy ?? undefined, { allowShell: false }).activeToolIds], this.sessionLock.isBusy(conversationId))
          : purpose === 'input' ? await this.getInputReview(conversationId) : await this.getResultReview(conversationId);
        return { result, success: output?.status !== 'error' && !failed(result) && !failed(isRecord(result) ? result.result : undefined), review };
      });
    } finally {
      if (input.tool === 'query_results') this.resultQuerySnapshots.delete(conversationId);
      release();
    }
  }

  async listSkills(): Promise<{ skills: SkillManifest[] }> {
    const manifests = await this.skillRuntime.listSkillManifests();
    return { skills: manifests };
  }

  /**
   * Get the agent protocol (tool metadata) as a static method.
   * Keeps name/description route compatibility while sourcing from registry.
   */
  static getProtocol(): {
    tools: Array<{
      name: string;
      description: string;
      displayName: { zh: string; en: string };
      localizedDescription: { zh: string; en: string };
      category: string;
      risk: string;
      defaultEnabled: boolean;
    }>;
  } {
    return {
      tools: listAgentToolDefinitions().map((definition) => ({
        name: definition.id,
        description: definition.description.en,
        displayName: definition.displayName,
        localizedDescription: definition.description,
        category: definition.category,
        risk: definition.risk,
        defaultEnabled: definition.defaultEnabled,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Result extraction
  // ---------------------------------------------------------------------------

  private extractResult(
    finalState: AgentState,
    conversationId: string,
    traceId: string,
    startedAt: string,
  ): LangGraphRunResult {
    const messages = Array.isArray(finalState.messages) ? finalState.messages : [];
    const lastMessage = messages[messages.length - 1];

    let response = '';
    if (lastMessage && 'content' in lastMessage) {
      response = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);
    }

    const toolCalls: unknown[] = [];
    for (const msg of messages) {
      if (msg && typeof msg === 'object' && 'tool_calls' in msg) {
        const tc = (msg as any).tool_calls;
        if (Array.isArray(tc)) toolCalls.push(...tc);
      }
    }

    return {
      conversationId,
      traceId,
      startedAt,
      completedAt: new Date().toISOString(),
      success: true,
      response,
      ...clarificationState(finalState),
      mode: toolCalls.length > 0 ? 'execution' : 'conversation',
      toolCalls,
      draftState: finalState.draftState ?? undefined,
    };
  }
}
