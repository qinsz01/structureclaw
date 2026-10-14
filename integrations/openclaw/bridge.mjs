import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const root = path.resolve(path.dirname(worker), '../..');

export function backendDirectory(structureclawRoot) {
  // A checkout can retain an older packaging output. Never silently prefer it
  // to the currently built application used by the local developer.
  return path.join(structureclawRoot, fs.existsSync(path.join(structureclawRoot, 'backend/tsconfig.json'))
    ? 'backend/dist' : 'dist/backend');
}

export function resolveOptions(config = {}) {
  const options = { ...config, structureclawRoot: path.resolve(config.structureclawRoot ?? root) };
  for (const key of ['dataDir', 'workspaceRoot']) {
    if (options[key] !== undefined && (!path.isAbsolute(options[key]) || !options[key].trim())) {
      throw new Error(`INVALID_PLUGIN_PATH: ${key} must be absolute / 必须为绝对路径`);
    }
  }
  if (!fs.existsSync(path.join(backendDirectory(options.structureclawRoot), 'agent-langgraph/public-tool-contracts.js'))) {
    throw new Error('STRUCTURECLAW_BUILD_REQUIRED: install or build StructureClaw / 请先安装或构建 StructureClaw');
  }
  return options;
}

/** Only the trusted host context selects a conversation, never tool arguments. */
export function sessionIdentity(context, options) {
  if (context?.sandboxed) throw new Error('HOST_SANDBOX_UNSUPPORTED: local bridge cannot enforce the host sandbox / 本地桥无法执行宿主沙箱约束');
  for (const key of ['agentId', 'sessionKey', 'sessionId']) {
    if (typeof context?.[key] !== 'string' || !context[key].trim()) {
      throw new Error(`HOST_SESSION_CONTEXT_REQUIRED: ${key} / 需要可信宿主会话身份`);
    }
  }
  return `openclaw-${createHash('sha256').update(JSON.stringify([
    options.structureclawRoot, options.workspaceRoot ?? null, context.agentId, context.sessionKey, context.sessionId,
  ])).digest('hex')}`;
}

function environment(options) {
  return { ...process.env, ...(options.dataDir ? { SCLAW_DATA_DIR: options.dataDir } : {}) };
}

function unpack(bytes) {
  let response;
  try { response = JSON.parse(bytes); } catch { throw new Error('STRUCTURECLAW_BRIDGE_RESPONSE_INVALID / 本体桥接响应无效'); }
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

export function getDefinitions(options) {
  // Registration is synchronous in OpenClaw; only schema discovery runs here.
  const output = spawnSync(process.execPath, [worker], { windowsHide: true,
    env: environment(options), input: JSON.stringify({ action: 'definitions', options }),
    stdio: ['pipe', 'ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  if (output.error) throw output.error;
  if (!output.output?.[3]) throw new Error(`STRUCTURECLAW_BRIDGE_UNAVAILABLE (${output.status}) / 本体桥接不可用`);
  return unpack(output.output[3]);
}

export function invokeWorker(options, request, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Never timeout-kill or replay an admitted solver/edit operation. The durable
    // public session can inspect a lost outcome without starting the work again.
    const child = spawn(process.execPath, [worker], { windowsHide: true,
      env: environment(options), stdio: ['pipe', 'ignore', 'ignore', 'pipe'] });
    const chunks = [];
    child.stdio[3].on('data', chunk => chunks.push(chunk));
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', () => {
      try {
        const value = unpack(Buffer.concat(chunks).toString('utf8'));
        resolve({ ...value, ...(signal?.aborted ? { cancellationRequested: true,
          cancellationNote: 'The admitted operation settled; it was not replayed / 已接纳操作已收尾，未重放' } : {}) });
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ ...request, options }));
  });
}

export function toolResult(value) {
  const failed = value.messages?.some(message => {
    if (message.status === 'error') return true;
    try {
      const payload = JSON.parse(message.content);
      return payload.success === false || payload.valid === false || Boolean(payload.error) || payload.status === 'failed';
    } catch { return false; }
  });
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, ...(failed ? { isError: true } : {}) };
}
