#!/usr/bin/env node
// Explicit reviewed freeze operation; never invoked by experiment preflight.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectExecutionBinding, compiledArtifactDigest, dependencyTreeDigest,
  validateScenarioCoverage } from './verify-scenario-freeze.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const runtimePaths = ['backend', 'frontend', 'scripts', 'sclaw', 'sclaw_cn', 'package.json', 'package-lock.json', 'AGENTS.md'];
const planPath = 'docs/reproducibility/scenario-plan-300-20261013.json';
const auditPaths = ['opensees', 'pkpm', 'yjk'].map(engine => `docs/reproducibility/${engine}-scenario-compatibility-20261013.json`);

export function generateScenarioFreeze(review, outputDirectory = path.join(root, 'docs/reproducibility')) {
  if (review?.approved !== true || !/^[a-f0-9]{40}$/.test(review.implementationCommit ?? '')
    || !/^\d{4}-\d{2}-\d{2}$/.test(review.date ?? '') || !review.reviewedBy?.trim()
    || !Array.isArray(review.dependencyTrees) || !review.dependencyTrees.length
    || !Array.isArray(review.nativeFiles) || !review.nativeFiles.length) throw Error('EXPLICIT_FREEZE_REVIEW_REQUIRED');
  if (new Date(`${review.date}T00:00:00Z`).toISOString().slice(0, 10) !== review.date) throw Error('INVALID_FREEZE_DATE');
  const output = path.resolve(outputDirectory, `scenario-freeze-${review.date.replaceAll('-', '')}.json`);
  if (fs.existsSync(output)) throw Error('FREEZE_MANIFEST_ALREADY_EXISTS');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (git(['rev-parse', 'HEAD']).trim() !== review.implementationCommit) throw Error('REVIEWED_COMMIT_IS_NOT_HEAD');
  if (git(['diff', '--name-only', 'HEAD', '--', ...runtimePaths]).trim()
    || git(['ls-files', '--others', '--exclude-standard', '--', ...runtimePaths]).trim()) throw Error('FREEZE_REQUIRES_CLEAN_RUNTIME_TREE');
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  validateScenarioCoverage(read(planPath), auditPaths.map(read), { planBytes: fs.readFileSync(path.join(root, planPath)) });
  const evidencePaths = [...new Set([planPath, ...auditPaths, ...(review.evidenceFiles ?? [])])].sort();
  const evidenceFiles = evidencePaths.map(file => {
    const relative = path.relative(root, path.resolve(root, file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('EVIDENCE_PATH_OUTSIDE_REPOSITORY');
    const bytes = fs.readFileSync(path.resolve(root, file));
    const json = file.endsWith('.json');
    return { path: file, hashMode: json ? 'canonical-json' : 'bytes',
      sha256: sha(json ? JSON.stringify(JSON.parse(bytes.toString('utf8'))) : bytes) };
  });
  const manifest = {
    schemaVersion: 1, status: 'scenario-compatible-frozen', date: review.date,
    review: { reviewedBy: review.reviewedBy, implementationCommit: review.implementationCommit },
    scope: 'Reviewed tool capability and implementation; not benchmark accuracy or completed Bench tasks.',
    implementationCommit: review.implementationCommit,
    runtimeTreeSha256: sha(git(['ls-tree', '-r', '--full-tree', review.implementationCommit, '--', ...runtimePaths])),
    nodeVersion: process.version, compiledArtifacts: compiledArtifactDigest(root),
    dependencyTrees: [...new Set(review.dependencyTrees)].sort().map(file => ({ path: file, ...dependencyTreeDigest(path.resolve(root, file)) })),
    executionBinding: collectExecutionBinding(root, { workingDirectory: review.workingDirectory ?? path.join(root, 'backend') }),
    evidenceFiles,
    nativeFiles: [...new Set(review.nativeFiles)].sort().map(file => ({ path: path.resolve(root, file), sha256: sha(fs.readFileSync(path.resolve(root, file))) })),
  };
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-freeze-candidate-'));
  try {
    const candidate = path.join(temporary, 'candidate.json');
    fs.writeFileSync(candidate, bytes, { flag: 'wx' });
    // The unchanged read-only verifier is the acceptance authority.
    try {
      execFileSync(process.execPath, [path.join(root, 'scripts/verify-scenario-freeze.mjs'), candidate],
        { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      let reason = 'FREEZE_CANDIDATE_VERIFICATION_FAILED';
      try { reason = JSON.parse(String(error.stderr)).reason ?? reason; } catch { /* Never emit child buffers. */ }
      throw Error(reason);
    }
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(output, bytes, { flag: 'wx' });
    return { path: output, manifest };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw Error('Usage: node scripts/generate-scenario-freeze.mjs <review.json> [output-directory]');
    const result = generateScenarioFreeze(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3]);
    console.log(JSON.stringify({ status: 'passed', path: result.path, implementationCommit: result.manifest.implementationCommit }));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', reason: error.message }));
    process.exitCode = 1;
  }
}
