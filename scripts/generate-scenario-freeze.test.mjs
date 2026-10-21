import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateScenarioFreeze } from './generate-scenario-freeze.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('generator requires review and never overwrites a dated manifest', () => {
  assert.throws(() => generateScenarioFreeze({}), /EXPLICIT_FREEZE_REVIEW_REQUIRED/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-freeze-no-overwrite-'));
  try {
    const output = path.join(directory, 'scenario-freeze-20261013.json');
    fs.writeFileSync(output, 'historical record');
    assert.throws(() => generateScenarioFreeze({ approved: true, reviewedBy: 'test', date: '2026-10-13',
      implementationCommit: 'a'.repeat(40), dependencyTrees: ['backend/node_modules'], nativeFiles: ['native'] }, directory), /ALREADY_EXISTS/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'historical record');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// Integration gate: requires a clean committed tree, both production builds,
// native runtimes and a reviewed inventory. No final manifest is retained.
test('generate current tree twice deterministically, then verify the round trip', {
  skip: !process.env.SCLAW_FREEZE_REVIEW,
}, () => {
  const review = JSON.parse(fs.readFileSync(process.env.SCLAW_FREEZE_REVIEW, 'utf8'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-freeze-roundtrip-'));
  const historical = fs.readFileSync(path.join(root, 'docs/reproducibility/scenario-freeze-20261013.json'));
  try {
    const first = generateScenarioFreeze(review, path.join(directory, 'first'));
    const second = generateScenarioFreeze(review, path.join(directory, 'second'));
    assert.deepEqual(first.manifest, second.manifest);
    const result = JSON.parse(execFileSync(process.execPath, ['scripts/verify-scenario-freeze.mjs', first.path],
      { cwd: root, encoding: 'utf8', windowsHide: true }));
    assert.equal(result.status, 'passed');
    assert.equal(result.implementationCommit, review.implementationCommit);
    assert.deepEqual(fs.readFileSync(path.join(root, 'docs/reproducibility/scenario-freeze-20261013.json')), historical);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
