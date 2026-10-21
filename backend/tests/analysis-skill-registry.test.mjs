import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILTIN_ANALYSIS_ENGINES,
  BUILTIN_ANALYSIS_RUNTIME_ADAPTER_KEYS,
} from '../dist/agent-skills/analysis/entry.js';
import { AgentSkillCatalogService } from '../dist/services/agent-skill-catalog.js';

const repoRoot = path.resolve(process.cwd(), '..');
const analysisRoot = path.join(repoRoot, 'backend', 'src', 'agent-skills', 'analysis');

describe('analysis skill registry', () => {
  test('solver providers retain their execution paths and are absent from skill selection', async () => {
    const { listProviders } = await import('../dist/providers/catalog.js');
    const solvers = listProviders('solver');
    expect(solvers).toHaveLength(6);
    expect((await new AgentSkillCatalogService().listBuiltinSkills()).every(skill => skill.domain === 'structure-type')).toBe(true);
    for (const solver of solvers) {
      expect(fs.existsSync(path.join(repoRoot, 'backend/src', solver.runtimePath))).toBe(true);
      expect(fs.existsSync(path.join(analysisRoot, solver.id, 'skill.yaml'))).toBe(false);
    }
  });

  test('should derive runtime adapter keys from builtin analysis engines', () => {
    const engineIds = BUILTIN_ANALYSIS_ENGINES.map((engine) => engine.id);
    expect(engineIds).toContain('builtin-opensees');
    expect(engineIds).toContain('builtin-pkpm');
    expect(engineIds).toContain('builtin-yjk');
    expect(BUILTIN_ANALYSIS_RUNTIME_ADAPTER_KEYS).toContain('builtin-opensees');
    expect(BUILTIN_ANALYSIS_RUNTIME_ADAPTER_KEYS).toContain('builtin-pkpm');
    expect(BUILTIN_ANALYSIS_RUNTIME_ADAPTER_KEYS).toContain('builtin-yjk');
    expect(BUILTIN_ANALYSIS_ENGINES.find((e) => e.id === 'builtin-opensees').skillIds).toContain('opensees-static');
    expect(BUILTIN_ANALYSIS_ENGINES.find((e) => e.id === 'builtin-yjk').skillIds).toContain('yjk-static');
    expect(BUILTIN_ANALYSIS_ENGINES.find((e) => e.id === 'builtin-pkpm').skillIds).toContain('pkpm-static');
  });
});
