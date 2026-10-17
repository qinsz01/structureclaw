import { afterAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousDirectory = process.env.SCLAW_DATA_DIR;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-policy-resolver-'));
process.env.SCLAW_DATA_DIR = directory;
const { resolveApplicationRunPolicy, skillCatalog, catalogStructureTypeSkillIds } = await import('../../../dist/agent-langgraph/policy-resolver.js');
const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
afterAll(() => {
  if (previousDirectory === undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR = previousDirectory;
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test cleanup');
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('resolveApplicationRunPolicy skill catalog', () => {
  test('derives structure-type skill ids from the manifests when the caller omits them', async () => {
    const catalog = skillCatalog(await new AgentSkillRuntime().listSkillManifests());
    expect(catalogStructureTypeSkillIds()).toEqual([...catalog.structureTypeSkillIds].sort());
    // Turn 1 selects generic-only with the full catalog; the saved policy carries profileId.
    const saved = resolveApplicationRunPolicy({ ...catalog, requested: { profile: 'generic-only' } });
    expect(saved.profileId).toBe('generic-only');
    // A later caller (job projection, input review, integration) passes only the skill ids.
    const next = resolveApplicationRunPolicy({ availableSkillIds: catalog.availableSkillIds, previous: saved });
    expect(next.profileId).toBe('generic-only');
    expect(next.activeSkillIds).toEqual(saved.activeSkillIds);
    expect(next.activeSkillIds).toContain('generic');
    expect(next.activeSkillIds).not.toContain('beam');
    expect(next.policyHash).toBe(saved.policyHash);
    expect(next).not.toHaveProperty('profileOverrides');
  });
});
