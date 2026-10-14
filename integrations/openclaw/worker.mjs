import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { backendDirectory } from './bridge.mjs';

async function execute(request) {
  const { options, action, sessionId } = request;
  const output = backendDirectory(options.structureclawRoot);
  if (!fs.existsSync(path.join(output, 'agent-langgraph/public-tool-contracts.js'))) throw new Error('STRUCTURECLAW_BUILD_REQUIRED / 请先构建本体');
  const load = relative => import(pathToFileURL(path.join(output, relative)).href);
  const [contracts, { AgentSkillRuntime }, { resolveApplicationRunPolicy }, { runtimeBaseDir }] = await Promise.all([
    load('agent-langgraph/public-tool-contracts.js'), load('agent-runtime/index.js'),
    load('runtime/policy-settings.js'), load('config/index.js'),
  ]);
  const deps = { skillRuntime: new AgentSkillRuntime(), ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}) };
  if (action === 'definitions') {
    const policy = resolveApplicationRunPolicy({ availableSkillIds: (await deps.skillRuntime.listSkillManifests()).map(item => item.id),
      requested: options.runPolicy, executionOwner: 'external' });
    return contracts.getPublicToolDefinitions(deps).filter(item => policy.activeToolIds.includes(item.name));
  }
  if (!/^openclaw-[a-f0-9]{64}$/.test(sessionId)) throw new Error('INVALID_HOST_SESSION / 宿主会话无效');
  if (action === 'inspect' || action === 'recover') {
    const result = action === 'recover' ? await contracts.recoverPublicToolSession({ sessionId,
      expectedStateHash: request.args.expectedStateHash, expectedClaimToken: request.args.expectedClaimToken })
      : await contracts.inspectPublicToolSession(sessionId);
    // Do not repeat the whole engineering model/result archive in the LLM context.
    const { state, ...status } = result;
    return status;
  }
  if (action === 'begin' || action === 'new_turn') {
    // Uploads use the application's existing /api/v1/files/upload endpoint. Only
    // this host conversation's directory grants attachment access to its tools.
    const directory = path.join(runtimeBaseDir, '.uploads', sessionId);
    const attachmentPaths = fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true })
      .filter(item => item.isFile() && !item.isSymbolicLink()).map(item => path.join(directory, item.name)) : [];
    const args = request.args ?? {};
    const session = await contracts.createPublicToolSession({ sessionId, newTurn: action === 'new_turn',
      runPolicy: options.runPolicy, message: args.message, locale: args.locale ?? options.locale,
      model: args.model, modelFormat: args.modelFormat, attachmentPaths }, deps);
    const saved = session.snapshot();
    return { sessionId, attachmentUploadConversationId: sessionId, attachmentPaths, policy: session.policy,
      usage: saved.usage, modelRevision: saved.state.modelRevision,
      hostBoundary: 'OpenClaw owns its conversation and LLM loop; StructureClaw owns these tool operations / 宿主负责对话循环，本体负责工程工具执行' };
  }
  if (action !== 'invoke') throw new Error('UNKNOWN_BRIDGE_ACTION / 未知桥接操作');
  const session = await contracts.createPublicToolSession({ sessionId, resume: true }, deps);
  if (typeof request.hostCallId !== 'string' || !request.hostCallId.trim()) throw new Error('HOST_TOOL_CALL_ID_REQUIRED / 需要宿主工具调用标识');
  const result = await session.invoke(request.name, request.args, request.hostCallId);
  return { sessionId, policyHash: result.policy.policyHash, usage: result.usage,
    messages: result.messages.map(message => ({ type: message.getType(), name: message.name,
      content: message.content, status: message.status, toolCallId: message.tool_call_id })) };
}

try {
  const input = fs.readFileSync(0, 'utf8');
  const value = await execute(JSON.parse(input));
  fs.writeFileSync(3, JSON.stringify({ ok: true, value }));
} catch (error) {
  fs.writeFileSync(3, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}
// All admitted work is awaited above; logger/SDK client idle handles must not
// keep a completed one-shot plugin request alive.
process.exit(0);
