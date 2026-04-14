import { describe, expect, test } from '@jest/globals';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadToolManifestsFromDirectorySync } from '../dist/agent-runtime/tool-manifest-loader.js';
import { loadSkillManifestsFromDirectorySync } from '../dist/agent-runtime/skill-manifest-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, '..', 'src', 'agent-tools');
const SKILL_ROOT = path.resolve(__dirname, '..', 'src', 'agent-skills');

const UTILITY_TOOL_IDS = ['memory', 'planning', 'read_file', 'replace', 'shell', 'write_file'];
const UTILITY_SKILL_IDS = ['memory', 'planning', 'read-file', 'replace', 'shell', 'write-file'];

// ---------------------------------------------------------------------------
// 1. Tool Manifests — loading and Zod validation
// ---------------------------------------------------------------------------
describe('utility tool manifests (tool.yaml)', () => {
  const allTools = loadToolManifestsFromDirectorySync(TOOL_ROOT);
  const utilityTools = allTools.filter((t) => UTILITY_TOOL_IDS.includes(t.id));

  test('all 6 utility tool manifests load successfully', () => {
    const loadedIds = utilityTools.map((t) => t.id).sort();
    expect(loadedIds).toEqual([...UTILITY_TOOL_IDS].sort());
  });

  test('every utility tool has tier=foundation and category=utility', () => {
    for (const tool of utilityTools) {
      expect(tool.tier).toBe('foundation');
      expect(tool.category).toBe('utility');
    }
  });

  test('every utility tool has source=builtin', () => {
    for (const tool of utilityTools) {
      expect(tool.source).toBe('builtin');
    }
  });

  test('every utility tool has bilingual displayName and description', () => {
    for (const tool of utilityTools) {
      expect(tool.displayName.zh.length).toBeGreaterThan(0);
      expect(tool.displayName.en.length).toBeGreaterThan(0);
      expect(tool.description.zh.length).toBeGreaterThan(0);
      expect(tool.description.en.length).toBeGreaterThan(0);
    }
  });

  test('shell tool is not enabled by default', () => {
    const shell = utilityTools.find((t) => t.id === 'shell');
    expect(shell).toBeDefined();
    expect(shell.enabledByDefault).toBe(false);
  });

  test('non-shell utility tools are enabled by default', () => {
    const nonShell = utilityTools.filter((t) => t.id !== 'shell');
    for (const tool of nonShell) {
      expect(tool.enabledByDefault).toBe(true);
    }
  });

  test('replace tool depends on read_file and write_file', () => {
    const replace = utilityTools.find((t) => t.id === 'replace');
    expect(replace).toBeDefined();
    expect(replace.requiresTools).toContain('read_file');
    expect(replace.requiresTools).toContain('write_file');
  });

  test('every utility tool has at least one tag', () => {
    for (const tool of utilityTools) {
      expect(tool.tags.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Skill Manifests — loading and Zod validation
// ---------------------------------------------------------------------------
describe('utility skill manifests (skill.yaml)', () => {
  const allSkills = loadSkillManifestsFromDirectorySync(SKILL_ROOT);
  const utilitySkills = allSkills.filter((s) => UTILITY_SKILL_IDS.includes(s.id));

  test('all 6 utility skill manifests load successfully', () => {
    const loadedIds = utilitySkills.map((s) => s.id).sort();
    expect(loadedIds).toEqual([...UTILITY_SKILL_IDS].sort());
  });

  test('every utility skill belongs to the general domain', () => {
    for (const skill of utilitySkills) {
      expect(skill.domain).toBe('general');
    }
  });

  test('every utility skill has source=builtin', () => {
    for (const skill of utilitySkills) {
      expect(skill.source).toBe('builtin');
    }
  });

  test('every utility skill has bilingual name and description', () => {
    for (const skill of utilitySkills) {
      expect(skill.name.zh.length).toBeGreaterThan(0);
      expect(skill.name.en.length).toBeGreaterThan(0);
      expect(skill.description.zh.length).toBeGreaterThan(0);
      expect(skill.description.en.length).toBeGreaterThan(0);
    }
  });

  test('every utility skill grants exactly one tool', () => {
    for (const skill of utilitySkills) {
      expect(skill.grants.length).toBe(1);
    }
  });

  test('utility skill grants map to corresponding tool IDs', () => {
    const mapping = {
      'memory': 'memory',
      'planning': 'planning',
      'read-file': 'read_file',
      'write-file': 'write_file',
      'replace': 'replace',
      'shell': 'shell',
    };
    for (const skill of utilitySkills) {
      const expectedToolId = mapping[skill.id];
      expect(skill.grants).toContain(expectedToolId);
    }
  });

  test('shell skill is not auto-loaded by default', () => {
    const shell = utilitySkills.find((s) => s.id === 'shell');
    expect(shell).toBeDefined();
    expect(shell.autoLoadByDefault).toBe(false);
  });

  test('non-shell utility skills are auto-loaded by default', () => {
    const nonShell = utilitySkills.filter((s) => s.id !== 'shell');
    for (const skill of nonShell) {
      expect(skill.autoLoadByDefault).toBe(true);
    }
  });

  test('memory skill covers all 4 stages', () => {
    const memory = utilitySkills.find((s) => s.id === 'memory');
    expect(memory).toBeDefined();
    expect(memory.stages).toEqual(expect.arrayContaining(['intent', 'draft', 'analysis', 'design']));
    expect(memory.stages).toHaveLength(4);
  });

  test('write-file skill is restricted to analysis stage', () => {
    const writeFile = utilitySkills.find((s) => s.id === 'write-file');
    expect(writeFile).toBeDefined();
    expect(writeFile.stages).toEqual(['analysis']);
  });

  test('replace skill depends on read-file and write-file', () => {
    const replace = utilitySkills.find((s) => s.id === 'replace');
    expect(replace).toBeDefined();
    expect(replace.requires).toContain('read-file');
    expect(replace.requires).toContain('write-file');
  });

  test('every utility skill has at least one capability', () => {
    for (const skill of utilitySkills) {
      expect(skill.capabilities.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-validation — skill grants reference existing tools
// ---------------------------------------------------------------------------
describe('utility skill-tool cross-validation', () => {
  const allTools = loadToolManifestsFromDirectorySync(TOOL_ROOT);
  const allSkills = loadSkillManifestsFromDirectorySync(SKILL_ROOT);
  const utilitySkills = allSkills.filter((s) => UTILITY_SKILL_IDS.includes(s.id));
  const toolIds = new Set(allTools.map((t) => t.id));

  test('every tool granted by a utility skill exists in tool manifests', () => {
    for (const skill of utilitySkills) {
      for (const toolId of skill.grants) {
        expect(toolIds.has(toolId)).toBe(true);
      }
    }
  });
});
