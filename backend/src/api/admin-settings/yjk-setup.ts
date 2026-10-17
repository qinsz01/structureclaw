/** YJK auto-configuration helpers: install discovery, SDK retrieval and command execution. */
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runtimeBaseDir } from '../../config/index.js';
import type { SettingsFileYjk, SettingsFile } from '../../config/settings-file.js';

export type YjkAutoConfigureStep = {
  name: string;
  status: 'applied' | 'skipped';
  details?: string;
};

const YJK_API_REPO_URL = 'https://gitee.com/yjk-opensource/yjkapi_-python.git';
const YJK_API_BRANCH = '8.0';
const DEFAULT_YJK_COMMAND_TIMEOUT_MS = 300000;

export function findYjkExe(installRoot: string): string | undefined {
  for (const name of ['yjks.exe', 'YJKS.exe']) {
    const candidate = path.join(installRoot, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

export function findYjkPython(installRoot: string): string | undefined {
  for (const relative of [
    path.join('Python310', 'python.exe'),
    path.join('python310', 'python.exe'),
  ]) {
    const candidate = path.join(installRoot, relative);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

export function copyYjkSdkIntoInstallRoot(sdkSource: string, installRoot: string): number {
  const entries = fs.readdirSync(sdkSource, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(sdkSource, entry.name);
    const target = path.join(installRoot, entry.name);
    try {
      fs.cpSync(source, target, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to copy YJKAPI SDK file "${entry.name}" into ${installRoot}: ${message}. `
        + 'Close YJK and any YJK bundled Python processes, then try again.',
        { cause: error },
      );
    }
  }
  return entries.length;
}

function yjkCommandTimeoutMs(): number {
  const parsed = Number(process.env.YJK_AUTO_CONFIG_COMMAND_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_YJK_COMMAND_TIMEOUT_MS;
}

export function assertYjkInstallNotRunning(installRoot: string): void {
  if (process.platform !== 'win32') return;

  const script = [
    "$names = @('yjks.exe','python.exe','pythonw.exe')",
    "$root = [System.IO.Path]::GetFullPath($env:YJK_AUTO_CONFIG_INSTALL_ROOT).TrimEnd('\\')",
    "$items = Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name -and $_.ExecutablePath } | ForEach-Object {",
    "  $exe = [System.IO.Path]::GetFullPath($_.ExecutablePath)",
    "  if ($exe.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {",
    "    [PSCustomObject]@{ Name = $_.Name; ProcessId = $_.ProcessId; ExecutablePath = $exe }",
    "  }",
    "}",
    "$items | ConvertTo-Json -Compress",
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, YJK_AUTO_CONFIG_INSTALL_ROOT: installRoot },
    timeout: 10000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return;

  const output = result.stdout.trim();
  if (!output) return;

  let processes: Array<{ Name?: string; ProcessId?: number; ExecutablePath?: string }>;
  try {
    const parsed = JSON.parse(output) as unknown;
    processes = Array.isArray(parsed) ? parsed : [parsed as { Name?: string; ProcessId?: number; ExecutablePath?: string }];
  } catch {
    return;
  }
  const activeProcesses = processes
    .filter((item) => typeof item.Name === 'string' && typeof item.ExecutablePath === 'string');
  if (activeProcesses.length === 0) return;

  const pythonDir = path.join(installRoot, 'python310');
  const pythonDirAlt = path.join(installRoot, 'Python310');
  const activeNames = activeProcesses
    .map((item) => `${item.Name}${item.ProcessId ? `:${item.ProcessId}` : ''}`)
    .join(', ');
  const message = [
    `YJK appears to be running (${activeNames}).`,
    `The SDK copy step needs exclusive access to ${pythonDir} / ${pythonDirAlt}.`,
    'Close YJK and stop YJK bundled Python processes before running Auto Configure again.',
  ].join(' ');
  throw new Error(message);
}

function runRequiredCommand(command: string, args: string[], cwd?: string, timeoutMs = yjkCommandTimeoutMs()): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${output ? `: ${output}` : ''}`);
  }
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function runOptionalCommand(command: string, args: string[], cwd?: string, timeoutMs = 10000): string | undefined {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim();
}

function existingExecutable(candidates: string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function resolveGitCommand(): string | undefined {
  const configured = process.env.GIT_BIN?.trim();
  if (configured) {
    if (!fs.existsSync(configured) || !fs.statSync(configured).isFile()) {
      throw new Error(`GIT_BIN points to a missing git executable: ${configured}`);
    }
    return configured;
  }

  const commonWindowsGit = process.platform === 'win32'
    ? existingExecutable([
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe',
    ])
    : undefined;
  if (commonWindowsGit) return commonWindowsGit;

  const probe = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return probe.error ? undefined : 'git';
}

function findRarExtractor(): { command: string; args: (archive: string, outputDir: string) => string[] } {
  const configured = process.env.YJK_7Z_BIN?.trim() || process.env.YJK_RAR_EXTRACTOR?.trim();
  if (configured) {
    // Environment override intentionally uses 7-Zip-compatible CLI arguments:
    // `x -y -o<outputDir> <archive>`.
    return { command: configured, args: (archive, outputDir) => ['x', '-y', `-o${outputDir}`, archive] };
  }

  const candidates = [
    {
      command: '7z',
      args: (archive: string, outputDir: string) => ['x', '-y', `-o${outputDir}`, archive],
    },
    {
      command: '7za',
      args: (archive: string, outputDir: string) => ['x', '-y', `-o${outputDir}`, archive],
    },
    {
      command: 'UnRAR',
      args: (archive: string, outputDir: string) => ['x', '-y', archive, `${outputDir}${path.sep}`],
    },
    {
      command: 'WinRAR',
      args: (archive: string, outputDir: string) => ['x', '-y', archive, `${outputDir}${path.sep}`],
    },
  ];

  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (!probe.error) return candidate;
  }

  throw new Error('A RAR extractor was not found. Install 7-Zip/WinRAR or set YJK_7Z_BIN to a 7-Zip-compatible extractor.');
}

export function yjkApiBranch(): string {
  return process.env.YJK_API_REPO_BRANCH?.trim() || YJK_API_BRANCH;
}

function safeCacheSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolveYjkApiCacheDir(branch: string): string {
  return path.join(runtimeBaseDir, 'cache', 'yjkapi', safeCacheSegment(branch));
}

function syncYjkApiPublicRepo(steps: YjkAutoConfigureStep[]): string | undefined {
  const repoUrl = process.env.YJK_API_REPO_URL?.trim() || YJK_API_REPO_URL;
  const branch = yjkApiBranch();
  const gitCommand = resolveGitCommand();
  if (!gitCommand) {
    steps.push({
      name: 'Clone YJKAPI public repository',
      status: 'skipped',
      details: 'Git was not found. Use a local official SDK archive path for no-Git setup.',
    });
    return undefined;
  }

  const cacheDir = resolveYjkApiCacheDir(branch);
  const repoDir = path.join(cacheDir, 'repo');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  if (fs.existsSync(path.join(repoDir, '.git'))) {
    const originUrl = runOptionalCommand(gitCommand, ['remote', 'get-url', 'origin'], repoDir, 10000);
    if (originUrl !== repoUrl) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } else {
      runRequiredCommand(gitCommand, ['fetch', '--depth', '1', 'origin', branch], repoDir);
      runRequiredCommand(gitCommand, ['checkout', branch], repoDir);
      runRequiredCommand(gitCommand, ['reset', '--hard', `origin/${branch}`], repoDir);
      steps.push({
        name: 'Update YJKAPI public repository cache',
        status: 'applied',
        details: `${repoUrl}#${branch}`,
      });
      return repoDir;
    }
  }

  if (fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  runRequiredCommand(gitCommand, ['clone', '--depth', '1', '--branch', branch, repoUrl, repoDir]);
  steps.push({
    name: 'Clone YJKAPI public repository',
    status: 'applied',
    details: `${repoUrl}#${branch}`,
  });
  return repoDir;
}

export function resolveYjkSdkSourceFromPublicRepo(steps: YjkAutoConfigureStep[]): string | undefined {
  const branch = yjkApiBranch();
  const repoDir = syncYjkApiPublicRepo(steps);
  if (!repoDir) return undefined;

  const archivePath = path.join(repoDir, 'SDK', `${branch}.rar`);
  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    throw new Error(`YJKAPI SDK archive was not found in public repository cache: ${archivePath}`);
  }

  const extractedDir = path.join(resolveYjkApiCacheDir(branch), `sdk-${safeCacheSegment(branch)}`);
  fs.rmSync(extractedDir, { recursive: true, force: true });
  fs.mkdirSync(extractedDir, { recursive: true, mode: 0o700 });

  const extractor = findRarExtractor();
  runRequiredCommand(extractor.command, extractor.args(archivePath, extractedDir));

  const entries = fs.readdirSync(extractedDir);
  if (entries.length === 0) {
    throw new Error(`YJKAPI SDK archive extracted no files: ${archivePath}`);
  }

  const sdkRoot = entries.length === 1 && entries[0] === branch
    && fs.statSync(path.join(extractedDir, branch)).isDirectory()
    ? path.join(extractedDir, branch)
    : extractedDir;

  steps.push({
    name: 'Extract YJKAPI SDK archive',
    status: 'applied',
    details: `${archivePath} -> ${sdkRoot}`,
  });

  return sdkRoot;
}

export function extractYjkSdkArchive(archivePath: string, branch: string, steps: YjkAutoConfigureStep[]): string {
  const resolvedArchive = path.resolve(archivePath);
  if (!fs.existsSync(resolvedArchive) || !fs.statSync(resolvedArchive).isFile()) {
    throw new Error(`YJKAPI SDK archive does not exist: ${resolvedArchive}`);
  }

  const extractedDir = path.join(resolveYjkApiCacheDir(branch), `sdk-${safeCacheSegment(branch)}-local`);
  fs.rmSync(extractedDir, { recursive: true, force: true });
  fs.mkdirSync(extractedDir, { recursive: true, mode: 0o700 });

  const extractor = findRarExtractor();
  runRequiredCommand(extractor.command, extractor.args(resolvedArchive, extractedDir));

  const entries = fs.readdirSync(extractedDir);
  if (entries.length === 0) {
    throw new Error(`YJKAPI SDK archive extracted no files: ${resolvedArchive}`);
  }

  const sdkRoot = entries.length === 1 && entries[0] === branch
    && fs.statSync(path.join(extractedDir, branch)).isDirectory()
    ? path.join(extractedDir, branch)
    : extractedDir;

  steps.push({
    name: 'Extract local YJKAPI SDK archive',
    status: 'applied',
    details: `${resolvedArchive} -> ${sdkRoot}`,
  });

  return sdkRoot;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const normalized = path.resolve(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function resolveYjkInstallRoot(input: SettingsFileYjk | undefined, current: SettingsFile): string {
  const explicitRoot = input?.installRoot?.trim() || current.yjk?.installRoot?.trim();
  if (explicitRoot) {
    const resolved = path.resolve(explicitRoot);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`YJK install root does not exist: ${resolved}`);
    }
    return resolved;
  }

  const explicitExe = input?.exePath?.trim() || current.yjk?.exePath?.trim();
  if (explicitExe) {
    const resolvedExe = path.resolve(explicitExe);
    if (!fs.existsSync(resolvedExe) || !fs.statSync(resolvedExe).isFile()) {
      throw new Error(`yjks.exe path does not exist: ${resolvedExe}`);
    }
    return path.dirname(resolvedExe);
  }

  const candidates = uniqueStrings([
    process.env.YJK_PATH,
    process.env.YJKS_ROOT,
    'C:\\YJKS\\YJKS_8_0_0',
    'D:\\YJKS\\YJKS_8_0_0',
  ]);
  const detected = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
  if (!detected) {
    throw new Error('YJK install root was not provided and no default YJK 8.0 directory was found.');
  }
  return detected;
}
