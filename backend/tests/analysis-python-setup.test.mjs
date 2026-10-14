import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), '..');
const require = createRequire(import.meta.url);
const runtime = require(path.join(repoRoot, 'scripts', 'cli', 'runtime.js'));
const cliMain = require(path.join(repoRoot, 'scripts', 'cli', 'main.js'));

describe('analysis python setup', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('CLI uses the configured product Python and rejects a missing explicit path', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-python-setting-'));
    const previous = process.env.SCLAW_DATA_DIR;
    try {
      process.env.SCLAW_DATA_DIR = directory;
      fs.writeFileSync(path.join(directory,'settings.json'), JSON.stringify({analysis:{pythonBin:process.execPath}}));
      const {env} = runtime.loadProjectEnvironment(repoRoot);
      expect(runtime.resolveAnalysisPython(repoRoot,env)).toBe(process.execPath);
      expect(()=>runtime.resolveAnalysisPython(repoRoot,{ANALYSIS_PYTHON_BIN:path.join(directory,'missing-python')})).toThrow('Configured analysis Python does not exist');
    } finally {
      if(previous===undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR=previous;
      fs.rmSync(directory,{recursive:true,force:true});
    }
  });

  test('dependency installation cannot clear a linked node_modules owned by another checkout', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-linked-deps-'));
    const previous = process.env.SCLAW_DATA_DIR;
    const shared=path.join(directory,'shared'), backend=path.join(directory,'backend');
    fs.mkdirSync(shared); fs.mkdirSync(backend);
    fs.mkdirSync(path.join(directory,'frontend')); fs.mkdirSync(path.join(directory,'scripts'));
    fs.writeFileSync(path.join(backend,'package.json'),'{}');
    fs.writeFileSync(path.join(directory,'frontend','package.json'),'{}');
    fs.writeFileSync(path.join(shared,'keep.txt'),'owned by another checkout');
    fs.writeFileSync(path.join(backend,'package-lock.json'),'{}');
    fs.symlinkSync(shared,path.join(backend,'node_modules'),'junction');
    const runCommand=jest.spyOn(runtime,'runCommand').mockResolvedValue(undefined);
    try {
      process.env.SCLAW_DATA_DIR=path.join(directory,'runtime');
      await expect(cliMain.main(['install'],{rootDir:directory})).rejects.toThrow('SHARED_DEPENDENCIES_REQUIRE_OWNER_INSTALL');
      expect(runCommand).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(shared,'keep.txt'),'utf8')).toBe('owned by another checkout');
    } finally {
      if(previous===undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR=previous;
      fs.rmSync(directory,{recursive:true,force:true});
    }
  });

  test('reinstalls analysis requirements when backend/.venv is missing yaml', async () => {
    const paths = runtime.resolvePaths(repoRoot);
    const env = {
      ...process.env,
      SCLAW_PROFILE: 'test',
      SCLAW_PROGRAM_NAME: 'sclaw',
    };
    let yamlInstalled = false;
    const runCommand = jest.spyOn(runtime, 'runCommand').mockImplementation(async (command, args) => {
      if (command === 'uv' && Array.isArray(args) && args.includes('pip') && args.includes('install')) {
        yamlInstalled = true;
      }
    });

    jest.spyOn(runtime, 'loadProjectEnvironment').mockReturnValue({
      paths,
      env,
      dotEnv: {},
    });
    jest.spyOn(runtime, 'resolveAnalysisPython').mockReturnValue('/virtual/backend/.venv/bin/python');
    jest.spyOn(runtime, 'hasCommand').mockReturnValue(true);
    jest.spyOn(runtime, 'pythonModuleExists').mockImplementation(async (_pythonPath, moduleName) => {
      if (moduleName === 'uvicorn') {
        return true;
      }
      if (moduleName === 'yaml') {
        return yamlInstalled;
      }
      return false;
    });
    jest.spyOn(runtime, 'pythonRequirementsSatisfied').mockResolvedValue(true);

    await cliMain.main(['setup-analysis-python'], { rootDir: repoRoot });

    expect(runCommand).not.toHaveBeenCalledWith(
      'uv',
      expect.arrayContaining(['venv']),
    );
    expect(runCommand).toHaveBeenCalledWith(
      'uv',
      expect.arrayContaining([
        'pip',
        'install',
        '--python',
        '/virtual/backend/.venv/bin/python',
        '-r',
        paths.analysisRequirementsFile,
      ]),
      expect.objectContaining({ env }),
    );
  });

  test('reinstalls analysis requirements when package versions drift', async () => {
    const paths = runtime.resolvePaths(repoRoot);
    const env = {
      ...process.env,
      SCLAW_PROFILE: 'test',
      SCLAW_PROGRAM_NAME: 'sclaw',
    };
    let requirementsSynced = false;
    const runCommand = jest.spyOn(runtime, 'runCommand').mockImplementation(async (command, args) => {
      if (command === 'uv' && Array.isArray(args) && args.includes('pip') && args.includes('install')) {
        requirementsSynced = true;
      }
    });

    jest.spyOn(runtime, 'loadProjectEnvironment').mockReturnValue({
      paths,
      env,
      dotEnv: {},
    });
    jest.spyOn(runtime, 'resolveAnalysisPython').mockReturnValue('/virtual/backend/.venv/bin/python');
    jest.spyOn(runtime, 'hasCommand').mockReturnValue(true);
    jest.spyOn(runtime, 'pythonModuleExists').mockResolvedValue(true);
    jest.spyOn(runtime, 'pythonRequirementsSatisfied').mockImplementation(async () => requirementsSynced);

    await cliMain.main(['setup-analysis-python'], { rootDir: repoRoot });

    expect(runCommand).not.toHaveBeenCalledWith(
      'uv',
      expect.arrayContaining(['venv']),
    );
    expect(runCommand).toHaveBeenCalledWith(
      'uv',
      expect.arrayContaining([
        'pip',
        'install',
        '--python',
        '/virtual/backend/.venv/bin/python',
        '-r',
        paths.analysisRequirementsFile,
      ]),
      expect.objectContaining({ env }),
    );
  });

  test('parses inline comments in analysis Python requirements', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-requirements-'));
    const requirementsFile = path.join(tempDir, 'requirements.txt');
    const sysPlatform =
      process.platform === 'win32'
        ? 'win32'
        : process.platform === 'darwin'
          ? 'darwin'
          : 'linux';

    try {
      fs.writeFileSync(
        requirementsFile,
        [
          '# comment',
          'numpy==1.26.4 # pinned dependency',
          `platformpkg==2.0; sys_platform == "${sysPlatform}" # platform marker`,
          `skippedpkg==1.0; sys_platform == "not-${sysPlatform}" # skipped marker`,
          '-r nested.txt',
          '',
        ].join('\n'),
        'utf8',
      );

      expect(runtime.parsePythonRequirements(requirementsFile)).toEqual([
        { name: 'numpy', version: '1.26.4' },
        { name: 'platformpkg', version: '2.0' },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('builds one Python metadata check for all requirements', () => {
    const script = runtime.buildPythonRequirementsCheckScript([
      { name: 'PyYAML', version: '6.0.3' },
      { name: 'pkpm-api', version: null },
    ]);

    expect(script).toContain('json.loads');
    expect(script).toContain('expected_version is not None');
    expect(script).toContain('\\"version\\":null');
  });
});
