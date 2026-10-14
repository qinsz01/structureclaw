import { z } from 'zod';
import { AgentSkillRuntime } from '../agent-runtime/index.js';
import { createRegisteredTools, listAgentToolDefinitions, type AgentToolFactoryDeps } from './tool-registry.js';
import { AgentStateAnnotation } from './state.js';
import type { AgentState } from './state.js';
import { AIMessage, type BaseMessage, type ToolMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, runtimeBaseDir } from '../config/index.js';
import { resolveApplicationRunPolicy } from '../runtime/policy-settings.js';
import type { RunPolicyInput, EffectiveRunPolicy } from '../runtime/run-policy.js';
import { createRunContext, withRunContext, snapshotRunUsage, type RunUsage } from '../runtime/run-context.js';
import { executeToolsSequentially } from './sequential-tools.js';
import { createLocalAnalysisEngineClient } from '../services/analysis-execution.js';
import { createLocalCodeCheckClient } from '../services/code-check-execution.js';
import { createLocalStructureProtocolClient } from '../services/structure-protocol-execution.js';
import { SessionLock } from '../engineering/session-lock.js';
import { acquirePersistentSessionLock, readPersistentSession, withAbandonedSessionRecovery } from '../engineering/persistent-session-lock.js';
import { normalizeEngineeringModel } from '../engineering/model-boundary.js';
import { commitModel, contentHash } from '../engineering/model-state.js';
import { writeAtomicJson as atomicRecord } from '../engineering/atomic-json.js';

/** Apply the application reducers to external tool updates, without duplicating state rules. */
export function applyPublicToolStateUpdate(
  state: Record<string, unknown>, update: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...state };
  const channels = AgentStateAnnotation.spec as unknown as Record<string, {
    operator?: (previous: unknown, value: unknown) => unknown;
    initialValueFactory?: () => unknown;
  }>;
  for (const [key, value] of Object.entries(update)) {
    // External runners keep serializable message records; they append those themselves.
    if (key === 'messages') continue;
    const channel = channels[key];
    next[key] = channel?.operator
      ? channel.operator(next[key] ?? channel.initialValueFactory?.(), value)
      : value;
  }
  return next;
}

/** External adapters consume the same input schemas as the registered application tools. */
export function getPublicToolDefinitions(deps?: AgentToolFactoryDeps) {
  const definitions = new Map(listAgentToolDefinitions().map((definition) => [definition.id, definition]));
  return createRegisteredTools(deps ?? { skillRuntime: new AgentSkillRuntime() }).map((tool) => {
    const definition = definitions.get(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      category: definition?.category,
      label: definition?.displayName.en ?? tool.name,
      parameters: z.toJSONSchema(tool.schema as z.ZodType, { io: 'input' }),
    };
  });
}

const publicSessions = new SessionLock();
async function acquirePublicSession(sessionId: string, file: string) {
  const release = await publicSessions.acquire(sessionId);
  try {
    const releaseClaim = await acquirePersistentSessionLock(file);
    return async () => { try { await releaseClaim(); } finally { release(); } };
  } catch (error) { release(); throw error; }
}
interface PublicSessionRecord {
  sessionId: string; policy: EffectiveRunPolicy; usage: RunUsage; state: Record<string, unknown>;
  pendingCall?: { id: string; name: string };
}

interface CompletedPublicCall {
  version: 1; sessionId: string; callId: string; pendingStateHash: string; record: PublicSessionRecord;
  messages: Array<{ type: string; name?: string; content: unknown; toolCallId?: string; status?: string }>;
}

function sessionPath(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('INVALID_PUBLIC_SESSION_ID');
  return path.join(runtimeBaseDir, 'public-tool-sessions', `${sessionId}.json`);
}

function readSessionUsage(saved: PublicSessionRecord): RunUsage {
  if (!/^[a-zA-Z0-9_-]+$/.test(saved.usage.runId)) throw new Error('INVALID_RUN_ID');
  const ledger = JSON.parse(fs.readFileSync(path.join(runtimeBaseDir, 'run-records', `${saved.usage.runId}.json`), 'utf8'));
  const usage = ledger.usage as RunUsage;
  if (contentHash(ledger.policy) !== contentHash(saved.policy) || usage.runId !== saved.usage.runId
    || usage.policyHash !== saved.policy.policyHash
    || ['toolCalls', 'llmCalls', 'recoveries'].some(key => {
      const name = key as 'toolCalls' | 'llmCalls' | 'recoveries';
      return !Number.isInteger(usage[name]) || usage[name] < saved.usage[name];
    })) throw new Error('PUBLIC_SESSION_USAGE_LEDGER_MISMATCH / 会话用量台账不一致');
  return usage;
}

function readCompletion(file: string, saved: PublicSessionRecord, usage: RunUsage): CompletedPublicCall | undefined {
  if (!fs.existsSync(`${file}.completed`)) return undefined;
  const receipt = JSON.parse(fs.readFileSync(`${file}.completed`, 'utf8')) as CompletedPublicCall;
  // An older successful call's receipt cannot settle a later unknown operation.
  if (saved.pendingCall && receipt.callId !== saved.pendingCall.id) return undefined;
  if (!saved.pendingCall && contentHash(receipt.record) !== contentHash(saved)) return undefined;
  const next = receipt.record;
  if (receipt.version !== 1 || receipt.sessionId !== saved.sessionId
    || (saved.pendingCall && receipt.pendingStateHash !== contentHash(saved))
    || next.sessionId !== saved.sessionId || next.pendingCall || contentHash(next.policy) !== contentHash(saved.policy)
    || next.usage.runId !== saved.usage.runId || next.usage.policyHash !== saved.policy.policyHash
    || next.usage.toolCalls < saved.usage.toolCalls || next.usage.llmCalls < saved.usage.llmCalls
    || next.usage.recoveries < saved.usage.recoveries || !Array.isArray(receipt.messages)
    || !receipt.messages.some(message => message.type === 'tool' && message.toolCallId === receipt.callId)) {
    throw new Error('PUBLIC_SESSION_COMPLETION_INVALID / 已完成调用记录与会话不匹配');
  }
  if (contentHash(usage) !== contentHash(next.usage)) {
    throw new Error('PUBLIC_SESSION_COMPLETION_LEDGER_MISMATCH / 调用记录与用量台账不一致');
  }
  return receipt;
}

/** Read-only inspection. Host death alone never proves a native job has finished. */
export async function inspectPublicToolSession(sessionId: string) {
  const file = sessionPath(sessionId);
  return readPersistentSession(file, claim => {
    if (!fs.existsSync(file)) throw new Error('PUBLIC_SESSION_NOT_FOUND');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as PublicSessionRecord;
    const usage = readSessionUsage(saved);
    // A live owner may advance its output and ledger while inspection is reading.
    // Only a quiescent session can certify a completed operation for recovery.
    const completed = claim?.alive ? undefined : readCompletion(file, saved, usage);
    return { sessionId, stateHash: contentHash(saved), claim, policy: saved.policy, usage, pendingCall: saved.pendingCall,
      status: claim?.alive ? 'busy' : saved.pendingCall ? completed ? 'recoverable' : 'outcome_unknown' : claim ? 'recoverable' : 'idle',
      recovery: claim?.alive ? null : saved.pendingCall ? completed ? 'commit-recorded-completion' : 'inspect-original-operation'
        : claim ? 'release-abandoned-claim' : null,
      ...(completed ? { completedCall: { callId: completed.callId, messages: completed.messages } } : {}) };
  });
}

/** Explicitly publish an already recorded completion; this function never invokes a tool. */
export async function recoverPublicToolSession(input: { sessionId: string; expectedStateHash: string; expectedClaimToken: string | null }) {
  const file = sessionPath(input.sessionId);
  if (!/^[a-f0-9]{64}$/.test(input.expectedStateHash)
    || (input.expectedClaimToken !== null && typeof input.expectedClaimToken !== 'string')) throw new Error('INVALID_PUBLIC_SESSION_RECOVERY');
  const release = await publicSessions.acquire(input.sessionId);
  let recovered: CompletedPublicCall | undefined;
  try {
    await withAbandonedSessionRecovery(file, input.expectedClaimToken, () => {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as PublicSessionRecord;
      if (contentHash(saved) !== input.expectedStateHash) throw new Error('PUBLIC_SESSION_STATE_CHANGED');
      const completed = readCompletion(file, saved, readSessionUsage(saved));
      if (saved.pendingCall) {
        if (!completed) throw new Error('PUBLIC_TOOL_OUTCOME_UNKNOWN: inspect the original operation; recovery cannot reissue it');
        atomicRecord(file, completed.record);
      }
      recovered = completed;
    });
  } finally { release(); }
  return { ...await inspectPublicToolSession(input.sessionId),
    ...(recovered ? { completedCall: { callId: recovered.callId, messages: recovered.messages } } : {}) };
}

/** Server-owned tool session. Host messages/LLM loops are deliberately outside its authority. */
export async function createPublicToolSession(input: {
  sessionId?: string; resume?: boolean; newTurn?: boolean; runPolicy?: RunPolicyInput;
  message?: string; locale?: 'zh' | 'en'; model?: Record<string, unknown>; modelFormat?: string;
}, deps: AgentToolFactoryDeps = { skillRuntime: new AgentSkillRuntime() }) {
  const sessionId = input.sessionId ?? randomUUID();
  const file = sessionPath(sessionId);
  const journalDir = path.join(runtimeBaseDir, 'run-records');
  const read = (): PublicSessionRecord => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = (record: PublicSessionRecord) => atomicRecord(file, record);
  const release = await acquirePublicSession(sessionId, file);
  let record: PublicSessionRecord;
  const protocol = createLocalStructureProtocolClient();
  try {
    const exists = fs.existsSync(file);
    if (input.resume && !exists) throw new Error('PUBLIC_SESSION_NOT_FOUND');
    if (exists && !input.resume && !input.newTurn) throw new Error('PUBLIC_SESSION_ALREADY_EXISTS');
    const saved = exists ? read() : undefined;
    if (saved?.pendingCall) throw new Error('PUBLIC_TOOL_OUTCOME_UNKNOWN: inspect the saved run; do not automatically reissue the operation');
    if (input.resume && !input.newTurn) {
      if (input.runPolicy || input.message !== undefined || input.model) throw new Error('PUBLIC_SESSION_RESUME_IMMUTABLE');
      record = saved!;
    } else {
      const policy = resolveApplicationRunPolicy({ availableSkillIds: (await deps.skillRuntime.listSkillManifests()).map(item => item.id),
        previous: saved?.policy, requested: input.runPolicy, executionOwner: 'external' });
      if (policy.routing.mode === 'fixed' && !await deps.skillRuntime.resolvePluginForType(policy.routing.skillId, policy.activeSkillIds)) throw new Error('FIXED_SKILL_NOT_A_MODELING_PROVIDER');
      const runtime = createRunContext(policy, { journalDir });
      const defaults = Object.fromEntries(Object.entries(AgentStateAnnotation.spec).map(([key, channel]) => [key, (channel as unknown as { initialValueFactory?: () => unknown }).initialValueFactory?.()]));
      const state = { ...defaults, ...saved?.state, messages: [], selectedSkillIds: policy.activeSkillIds,
        runPolicy: policy, runUsage: snapshotRunUsage(runtime), locale: input.locale ?? saved?.state.locale ?? 'zh',
        lastUserMessage: input.message ?? '', workspaceRoot: deps.workspaceRoot ?? config.agentWorkspaceRoot };
      if (input.model) Object.assign(state, commitModel(state as unknown as AgentState, await normalizeEngineeringModel(input.model, protocol, input.modelFormat), 'import_model'));
      record = { sessionId, policy, usage: snapshotRunUsage(runtime), state };
      write(record);
    }
  } finally { await release(); }
  return {
    sessionId,
    policy: record.policy,
    snapshot: () => structuredClone(read()),
    invoke: async (name: string, args: Record<string, unknown>) => {
      const unlock = await acquirePublicSession(sessionId, file);
      try {
        const saved = read();
        if (saved.policy.policyHash !== record.policy.policyHash || saved.usage.runId !== record.usage.runId) throw new Error('PUBLIC_SESSION_TURN_CHANGED');
        if (saved.pendingCall) throw new Error('PUBLIC_TOOL_OUTCOME_UNKNOWN');
        const runtime = createRunContext(saved.policy, { runId: saved.usage.runId, usage: saved.usage, journalDir, resume: true });
        if (!saved.policy.activeToolIds.includes(name)) throw new Error(`TOOL_NOT_ALLOWED: ${name}`);
        const tools = createRegisteredTools(deps).filter(item => saved.policy.activeToolIds.includes(item.name));
        if (!tools.some(item => item.name === name)) throw new Error(`UNKNOWN_TOOL: ${name}`);
        const id = randomUUID();
        const state = { ...saved.state, messages: [new AIMessage({ content: '', tool_calls: [{ id, name, args }] })] } as AgentState;
        const pending = { ...saved, pendingCall: { id, name } };
        write(pending);
        const output = await withRunContext(runtime, () => executeToolsSequentially(tools, state, { configurable: {
          thread_id: `public-${sessionId}`,
          runContext: runtime, agentState: state, skillRuntime: deps.skillRuntime,
          skillScope: saved.policy.activeSkillIds.filter(item => state.selectedSkillIds.includes(item)),
          enabledToolIds: saved.policy.activeToolIds, disabledToolIds: [], allowShell: config.agentAllowShell,
          workspaceRoot: deps.workspaceRoot ?? config.agentWorkspaceRoot,
          maxToolCallsPerTurn: saved.policy.budgets.maxToolCallsPerTurn, engineClient: createLocalAnalysisEngineClient(),
          codeCheckClient: createLocalCodeCheckClient(), structureProtocolClient: protocol,
        } }));
        const update = output.update as Record<string, unknown>;
        const next = applyPublicToolStateUpdate(saved.state, update);
        next.messages = [];
        record = { sessionId, policy: saved.policy, usage: snapshotRunUsage(runtime), state: next };
        // Commit the completed output before publishing state. A stopped host can
        // recover this exact result without replaying a model edit or solver call.
        const messages = (update.messages as BaseMessage[]).map(message => ({ type: message.getType(), name: message.name,
          content: message.content, ...(message.getType() === 'tool' ? {
            toolCallId: (message as ToolMessage).tool_call_id, status: (message as ToolMessage).status,
          } : {}) }));
        atomicRecord(`${file}.completed`, { version: 1, sessionId, callId: id, pendingStateHash: contentHash(pending), record, messages } satisfies CompletedPublicCall);
        write(record);
        return { sessionId, policy: saved.policy, usage: record.usage, messages: update.messages, state: next };
      } finally { await unlock(); }
    },
  };
}
