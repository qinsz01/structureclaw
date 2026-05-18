import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

describe('detached-house API timeout default', () => {
  test('allows long-running LLM-backed detached-house tools by default', () => {
    const configSource = fs.readFileSync(path.join(ROOT, 'src/config/index.ts'), 'utf8');
    const clientSource = fs.readFileSync(path.join(ROOT, 'src/services/detached-house-api-client.ts'), 'utf8');

    expect(configSource).toContain('timeoutMs: 1800000');
    expect(clientSource).toContain('args.timeoutMs ?? 1800000');
  });
});
