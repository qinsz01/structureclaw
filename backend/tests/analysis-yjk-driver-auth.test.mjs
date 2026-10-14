import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { resolvePythonCommand } from './fixtures/python-command.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');


describe('YJK driver owned host selection', () => {
  const python = resolvePythonCommand();

  if (!python) {
    test.skip('validates ownership and transport (no Python)', () => {});
    return;
  }

  test('accepts only the direct worker child at the configured executable', () => {
    const script = String.raw`
import importlib.util
import os
from pathlib import Path

driver_path = Path(r"${repoRoot}") / "backend" / "src" / "agent-skills" / "analysis" / "yjk-static" / "yjk_driver.py"
spec = importlib.util.spec_from_file_location("yjk_driver_under_test", driver_path)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

exe = str(Path(r"${repoRoot}") / "private-yjk" / "yjks.exe")
host = {"ProcessId": 55, "ParentProcessId": 44, "ExecutablePath": exe,
        "CommandLine": exe + " -yjkscontrol"}
assert driver._select_owned_host([host], 44, exe) == host
print("ok")
`;

    const result = spawnSync(python.executable, [...python.args, '-c', script], {
      encoding: 'utf8',
      windowsHide: process.platform === 'win32',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  test('rejects unrelated, ambiguous and non-IPC hosts', () => {
    const script = String.raw`
import importlib.util
from pathlib import Path

driver_path = Path(r"${repoRoot}") / "backend" / "src" / "agent-skills" / "analysis" / "yjk-static" / "yjk_driver.py"
spec = importlib.util.spec_from_file_location("yjk_driver_under_test", driver_path)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

exe = str(Path(r"${repoRoot}") / "private-yjk" / "yjks.exe")
host = {"ProcessId": 55, "ParentProcessId": 44, "ExecutablePath": exe,
        "CommandLine": exe + " -yjkscontrol"}
for found in ([], [host, host], [{**host, "ParentProcessId": 10}],
              [{**host, "ExecutablePath": exe + ".other"}],
              [{**host, "CommandLine": exe}]):
    try:
        driver._select_owned_host(found, 44, exe)
    except RuntimeError:
        pass
    else:
        raise AssertionError("Unowned YJK host was accepted")
print("ok")
`;

    const result = spawnSync(python.executable, [...python.args, '-c', script], {
      encoding: 'utf8',
      windowsHide: process.platform === 'win32',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  test('verifies bounded IPC and process isolation with operating system primitives', () => {
    const result = spawnSync(python.executable, [
      ...python.args, path.join(repoRoot, 'backend', 'tests', 'analysis-yjk-transport.py'),
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0, stderr: expect.stringContaining('OK'),
    });
  });
});
