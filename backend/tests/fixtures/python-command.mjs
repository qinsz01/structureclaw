import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, runtimeBaseDir } from '../../dist/config/index.js';

// Use the product's settings and runtime locations before looking on PATH.
// These tests only execute Python contracts/stubs, never a commercial solver.
export function resolvePythonCommand() {
  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const venvParts = process.platform === 'win32'
    ? ['.venv', 'Scripts', 'python.exe']
    : ['.venv', 'bin', 'python'];
  const candidates = [
    process.env.PYTHON_FOR_TEST,
    config.analysisPythonBin,
    path.join(backendRoot, ...venvParts),
    path.join(runtimeBaseDir, ...venvParts),
    ...(process.platform === 'win32' ? ['py', 'python3', 'python'] : ['python3', 'python', 'py']),
  ];
  const visited = new Set();
  for (const raw of candidates) {
    const executable = raw?.trim();
    if (!executable || visited.has(executable)) continue;
    visited.add(executable);
    const args = ['py', 'py.exe'].includes(path.basename(executable).toLowerCase()) ? ['-3'] : [];
    const result = spawnSync(executable, [...args, '-c', 'import sys; sys.exit(0)'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    if (result.status === 0) return { executable, args };
  }
  return null;
}
