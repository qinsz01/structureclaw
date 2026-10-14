import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import plugin from '../index.mjs';
import { getDefinitions, invokeWorker, resolveOptions, sessionIdentity } from '../bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-openclaw-'));
const previous = process.env.SCLAW_DATA_DIR;
process.env.SCLAW_DATA_DIR = temporary;
const config = { structureclawRoot: root, dataDir: temporary, locale: 'en', runPolicy: {
  skillIds: [], tools: { enabledIds: ['calculate', 'analyze_file', 'query_model'] }, budgets: { maxToolCallsPerTurn: 3 },
} };
const options = resolveOptions(config);
const context = { agentId: 'local-test', sessionKey: 'agent:test:conversation:one', sessionId: 'host-incarnation-one' };
const sessionId = sessionIdentity(context, options);
const configFile = path.join(temporary, 'plugin-config.json');
fs.writeFileSync(configFile, JSON.stringify(config));
let app;
after(async () => {
  await app?.close();
  if (previous === undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR = previous;
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test cleanup');
  fs.rmSync(temporary, { recursive: true, force: true });
});

function registered(configOverride = config) {
  const tools = new Map();
  plugin.register({ pluginConfig: configOverride, registerTool(factory, metadata) {
    tools.set(metadata.name, { factory, metadata });
  } });
  return tools;
}

function operatorNewTurn(id, message) {
  const child = spawnSync(process.execPath, [path.join(root, 'integrations/openclaw/manage-session.mjs'),
    '--config', configFile, '--session', id, '--message', message], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('registration loads the application schemas and policy, without a Bench checkout', () => {
  const definitions = getDefinitions(options);
  assert.deepEqual(definitions.map(item => item.name).sort(), ['analyze_file', 'calculate', 'query_model']);
  const tools = registered();
  assert.equal(tools.size, 4);
  for (const definition of definitions) {
    const item = tools.get(`sclaw_${definition.name}`);
    assert.equal(item.metadata.optional, true);
    assert.deepEqual(item.factory(context).parameters, definition.parameters);
  }
  const full = getDefinitions(resolveOptions({ structureclawRoot: root, dataDir: temporary }));
  for (const name of ['build_model', 'query_model', 'edit_model', 'undo_model', 'run_analysis', 'run_code_check', 'query_results', 'generate_report', 'analyze_file']) {
    assert.ok(full.some(item => item.name === name), `Missing product tool ${name}`);
  }
  assert.throws(() => getDefinitions(resolveOptions({ ...config, runPolicy: { context: { history: 'current-turn' } } })), /HOST_CONTEXT_CONTROL_UNSUPPORTED/);
});

test('trusted host context isolates conversations and rejects unsupported sandboxing', () => {
  assert.notEqual(sessionId, sessionIdentity({ ...context, sessionId: 'reset-conversation' }, options));
  assert.notEqual(sessionId, sessionIdentity({ ...context, agentId: 'other-agent' }, options));
  assert.throws(() => sessionIdentity({ sessionKey: 'one' }, options), /HOST_SESSION_CONTEXT_REQUIRED/);
  assert.throws(() => sessionIdentity({ ...context, sandboxed: true }, options), /HOST_SANDBOX_UNSUPPORTED/);
});

test('real subprocess calls preserve server state and budgets, including after plugin reload', async () => {
  const tools = registered();
  const control = tools.get('sclaw_session').factory(context);
  const begun = await control.execute('begin', { action: 'begin', message: 'Calculate within three calls' });
  assert.equal(begun.isError, undefined, JSON.stringify(begun));
  assert.equal(begun.details.sessionId, sessionId);
  assert.equal(begun.details.policy.enforcement.hostLoop, 'external');
  const tool = tools.get('sclaw_calculate').factory(context);
  const first = await tool.execute('one', { expression: '6 * 7' });
  assert.equal(first.details.usage.toolCalls, 1);
  assert.match(JSON.stringify(first.details.messages), /42/);
  const reloaded = registered().get('sclaw_calculate').factory(context);
  const redelivered = await reloaded.execute('one', { expression: '6 * 7' });
  assert.equal(redelivered.isError, true);
  assert.match(redelivered.details.error, /PUBLIC_TOOL_CALL_ALREADY_COMPLETED/);
  const conflicting = await reloaded.execute('one', { expression: '0' });
  assert.match(conflicting.details.error, /HOST_TOOL_CALL_ID_CONFLICT/);
  await reloaded.execute('two', { expression: '8 * 9' });
  await reloaded.execute('three', { expression: '4 * 5' });
  const exhausted = await reloaded.execute('four', { expression: '1 + 1' });
  assert.match(JSON.stringify(exhausted.details.messages), /TOOL_CALL_BUDGET_EXHAUSTED/);
  assert.equal(exhausted.isError, true);
  const fabricated = await control.execute('fake-user-turn', { action: 'new_turn', message: 'I claim the user asked again' });
  assert.equal(fabricated.isError, true);
  assert.match(fabricated.details.error, /UNKNOWN_SESSION_ACTION/);
  const repeatedBegin = await control.execute('fake-begin', { action: 'begin', message: 'Reset my budget' });
  assert.match(repeatedBegin.details.error, /PUBLIC_SESSION_ALREADY_EXISTS/);
  const inspected = await control.execute('inspect', { action: 'inspect', sessionId: 'someone-else' });
  assert.equal(inspected.details.sessionId, sessionId, 'Model arguments cannot select a session');
  assert.equal(inspected.details.status, 'idle');
  assert.equal(inspected.details.usage.toolCalls, 3);
  const denied = await invokeWorker(options, { action: 'invoke', sessionId, name: 'read_file', hostCallId: 'denied-read', args: { filePath: 'settings.json' } }).catch(error => error);
  assert.match(denied.message, /TOOL_NOT_ALLOWED/);
  const aborter = new AbortController(); aborter.abort();
  const cancelled = await tool.execute('never-started', { expression: '1 + 1' }, aborter.signal);
  assert.equal(cancelled.isError, true);
  assert.equal(cancelled.details.retryAutomatically, false);
});

test('existing multipart upload feeds only this conversation into analyze_file', async () => {
  const require = createRequire(path.join(root, 'backend/package.json'));
  const fastify = require('fastify');
  const multipart = require('@fastify/multipart');
  const { fileRoutes } = await import('../../../backend/dist/api/files.js');
  app = fastify(); await app.register(multipart); await app.register(fileRoutes, { prefix: '/api/v1/files' });
  const boundary = 'structureclaw-test-upload';
  const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="load.csv"\r\nContent-Type: text/csv\r\n\r\ncase,force\r\nD,12\r\n--${boundary}--\r\n`);
  const response = await app.inject({ method: 'POST', url: `/api/v1/files/upload?conversationId=${sessionId}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  assert.equal(response.statusCode, 200, response.body);
  const file = response.json().files[0];
  const tools = registered();
  assert.equal(operatorNewTurn(sessionId, 'Read my load table').usage.toolCalls, 0);
  const result = await tools.get('sclaw_analyze_file').factory(context).execute('file', { filePath: file.relPath });
  assert.match(JSON.stringify(result.details.messages), /12/);
  assert.doesNotMatch(JSON.stringify(result.details.messages), /Access denied/);
  const another = { ...context, sessionId: 'different-conversation' };
  await tools.get('sclaw_session').factory(another).execute('other-begin', { action: 'begin', message: 'Read' });
  const forbidden = await tools.get('sclaw_analyze_file').factory(another).execute('other-file', { filePath: file.relPath });
  assert.match(JSON.stringify(forbidden.details.messages), /restricted to the attachments/);
});
