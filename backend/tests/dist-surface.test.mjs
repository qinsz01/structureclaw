// Guards the compiled `backend/dist` surface consumed outside backend/src:
// tests/llm-benchmark (runner.cjs, external/openclaw/*, scripts/check-representative-pack.mjs),
// integrations/openclaw (worker.mjs, __tests__/bridge.test.mjs), tests/regression/backend-validations.js,
// scripts/verify-scenario-freeze.mjs and backend/scripts/export-bench-member-responses.mjs.
// Refactors may move code, but these paths and symbols must stay importable (re-export shims allowed).
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** Module path (relative to dist) -> exported symbol -> expected typeof. Empty table: module must import. */
const DIST_SURFACE = {
  'agent-runtime/index.js': { AgentSkillRuntime: 'function' },
  'agent-runtime/manifest-schema.js': { skillManifestFileSchema: 'object' },
  'agent-runtime/skill-manifest-loader.js': { loadSkillManifestsFromDirectory: 'function' },
  'agent-langgraph/agent-service.js': { LangGraphAgentService: 'function' },
  'agent-langgraph/tool-registry.js': { createRegisteredTools: 'function', listAgentToolDefinitions: 'function' },
  'agent-langgraph/attachment-vision.js': { summarizeFileImages: 'function' },
  'agent-langgraph/public-tool-contracts.js': {
    applyPublicToolStateUpdate: 'function',
    getPublicToolDefinitions: 'function',
    createPublicToolSession: 'function',
    inspectPublicToolSession: 'function',
    recoverPublicToolSession: 'function',
  },
  // Hashed as files by check-representative-pack.mjs.
  'agent-langgraph/model-tools.js': {},
  'agent-langgraph/tools.js': {},
  'runtime/policy-settings.js': { resolveApplicationRunPolicy: 'function' },
  'config/index.js': { config: 'object', runtimeBaseDir: 'string' },
  'config/settings-file.js': { readSettingsFileForUpdate: 'function' },
  'utils/python-worker-runner.js': { PythonWorkerRunner: 'function', resolveWorkerPath: 'function' },
  'utils/database.js': { prisma: 'object' },
  'services/agent-skill-catalog.js': { AgentSkillCatalogService: 'function' },
  'services/analysis-engine.js': { AnalysisEngineCatalogService: 'function' },
  // backend-validations asserts these modules import but expose no static metadata helpers.
  'agent-skills/analysis/entry.js': {},
  'agent-skills/analysis/registry.js': {},
  'api/agent.js': { agentRoutes: 'function' },
  'api/chat.js': { chatRoutes: 'function' },
  'api/files.js': { fileRoutes: 'function' },
  'skill-shared/member-response.js': { recoverMemberResponses: 'function' },
  'engineering/model-boundary.js': { normalizeEngineeringModel: 'function' },
  'engineering/model-state.js': { commitModel: 'function' },
};

const AGENT_SERVICE_STATICS = ['getProtocol'];
const AGENT_SERVICE_METHODS = ['run', 'runStream', 'resumeStream', 'runFull', 'getConversationSessionSnapshot'];
// The benchmark solver gate and OpenClaw plugin read (and swap) these instance clients.
const AGENT_SERVICE_CLIENTS = ['engineClient', 'codeCheckClient', 'structureProtocolClient'];

const loadDist = (relative) => import(pathToFileURL(path.join(DIST, relative)).href);

let previousDataDir;
let tempDataDir;

beforeAll(() => {
  previousDataDir = process.env.SCLAW_DATA_DIR;
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-dist-surface-'));
  process.env.SCLAW_DATA_DIR = tempDataDir;
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.SCLAW_DATA_DIR;
  else process.env.SCLAW_DATA_DIR = previousDataDir;
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

describe('backend dist surface consumed outside backend/src', () => {
  test.each(Object.entries(DIST_SURFACE))('%s exports the expected symbols', async (relative, symbols) => {
    expect(fs.existsSync(path.join(DIST, relative))).toBe(true);
    const mod = await loadDist(relative);
    const actual = Object.fromEntries(Object.keys(symbols).map((name) => [name, typeof mod[name]]));
    expect(actual).toEqual(symbols);
  });

  test('AgentSkillRuntime exposes listSkillManifests', async () => {
    const { AgentSkillRuntime } = await loadDist('agent-runtime/index.js');
    expect(typeof AgentSkillRuntime.prototype.listSkillManifests).toBe('function');
  });

  test('LangGraphAgentService keeps its static, prototype and instance surface', async () => {
    const { AgentSkillRuntime } = await loadDist('agent-runtime/index.js');
    const { LangGraphAgentService } = await loadDist('agent-langgraph/agent-service.js');
    for (const name of AGENT_SERVICE_STATICS) expect(typeof LangGraphAgentService[name]).toBe('function');
    for (const name of AGENT_SERVICE_METHODS) expect(typeof LangGraphAgentService.prototype[name]).toBe('function');

    const service = new LangGraphAgentService(new AgentSkillRuntime());
    for (const name of AGENT_SERVICE_CLIENTS) expect(typeof service[name]).toBe('object');
    expect(typeof service.engineClient.get).toBe('function');
    expect(typeof service.engineClient.post).toBe('function');
  });
});
