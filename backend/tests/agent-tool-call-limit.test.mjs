import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('agent tool call limit defaults', () => {
  test('runtime/limits is the single backend source for the 200 tool-call default', async () => {
    const limits = await import('../dist/runtime/limits.js');
    expect(limits.DEFAULT_MAX_TOOL_CALLS_PER_TURN).toBe(200);
    expect(limits.MAX_TOOL_CALLS_PER_TURN_LIMIT).toBe(200);

    const { DEFAULT_RUN_POLICY } = await import('../dist/runtime/run-policy.js');
    expect(DEFAULT_RUN_POLICY.budgets.maxToolCallsPerTurn).toBe(limits.DEFAULT_MAX_TOOL_CALLS_PER_TURN);
  });

  test('backend consumers reference the shared constant instead of a literal', () => {
    const consumers = {
      'src/config/index.ts': 'maxToolCallsPerTurn: DEFAULT_MAX_TOOL_CALLS_PER_TURN',
      'src/api/admin-settings/settings-response.ts': 'agentMaxToolCallsPerTurn: DEFAULT_MAX_TOOL_CALLS_PER_TURN',
      'src/runtime/run-policy.ts': 'maxToolCallsPerTurn: DEFAULT_MAX_TOOL_CALLS_PER_TURN',
      'src/agent-langgraph/agent-service.ts': ': DEFAULT_MAX_TOOL_CALLS_PER_TURN;',
    };
    for (const [file, expected] of Object.entries(consumers)) {
      const source = read(file);
      expect(source).toContain(expected);
      expect(source).not.toMatch(/maxToolCallsPerTurn: 200\b/);
    }
    expect(read('src/agent-langgraph/graph.ts')).not.toContain('DEFAULT_MAX_TOOL_CALLS_PER_TURN = 200');
  });

  test('frontend settings default matches the backend default', () => {
    // The frontend cannot import backend modules, so it keeps its own literal.
    const frontendSettingsSource = read('../frontend/src/components/settings/general-settings-panel.tsx');
    expect(frontendSettingsSource).toContain('maxToolCallsPerTurn: 200');
  });
});
