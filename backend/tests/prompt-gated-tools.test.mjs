// Every skill text that can reach an LLM prompt is profile-independent, so a gated tool named in
// one of them would leak into prompts under the profile that removes that tool. Reachable texts:
// manifest names, descriptions and triggers (agent system prompt, structural router) and the stage
// markdown of handler plugins (parameter extractor). Stage markdown of skills without a handler is
// never loaded into a prompt. The prompts actually sent are checked in
// tests/characterization/ablation-profiles.test.mjs.
import { afterAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousDirectory = process.env.SCLAW_DATA_DIR;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-prompt-gated-tools-'));
process.env.SCLAW_DATA_DIR = directory;
const { AgentSkillRuntime } = await import('../dist/agent-runtime/index.js');
const { listAgentToolDefinitions } = await import('../dist/agent-langgraph/tool-registry.js');
const { resolveRunPolicy } = await import('../dist/runtime/run-policy.js');
const { PROFILE_IDS } = await import('../dist/runtime/ablation-profiles.js');
afterAll(() => {
  if (previousDirectory === undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR = previousDirectory;
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test cleanup');
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('prompt fragments never name a profile-gated tool', () => {
  test('skill texts reachable by any prompt do not mention tools a profile removes', async () => {
    const runtime = new AgentSkillRuntime();
    const manifests = await runtime.listSkillManifests();
    const plugins = await runtime.getRegistry().listPlugins();
    const toolIds = listAgentToolDefinitions().map(item => item.id);
    const catalog = { availableSkillIds: manifests.map(item => item.id),
      structureTypeSkillIds: manifests.filter(item => item.domain === 'structure-type').map(item => item.id),
      availableToolIds: toolIds, defaultToolIds: toolIds };
    const full = resolveRunPolicy(catalog);
    const gated = [...new Set(PROFILE_IDS.flatMap(profile => full.activeToolIds
      .filter(id => !resolveRunPolicy({ ...catalog, requested: { profile } }).activeToolIds.includes(id))))].sort();
    expect(gated).toEqual(['ask_user_clarification', 'validate_model']);

    const fragments = [
      ...manifests.flatMap(item => [
        [`${item.id}:name`, `${item.name?.en ?? ''}\n${item.name?.zh ?? ''}`],
        [`${item.id}:description`, `${item.description?.en ?? ''}\n${item.description?.zh ?? ''}`],
        [`${item.id}:triggers`, (item.triggers ?? []).join('\n')],
      ]),
      ...plugins.flatMap(plugin => Object.entries(plugin.markdownByStage ?? {}).map(([stage, text]) => [`${plugin.id}:${stage}.md`, text ?? ''])),
    ];
    expect(plugins.length).toBeGreaterThan(5);
    expect(fragments.some(([id]) => id.endsWith(':draft.md'))).toBe(true);
    const leaks = fragments.flatMap(([id, text]) => gated.filter(tool => text.includes(tool)).map(tool => `${id} -> ${tool}`));
    expect(leaks).toEqual([]);
  });
});
