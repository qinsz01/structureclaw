#!/usr/bin/env node
// Read-only experiment preflight. This never repairs or updates the frozen system.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = process.argv[2] ?? 'docs/reproducibility/scenario-freeze-20261013.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });

const sortedJson = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});

/** Validate the audited source, not just the number of rows. planBytes are the
 * archived bytes; LF-normalization accommodates a CRLF Git checkout only.
 */
export function validateScenarioCoverage(plan, audits, { planBytes } = {}) {
  const expectedIds = ['STD', 'INT', 'MM'].flatMap(prefix => Array.from({ length: 100 },
    (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`));
  if (!Array.isArray(plan?.tasks) || !Array.isArray(plan?.models) || !Array.isArray(audits)
    || audits.length !== 3) throw Error('INCOMPLETE_SCENARIO_COVERAGE');
  const tasks = new Map(plan.tasks.map(task => [task.id, task]));
  const models = new Map(plan.models.map(model => [model.taskId, model]));
  const rows = audits.flatMap(audit => audit.scenarios ?? audit.rows ?? []);
  if (tasks.size !== 300 || plan.tasks.length !== 300 || models.size !== 300 || plan.models.length !== 300
    || new Set(plan.models.map(model => model.id)).size !== 300
    || rows.length !== 300 || new Set(rows.map(row => row.id)).size !== 300
    || expectedIds.some(id => !tasks.has(id) || !rows.some(row => row.id === id)
      || !models.get(id)?.id || models.get(id).id !== tasks.get(id)?.baseGroup)) {
    throw Error('INCOMPLETE_SCENARIO_COVERAGE');
  }
  for (const [engine, count] of Object.entries({ OpenSees: 267, PKPM: 16, YJK: 17 })) {
    if (plan.tasks.filter(task => task.enginePlan?.plannedEngine === engine).length !== count) {
      throw Error(`PLANNED_ENGINE_ASSIGNMENT_CHANGED: ${engine}`);
    }
  }
  if (planBytes === undefined || sortedJson(JSON.parse(String(planBytes))) !== sortedJson(plan)) {
    throw Error('SCENARIO_SOURCE_BYTES_REQUIRED');
  }
  const sourceHashes = [sha(planBytes), sha(String(planBytes).replace(/\r\n/g, '\n'))];
  for (const audit of audits) {
    const source = audit.sourceSnapshot ?? audit.sourcePlan;
    if (!source || !sourceHashes.includes(source.sha256)) throw Error('AUDIT_SOURCE_SNAPSHOT_MISMATCH');
    const auditRows = audit.scenarios ?? audit.rows ?? [];
    const engines = new Set(auditRows.map(row => row.plannedEngine));
    if (engines.size !== 1 || (audit.plannedEngine && !engines.has(audit.plannedEngine))) {
      throw Error('AUDIT_ENGINE_MISMATCH');
    }
  }
  const unresolved = rows.filter(row => {
    const task = tasks.get(row.id);
    const model = models.get(row.id);
    const source = row.source ?? row.sourcePlan;
    return row.scenarioCompatible !== true || row.plannedEngine !== task?.enginePlan?.plannedEngine
      || (source?.modelId ?? row.baseGroup) !== model?.id
      || (source?.taskId !== undefined && source.taskId !== row.id)
      || (source?.taskSha256 !== undefined && source.taskSha256 !== sha(sortedJson(task)))
      || (source?.modelSha256 !== undefined && source.modelSha256 !== sha(sortedJson(model)))
      || !Array.isArray(row.requiredCapabilities) || !row.requiredCapabilities.length
      || row.requiredCapabilities.some(value => typeof value !== 'string' || !value.trim())
      || !Array.isArray(row.evidence) || !row.evidence.length
      || row.evidence.some(value => typeof value !== 'string' || !value.trim())
      || !Array.isArray(row.unresolvedToolGaps) || row.unresolvedToolGaps.length;
  });
  if (unresolved.length) throw Error(`SCENARIO_TOOL_GAPS_REMAIN: ${unresolved.map(row => row.id).join(', ')}`);
  return { scenarioCount: rows.length, engineCounts: { OpenSees: 267, PKPM: 16, YJK: 17 } };
}

// Probe module resolution without importing any commercial SDK or running an
// analysis. Execute the actual worker's bootstrap statements, not a second copy
// of its path policy. The YJK module top levels only declare driver functions.
const pythonBindingProbe = String.raw`
import ast, hashlib, importlib.util, json, os, runpy, sys
from pathlib import Path
request = json.load(sys.stdin)
def file_record(filename):
    p = Path(filename).resolve()
    return {'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None}
if request['mode'] == 'analysis':
    worker = Path(request['worker']).resolve()
    if sys.path and sys.path[0] == '':
        sys.path[0] = str(worker.parent)
    tree = ast.parse(worker.read_text(encoding='utf-8'))
    start = next(i for i,n in enumerate(tree.body) if isinstance(n,ast.Assign)
                 and any(isinstance(t,ast.Name) and t.id=='CURRENT_DIR' for t in n.targets))
    stop = next(i for i in range(start,len(tree.body)) if isinstance(tree.body[i],ast.For))
    scope = {'Path':Path,'sys':sys,'__file__':str(worker)}
    exec(compile(ast.Module(body=tree.body[start:stop+1],type_ignores=[]),str(worker),'exec'),scope)
    from registry import AnalysisEngineRegistry
    manifest = AnalysisEngineRegistry('freeze-preflight','1')._manifest_path()
    analysis_paths = list(sys.path)
    yjk_dir = worker.parent.parent / 'yjk-static'
    sys.path.insert(0,str(yjk_dir))
    yjk = runpy.run_path(str(yjk_dir / 'runtime.py'))
    try:
        yjk_python = yjk['_resolve_yjk_python']()
    except Exception:
        yjk_python = None
    sys.path[:] = analysis_paths
    extra = {'engineManifest':file_record(manifest), 'yjkPython':yjk_python}
    names = ['numpy','scipy','openseespy','openseespy.opensees','openseespywin',
             'pydantic','fastapi','httpx','yaml','ezdxf','APIPyInterface','sitecustomize','usercustomize']
else:
    driver = Path(request['driver']).resolve()
    if sys.path and sys.path[0] == '':
        sys.path[0] = str(driver.parent)
    yjk = {'__file__':str(driver),'__name__':'freeze_readonly_driver'}
    exec(compile(driver.read_text(encoding='utf-8'),str(driver),'exec'),yjk)
    install_root = yjk['_setup_paths']()
    executable = yjk['_find_yjks_exe'](install_root)
    extra = {'installRoot':str(Path(install_root).resolve()),
             'nativeExecutable':file_record(executable) if executable else None}
    names = ['YJKAPI','clr','pythonnet','sitecustomize','usercustomize']
modules = {}
for name in names:
    try:
        spec = importlib.util.find_spec(name)
        modules[name] = None if spec is None else {
            'origin':file_record(spec.origin) if spec.origin and Path(spec.origin).is_file() else spec.origin,
            'packagePaths':list(spec.submodule_search_locations or [])}
    except (ImportError, AttributeError, ModuleNotFoundError):
        modules[name] = None
print(json.dumps({'executable':file_record(sys.executable),'version':sys.version,
    'prefix':sys.prefix,'basePrefix':sys.base_prefix,'searchPaths':[str(Path(p).resolve()) for p in sys.path],
    'modules':modules, **extra},ensure_ascii=False))
`;

// This runs in a separate Node process: the spawn interception cannot affect the
// app or another audit. Invoke the real runner but stop at its process boundary;
// only our read-only Python probe is subsequently executed.
const nodeBindingProbe = String.raw`
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const input = JSON.parse(fs.readFileSync(0,'utf8'));
let phase = 'settings';
(async () => {
  const dataDir = process.env.SCLAW_DATA_DIR || path.join(os.homedir(),'.structureclaw');
  const settingsPath = path.join(dataDir,'settings.json');
  if (!fs.existsSync(settingsPath) && fs.existsSync(path.join(dataDir,'llm-settings.json'))) {
    throw Error('LEGACY_SETTINGS_MIGRATION_REQUIRED');
  }
  const load = name => import(pathToFileURL(path.join(input.repositoryRoot,'backend/dist',name)).href);
  // Reject invalid settings instead of accepting the permissive reader fallback.
  (await load('config/settings-file.js')).readSettingsFileForUpdate();
  const { config } = await load('config/index.js');
  phase = 'worker-command';
  const { PythonWorkerRunner, resolveWorkerPath } = await load('utils/python-worker-runner.js');
  const worker = resolveWorkerPath('agent-skills/analysis/runtime/worker.py');
  const marker = Error('CAPTURE_WORKER_SPAWN');
  let captured;
  cp.spawn = (command,args,options) => { captured = {command,args,options}; throw marker; };
  syncBuiltinESMExports();
  try { await new PythonWorkerRunner(worker).invoke({}); }
  catch (error) { if (error !== marker) throw Error('ANALYSIS_PYTHON_RESOLUTION_FAILED'); }
  if (!captured) throw Error('WORKER_SPAWN_NOT_CAPTURED');
  const environment = captured.options.env;
  const selected = Object.fromEntries(['PYTHONPATH','PYTHONHOME','PYTHONNOUSERSITE','PYTHONUSERBASE',
    'PYTHONSAFEPATH','PYTHONUTF8','PKPM_CYCLE_PATH','PKPM_WORK_DIR','YJK_PATH','YJKS_ROOT',
    'YJKS_EXE','YJK_PYTHON_BIN','YJK_WORK_DIR','YJK_VERSION','YJK_TIMEOUT_S','YJK_INVISIBLE',
    'YJK_LAUNCHER_PREWARM','YJK_LAUNCHER_PREWARM_S','YJK_DIRECT_READY_TIMEOUT_S',
    'ANALYSIS_ENGINE_MANIFEST_PATH'].map(key => [key,environment[key] ?? null]));
  const run = (command,args,payload) => JSON.parse(cp.execFileSync(command,[...args,'-B','-c',input.pythonProbe],{
    cwd:captured.options.cwd, env:environment, input:JSON.stringify(payload),
    encoding:'utf8',windowsHide:true,timeout:30000,stdio:['pipe','pipe','pipe'],maxBuffer:4*1024*1024}));
  phase = 'analysis-module-resolution';
  const analysis = run(captured.command,captured.args.slice(0,-1),{mode:'analysis',worker});
  phase = 'yjk-module-resolution';
  const yjk = analysis.yjkPython ? run(analysis.yjkPython,[],{
    mode:'yjk',driver:path.resolve(path.dirname(worker),'../yjk-static/yjk_driver.py')}) : null;
  process.stdout.write(JSON.stringify({schemaVersion:1, workingDirectory:process.cwd(),
    dataDirectory:path.resolve(dataDir), settingsPath:path.resolve(settingsPath),
    configured:{analysisPythonBin:config.analysisPythonBin,analysisEngineManifestPath:config.analysisEngineManifestPath,
      pkpmCyclePath:config.pkpmCyclePath,yjkInstallRoot:config.yjkInstallRoot,
      yjkExePath:config.yjkExePath,yjkPythonBin:config.yjkPythonBin},
    workerPath:worker, pythonCommand:{executable:captured.command,args:captured.args.slice(0,-1)},
    environment:selected, analysis, yjk}));
})().catch(error => {
  // Child-process errors can include buffers or settings text: do not serialize them.
  process.stdout.write(JSON.stringify({error: ['LEGACY_SETTINGS_MIGRATION_REQUIRED',
    'ANALYSIS_PYTHON_RESOLUTION_FAILED','WORKER_SPAWN_NOT_CAPTURED'].includes(error.message)
    ? error.message : 'EXECUTION_BINDING_PROBE_FAILED: ' + phase})); process.exitCode=1;
});
`;

/** Read-only collector for manifest.executionBinding. Use the same env and cwd
 * as the backend under evaluation. No secret-bearing settings content is saved.
 */
export function collectExecutionBinding(repositoryRoot, { env = process.env,
  workingDirectory = path.join(repositoryRoot, 'backend') } = {}) {
  let output;
  try {
    output = execFileSync(process.execPath, ['-e', nodeBindingProbe], {
      cwd: workingDirectory, env, input: JSON.stringify({ repositoryRoot: path.resolve(repositoryRoot),
        pythonProbe: pythonBindingProbe }), encoding: 'utf8', windowsHide: true,
      timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    let code;
    try { code = JSON.parse(String(error.stdout)).error; } catch { /* No child output. */ }
    throw Error(code || 'EXECUTION_BINDING_PROBE_FAILED');
  }
  const binding = JSON.parse(output);
  binding.node = { path: process.execPath, sha256: sha(fs.readFileSync(process.execPath)), version: process.version };
  const effectivePkpm = binding.environment.PKPM_CYCLE_PATH;
  const file = effectivePkpm ? path.resolve(workingDirectory, effectivePkpm.trim()) : null;
  binding.pkpmExecutable = file ? { path: file, sha256: fs.existsSync(file) ? sha(fs.readFileSync(file)) : null } : null;
  return binding;
}

export function validateExecutionBinding(expected, actual) {
  if (!expected || expected.schemaVersion !== 1) throw Error('EXECUTION_BINDING_REQUIRED');
  if (sortedJson(expected) !== sortedJson(actual)) throw Error('EXECUTION_BINDING_CHANGED');
}

/** Pin installed dependency bytes as well as lockfiles. Interpreter caches are
 * generated during normal execution; source modules and native binaries are not.
 */
export function dependencyTreeDigest(directory) {
  const entries = [];
  function visit(relative, stat = fs.lstatSync(path.join(directory, relative))) {
    const absolute = path.join(directory, relative);
    if (stat.isSymbolicLink()) throw Error(`DEPENDENCY_SYMLINK: ${absolute}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (entry.name === '__pycache__' || entry.name === '.cache') continue;
        visit(relative ? `${relative}/${entry.name}` : entry.name, entry);
      }
    } else if (stat.isFile() && !/\.py[co]$/.test(relative)) entries.push([relative, sha(fs.readFileSync(absolute))]);
  }
  visit('');
  return { sha256: sha(JSON.stringify(entries)), fileCount: entries.length };
}

/** Include executable build artifacts that Git ignores. Runtime caches/traces
 * do not execute code and are the only excluded production-build entries.
 */
export function compiledArtifactDigest(repositoryRoot) {
  const files = [];
  const excluded = ['frontend/.next/cache', 'frontend/.next/trace', 'frontend/.next/trace-build'];
  function visit(relative, stat = fs.lstatSync(path.join(repositoryRoot, relative))) {
    if (excluded.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`))) return;
    const absolute = path.join(repositoryRoot, relative);
    if (stat.isSymbolicLink()) throw Error(`BUILD_ARTIFACT_SYMLINK: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        visit(`${relative}/${entry.name}`, entry);
      }
    }
    else if (stat.isFile()) files.push([relative, sha(fs.readFileSync(absolute))]);
  }
  for (const required of ['backend/dist/index.js', 'frontend/.next/BUILD_ID', 'frontend/out/index.html']) {
    if (!fs.existsSync(path.join(repositoryRoot, required))) throw Error(`FROZEN_PRODUCTION_BUILD_REQUIRED: ${required}`);
  }
  visit('backend/dist');
  visit('frontend/.next');
  visit('frontend/out');
  return { sha256: sha(JSON.stringify(files)), fileCount: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
try {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(root, manifestPath), 'utf8'));
  if (manifest.status !== 'scenario-compatible-frozen') throw Error('SCENARIO_FREEZE_NOT_ACCEPTED / 场景能力尚未完成冻结');
  if (!/^[a-f0-9]{40}$/.test(manifest.implementationCommit)) throw Error('FREEZE_COMMIT_REQUIRED');
  const runtimePaths = ['backend', 'frontend', 'scripts', 'sclaw', 'sclaw_cn', 'package.json', 'package-lock.json', 'AGENTS.md'];
  git(['cat-file', '-e', `${manifest.implementationCommit}^{commit}`]);
  const tree = git(['ls-tree', '-r', '--full-tree', manifest.implementationCommit, '--', ...runtimePaths]);
  if (sha(tree) !== manifest.runtimeTreeSha256) throw Error('FREEZE_RUNTIME_TREE_MISMATCH');
  const changed = git(['diff', '--name-only', manifest.implementationCommit, '--', ...runtimePaths]).trim();
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...runtimePaths]).trim();
  if (changed || untracked) throw Error(`FROZEN_IMPLEMENTATION_CHANGED / 冻结代码发生变化: ${[changed, untracked].filter(Boolean).join(', ')}`);
  const artifacts = compiledArtifactDigest(root);
  if (artifacts.sha256 !== manifest.compiledArtifacts?.sha256 || artifacts.fileCount !== manifest.compiledArtifacts?.fileCount) {
    throw Error('FROZEN_BUILD_CHANGED / 已编译运行产物与冻结版本不符');
  }
  if (process.version !== manifest.nodeVersion) throw Error('NODE_RUNTIME_CHANGED');
  if (!manifest.executionBinding) throw Error('EXECUTION_BINDING_REQUIRED');
  const executionBinding = collectExecutionBinding(root, {
    workingDirectory: manifest.executionBinding.workingDirectory,
  });
  validateExecutionBinding(manifest.executionBinding, executionBinding);
  if (!executionBinding.pkpmExecutable?.sha256 || !executionBinding.yjk?.nativeExecutable?.sha256
    || !executionBinding.analysis.modules.openseespy?.origin?.sha256) {
    throw Error('ALL_PLANNED_ENGINE_EXECUTABLES_REQUIRED');
  }
  if (!Array.isArray(manifest.dependencyTrees) || !manifest.dependencyTrees.length) throw Error('INSTALLED_DEPENDENCY_FREEZE_REQUIRED');
  for (const item of manifest.dependencyTrees) {
    const actual = dependencyTreeDigest(path.resolve(root, item.path));
    if (actual.sha256 !== item.sha256 || actual.fileCount !== item.fileCount) throw Error(`INSTALLED_DEPENDENCIES_CHANGED: ${item.path}`);
  }
  if (!Array.isArray(manifest.evidenceFiles) || !manifest.evidenceFiles.length) throw Error('FREEZE_EVIDENCE_REQUIRED');
  for (const item of manifest.evidenceFiles) {
    const resolved = path.resolve(root, item.path);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('EVIDENCE_PATH_OUTSIDE_REPOSITORY');
    const bytes = fs.readFileSync(resolved);
    const content = item.hashMode === 'canonical-json' ? JSON.stringify(JSON.parse(bytes.toString('utf8'))) : bytes;
    if (sha(content) !== item.sha256) throw Error(`FREEZE_EVIDENCE_CHANGED: ${item.path}`);
  }
  const planPath = 'docs/reproducibility/scenario-plan-300-20261013.json';
  const auditPaths = ['opensees', 'pkpm', 'yjk'].map(engine =>
    `docs/reproducibility/${engine}-scenario-compatibility-20261013.json`);
  if ([planPath, ...auditPaths].some(file => !manifest.evidenceFiles.some(item => item.path === file))) {
    throw Error('FREEZE_PLAN_AND_ALL_ENGINE_AUDITS_REQUIRED');
  }
  const read = file => JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
  const plan = read(planPath);
  const coverage = validateScenarioCoverage(plan, auditPaths.map(read), {
    planBytes: fs.readFileSync(path.resolve(root, planPath)),
  });
  // Native binaries are machine-local and intentionally not committed. Missing
  // pins or changed bytes stop the experiment instead of silently updating.
  if (!Array.isArray(manifest.nativeFiles) || !manifest.nativeFiles.length) throw Error('NATIVE_RUNTIME_FREEZE_REQUIRED');
  for (const item of manifest.nativeFiles) {
    if (sha(fs.readFileSync(item.path)) !== item.sha256) throw Error(`NATIVE_RUNTIME_CHANGED: ${item.path}`);
  }
  console.log(JSON.stringify({ status: 'passed', implementationCommit: manifest.implementationCommit,
    runtimeTreeSha256: manifest.runtimeTreeSha256, compiledArtifacts: artifacts, ...coverage,
    scope: 'Frozen tool capability and implementation; not benchmark accuracy or completed Bench tasks.',
    policy: 'Keep this implementation during Bench authoring and experiments. Record failures; never patch against a test case.' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', reason: error.message }, null, 2));
  process.exitCode = 1;
}
}
