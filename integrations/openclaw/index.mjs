import fs from 'node:fs';
import { resolveOptions, sessionIdentity, getDefinitions, invokeWorker, toolResult } from './bridge.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('./openclaw.plugin.json', import.meta.url), 'utf8'));
const sessionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['begin', 'inspect', 'recover'] },
    message: { type: 'string', description: 'Current user request / 当前用户要求' },
    locale: { type: 'string', enum: ['zh', 'en'] },
    model: { type: 'object', description: 'Optional source engineering model, validated by StructureClaw / 可选源工程模型，由本体校验' },
    modelFormat: { type: 'string' },
    expectedStateHash: { type: 'string' },
    expectedClaimToken: { type: ['string', 'null'] },
  }, required: ['action'],
};

export default {
  id: 'structureclaw', name: 'StructureClaw engineering tools / 工程工具',
  description: 'Engineering tools backed by the StructureClaw application / 由本体提供的工程工具',
  register(api) {
    const options = resolveOptions(api.pluginConfig ?? {});
    const definitions = getDefinitions(options);
    const declared = new Set(manifest.contracts.tools);
    for (const definition of definitions) {
      if (!declared.has(`sclaw_${definition.name}`)) throw new Error(`PLUGIN_MANIFEST_OUTDATED: ${definition.name} / 插件清单需要更新`);
    }
    const register = (definition, action) => api.registerTool(context => ({
      ...definition,
      async execute(callId, params, signal) {
        try {
          context.assertInvocationCurrent?.();
          const sessionId = sessionIdentity(context, options);
          if (action === 'session' && params.action === 'begin' && typeof params.message !== 'string') {
            throw new Error('USER_MESSAGE_REQUIRED / 开始一轮执行需提供用户要求');
          }
          if (action === 'session' && !['begin', 'inspect', 'recover'].includes(params.action)) {
            throw new Error('UNKNOWN_SESSION_ACTION / 未知会话操作');
          }
          const value = await invokeWorker(options, { sessionId, args: params,
            action: action === 'session' ? params.action : 'invoke', ...(action !== 'session' ? { name: action, hostCallId: callId } : {}) }, signal);
          return toolResult(value);
        } catch (error) {
          const value = { status: 'error', error: error instanceof Error ? error.message : String(error),
            retryAutomatically: false };
          return { ...toolResult(value), isError: true };
        }
      },
    }), { name: definition.name, optional: true });
    register({ name: 'sclaw_session', label: 'Engineering session / 工程会话',
      description: 'Begin once before engineering calls. Only the operator can start another turn. Inspect/recover an unknown outcome without replay. / 工程调用前建立会话，下一轮仅由操作员发起。未知结果先检查恢复，勿重放。',
      parameters: sessionSchema }, 'session');
    for (const definition of definitions) register({ ...definition, name: `sclaw_${definition.name}` }, definition.name);
  },
};
