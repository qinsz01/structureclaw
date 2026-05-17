import { describe, expect, test } from '@jest/globals';
import { loadSkillManifestsFromDirectorySync, resolveBuiltinSkillManifestRoot } from '../dist/agent-runtime/skill-manifest-loader.js';
import { listAgentToolDefinitions } from '../dist/agent-langgraph/tool-registry.js';
import path from 'node:path';

const REMAINING_GENERAL_SKILL_IDS = ['memory', 'shell', 'skill-creation'];
const CURRENT_TOOL_IDS = [
  'analyze_file',
  'ask_user_clarification',
  'build_model',
  'calculate',
  'detached_house_build_analysis_model',
  'detached_house_classify_floor_roles',
  'detached_house_derive_global_constraints_from_layout',
  'detached_house_generate_beam_layout',
  'detached_house_generate_column_grid',
  'detached_house_generate_floor_rooms',
  'detached_house_generate_floor_walls',
  'detached_house_place_doors_windows',
  'detached_house_propagate_floor_rooms',
  'detached_house_reconcile_global_constraints',
  'detached_house_create_design_basis',
  'detached_house_size_members',
  'detached_house_validate_residential_design',
  'detect_structure_type',
  'extract_draft_params',
  'generate_report',
  'glob_files',
  'grep_files',
  'memory',
  'move_path',
  'read_file',
  'replace_in_file',
  'run_analysis',
  'run_code_check',
  'set_session_config',
  'shell',
  'validate_model',
  'write_file',
  'delete_path',
];

describe('code-owned agent tool registry', () => {
  const tools = listAgentToolDefinitions();

  test('current LangGraph tools are registered in code', () => {
    expect(tools.map((tool) => tool.id).sort()).toEqual([...CURRENT_TOOL_IDS].sort());
  });

  test('every tool has bilingual metadata', () => {
    for (const tool of tools) {
      expect(tool.displayName.zh.length).toBeGreaterThan(0);
      expect(tool.displayName.en.length).toBeGreaterThan(0);
      expect(tool.description.zh.length).toBeGreaterThan(0);
      expect(tool.description.en.length).toBeGreaterThan(0);
    }
  });

  test('session config uses the canonical set_session_config id', () => {
    expect(tools.some((tool) => tool.id === 'set_session_config')).toBe(true);
    expect(tools.some((tool) => tool.id === 'update_session_config')).toBe(false);
  });
});

describe('general skill manifests load correctly', () => {
  const allSkills = loadSkillManifestsFromDirectorySync(path.join(resolveBuiltinSkillManifestRoot(), 'general'));
  const generalSkills = allSkills.filter((skill) => REMAINING_GENERAL_SKILL_IDS.includes(skill.id));

  test('remaining general skill manifests load successfully', () => {
    expect(generalSkills.map((skill) => skill.id).sort()).toEqual([...REMAINING_GENERAL_SKILL_IDS].sort());
  });

  test('general skills retain general-domain metadata', () => {
    for (const skill of generalSkills) {
      expect(skill.domain).toBe('general');
      expect(skill.source).toBe('builtin');
      expect(skill.name.zh.length).toBeGreaterThan(0);
      expect(skill.name.en.length).toBeGreaterThan(0);
      expect(skill.description.zh.length).toBeGreaterThan(0);
      expect(skill.description.en.length).toBeGreaterThan(0);
      expect(skill.capabilities.length).toBeGreaterThan(0);
    }
  });
});
