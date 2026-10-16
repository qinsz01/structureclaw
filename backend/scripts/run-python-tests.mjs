#!/usr/bin/env node
// Run the full backend Python suite (see backend/pytest.ini) with the first
// interpreter that can import pytest. Extra CLI args are forwarded to pytest.
// Lookup order mirrors tests/fixtures/python-command.mjs without needing dist/.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeBaseDir = process.env.SCLAW_DATA_DIR || path.join(os.homedir(), '.structureclaw');
const venvParts = process.platform === 'win32'
  ? ['.venv', 'Scripts', 'python.exe']
  : ['.venv', 'bin', 'python'];

const candidates = [
  process.env.PYTHON_FOR_TEST,
  path.join(backendRoot, ...venvParts),
  path.join(runtimeBaseDir, ...venvParts),
  ...(process.platform === 'win32' ? ['py', 'python3', 'python'] : ['python3', 'python', 'py']),
];

function resolvePytestPython() {
  const visited = new Set();
  for (const raw of candidates) {
    const executable = raw?.trim();
    if (!executable || visited.has(executable)) continue;
    visited.add(executable);
    const args = ['py', 'py.exe'].includes(path.basename(executable).toLowerCase()) ? ['-3'] : [];
    const probe = spawnSync(executable, [...args, '-c', 'import pytest'], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    if (probe.status === 0) return { executable, args };
  }
  return null;
}

const python = resolvePytestPython();
if (!python) {
  console.error('No Python interpreter with pytest found. Tried: ' + candidates.filter(Boolean).join(', '));
  console.error('Install pytest into backend/.venv or set PYTHON_FOR_TEST.');
  process.exit(1);
}

console.log(`Using ${python.executable} ${python.args.join(' ')}`.trim());
const result = spawnSync(python.executable, [...python.args, '-m', 'pytest', ...process.argv.slice(2)], {
  cwd: backendRoot,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
