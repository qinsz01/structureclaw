import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

describe('agent recursion limit configuration', () => {
  test('agent service passes configured recursionLimit to LangGraph runs', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/agent-langgraph/agent-service.ts'), 'utf8');

    expect(source).toContain('recursionLimit: appConfig.agentRecursionLimit');
    expect(source.match(/recursionLimit: appConfig\.agentRecursionLimit/g)).toHaveLength(4);
  });

  test('settings and config expose agentRecursionLimit defaulting to 200', () => {
    const configSource = fs.readFileSync(path.join(ROOT, 'src/config/index.ts'), 'utf8');
    const settingsSource = fs.readFileSync(path.join(ROOT, 'src/config/settings-file.ts'), 'utf8');

    expect(configSource).toContain('recursionLimit: 200');
    expect(configSource).toContain('AGENT_RECURSION_LIMIT');
    expect(configSource).toContain('agentRecursionLimit');
    expect(settingsSource).toContain('recursionLimit?: number');
    expect(settingsSource).toContain('record.recursionLimit');
  });
});
