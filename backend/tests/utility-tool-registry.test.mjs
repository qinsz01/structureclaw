import { describe, expect, test } from '@jest/globals';
import { loadSkillManifestsFromDirectorySync, resolveBuiltinSkillManifestRoot } from '../dist/agent-runtime/skill-manifest-loader.js';
import { listAgentToolDefinitions } from '../dist/agent-langgraph/tool-registry.js';

const CURRENT_TOOL_IDS = [
  'review_input',
  'query_model', 'edit_model', 'undo_model', 'query_results',
  'analyze_file',
  'ask_user_clarification',
  'build_model',
  'calculate',
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

test('tools are not duplicated as selectable skills', () => {
  const skills = loadSkillManifestsFromDirectorySync(resolveBuiltinSkillManifestRoot());
  expect(skills.map(skill => skill.id)).not.toEqual(expect.arrayContaining(['memory', 'shell', 'skill-creation']));
  expect(skills.every(skill => skill.domain === 'structure-type')).toBe(true);
});
