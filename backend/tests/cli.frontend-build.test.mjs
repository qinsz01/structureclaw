import { test, expect, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const runtime = require('../../scripts/cli/runtime.js');
const { isFrontendBuildCurrent, runFrontendBuild } = require('../../scripts/cli/frontend-build.js');

test('source startup rebuilds old exports after edits, deletions, or a failed build', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sclaw-frontend-build-'));
  const paths = { frontendDir: dir };
  const put = (file, text = '') => {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const build = jest.spyOn(runtime, 'runCommand').mockImplementation(async () => put('out/index.html', 'compiled'));
  try {
    put('src/page.tsx', 'old controls');
    put('package-lock.json', '{}');
    put('out/index.html', 'legacy export without provenance');
    expect(isFrontendBuildCurrent(paths)).toBe(false);
    await runFrontendBuild(paths, {});
    expect(isFrontendBuildCurrent(paths)).toBe(true);
    put('src/page.tsx', 'new controls');
    expect(isFrontendBuildCurrent(paths)).toBe(false);
    await runFrontendBuild(paths, {});
    expect(isFrontendBuildCurrent(paths)).toBe(true);
    put('src/removed.tsx', 'temporary component');
    await runFrontendBuild(paths, {});
    rmSync(path.join(dir, 'src/removed.tsx'));
    expect(isFrontendBuildCurrent(paths)).toBe(false);
    await runFrontendBuild(paths, {});
    put('package-lock.json', '{"updated":true}');
    expect(isFrontendBuildCurrent(paths)).toBe(false);
    build.mockRejectedValueOnce(new Error('Build failed'));
    await expect(runFrontendBuild(paths, {})).rejects.toThrow('Build failed');
    expect(existsSync(path.join(dir, 'out/.sclaw-build.json'))).toBe(false);
    expect(isFrontendBuildCurrent(paths)).toBe(false);
  } finally {
    build.mockRestore();
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('sclaw-frontend-build-')) throw new Error('Invalid fixture');
    rmSync(dir, { recursive: true, force: true });
  }
});
