// Opt-in host registration check. No Gateway, LLM, solver, or user config writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = process.argv[2];
if (!entry || !fs.existsSync(entry)) throw new Error('Pass the installed OpenClaw openclaw.mjs entry');
const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(process.argv[3] ?? os.tmpdir(), 'sclaw-openclaw-loader-'));
const configFile = path.join(work, 'openclaw.json');
fs.writeFileSync(configFile, JSON.stringify({
  plugins: { allow: ['structureclaw'], load: { paths: [plugin] }, entries: { structureclaw: {
    enabled: true, config: { structureclawRoot: path.resolve(plugin, '../..'), dataDir: path.join(work, 'application'),
      runPolicy: { skillIds: [], tools: { enabledIds: ['calculate', 'query_model', 'analyze_file'] } } },
  } } }, tools: { allow: ['structureclaw'] },
  agents: { defaults: { workspace: path.join(work, 'workspace') } },
}, null, 2));
const result = spawnSync(process.execPath, [entry, 'plugins', 'inspect', 'structureclaw', '--runtime', '--json'], {
  encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', OPENCLAW_STATE_DIR: path.join(work, 'host-state'), OPENCLAW_CONFIG_PATH: configFile },
});
fs.writeFileSync(path.join(work, 'stdout.txt'), result.stdout ?? '');
fs.writeFileSync(path.join(work, 'stderr.txt'), result.stderr ?? '');
const receipt = { version: 1, status: result.status, error: result.error?.message,
  hostPackage: JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version,
  node: process.version, plugin, action: 'plugins inspect structureclaw --runtime --json',
  isolatedConfig: configFile, work, gatewayStarted: false, modelCalls: 0, solverCalls: 0 };
try {
  const output = JSON.parse(result.stdout);
  receipt.registeredTools = output.tools.flatMap(tool => tool.names).sort();
  receipt.diagnostics = output.diagnostics;
  receipt.registrationVerified = result.status === 0
    && JSON.stringify(receipt.registeredTools) === JSON.stringify(['sclaw_analyze_file', 'sclaw_calculate', 'sclaw_query_model', 'sclaw_session'])
    && output.diagnostics.length === 0;
} catch { receipt.registrationVerified = false; }
fs.writeFileSync(path.join(work, 'receipt.json'), JSON.stringify(receipt, null, 2));
process.stdout.write(`${JSON.stringify(receipt)}\n`);
process.exitCode = receipt.registrationVerified ? 0 : 1;
