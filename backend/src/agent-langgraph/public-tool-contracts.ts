import { z } from 'zod';
import { AgentSkillRuntime } from '../agent-runtime/index.js';
import { createRegisteredTools, listAgentToolDefinitions, type AgentToolFactoryDeps } from './tool-registry.js';
import { AgentStateAnnotation } from './state.js';
import type { AgentState } from './state.js';
import { AIMessage } from '@langchain/core/messages';
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
import { acquirePersistentSessionLock } from '../engineering/persistent-session-lock.js';
import { normalizeEngineeringModel } from '../engineering/model-boundary.js';
import { commitModel } from '../engineering/model-state.js';

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

/** Server-owned tool session. Host messages/LLM loops are deliberately outside its authority. */
export async function createPublicToolSession(input: {
  sessionId?: string; resume?: boolean; newTurn?: boolean; runPolicy?: RunPolicyInput;
  message?: string; locale?: 'zh' | 'en'; model?: Record<string, unknown>; modelFormat?: string;
}, deps: AgentToolFactoryDeps = { skillRuntime: new AgentSkillRuntime() }) {
  const sessionId = input.sessionId ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('INVALID_PUBLIC_SESSION_ID');
  const directory = path.join(runtimeBaseDir, 'public-tool-sessions');
  const file = path.join(directory, `${sessionId}.json`);
  const journalDir = path.join(runtimeBaseDir, 'run-records');
  const read = (): PublicSessionRecord => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = (record: PublicSessionRecord) => {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
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
        write({ ...saved, pendingCall: { id, name } });
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
        write(record);
        return { sessionId, policy: saved.policy, usage: record.usage, messages: update.messages, state: next };
      } finally { await unlock(); }
    },
  };
}
