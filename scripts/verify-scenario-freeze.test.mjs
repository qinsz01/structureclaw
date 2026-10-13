import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectExecutionBinding, compiledArtifactDigest, dependencyTreeDigest,
  validateExecutionBinding, validateScenarioCoverage } from './verify-scenario-freeze.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function coverageFixture() {
  const tasks = ['STD', 'INT', 'MM'].flatMap(prefix => Array.from({ length: 100 }, (_, index) => {
    const id = `${prefix}-${String(index + 1).padStart(3, '0')}`;
    return { id, baseGroup: `M-${id}`, enginePlan: { plannedEngine: 'OpenSees' } };
  }));
  tasks.slice(267, 283).forEach(task => { task.enginePlan.plannedEngine = 'PKPM'; });
  tasks.slice(283).forEach(task => { task.enginePlan.plannedEngine = 'YJK'; });
  const plan = { tasks, models: tasks.map(task => ({ id: task.baseGroup, taskId: task.id, spec: 'Original scenario' })) };
  const planBytes = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  const audits = ['OpenSees', 'PKPM', 'YJK'].map(engine => ({ plannedEngine: engine,
    sourceSnapshot: { sha256: sha(planBytes) },
    scenarios: tasks.filter(task => task.enginePlan.plannedEngine === engine).map(task => ({
      id: task.id, plannedEngine: engine, source: { modelId: task.baseGroup, taskId: task.id },
      scenarioCompatible: true, requiredCapabilities: ['specified-loads'], evidence: ['verified-probe'], unresolvedToolGaps: [],
    })),
  }));
  return { plan, audits, planBytes };
}

test('coverage accepts 300 uniquely linked, audited planning rows; CRLF does not alter the reviewed source', () => {
  const fixture = coverageFixture();
  const result = validateScenarioCoverage(fixture.plan, fixture.audits, fixture);
  assert.deepEqual(result, { scenarioCount: 300, engineCounts: { OpenSees: 267, PKPM: 16, YJK: 17 } });
  assert.deepEqual(validateScenarioCoverage(fixture.plan, fixture.audits, {
    planBytes: String(fixture.planBytes).replace(/\n/g, '\r\n'),
  }), result);
});

test('coverage rejects duplicate records, broken source joins and unresolved or reassigned capabilities', async t => {
  const cases = [
    ['duplicate task', f => { f.plan.tasks[1] = f.plan.tasks[0]; }, /INCOMPLETE_SCENARIO_COVERAGE/],
    ['duplicate model', f => { f.plan.models[1] = f.plan.models[0]; }, /INCOMPLETE_SCENARIO_COVERAGE/],
    ['duplicate model id', f => { f.plan.models[1].id = f.plan.models[0].id; }, /INCOMPLETE_SCENARIO_COVERAGE/],
    ['broken model task link', f => { f.plan.models[0].taskId = 'missing'; }, /INCOMPLETE_SCENARIO_COVERAGE/],
    ['broken task model link', f => { f.plan.tasks[0].baseGroup = 'missing'; }, /INCOMPLETE_SCENARIO_COVERAGE/],
    ['missing audit row', f => { f.audits[0].scenarios.pop(); }, /INCOMPLETE_SCENARIO_COVERAGE/],
    ['duplicate audit row', f => { f.audits[0].scenarios[1] = f.audits[0].scenarios[0]; }, /INCOMPLETE_SCENARIO_COVERAGE/],
    ['wrong audit model', f => { f.audits[0].scenarios[0].source.modelId = 'wrong'; }, /SCENARIO_TOOL_GAPS_REMAIN: STD-001/],
    ['wrong audit task', f => { f.audits[0].scenarios[0].source.taskId = 'STD-002'; }, /SCENARIO_TOOL_GAPS_REMAIN: STD-001/],
    ['wrong engine', f => { f.audits[0].scenarios[0].plannedEngine = 'YJK'; }, /AUDIT_ENGINE_MISMATCH/],
    ['changed assignment', f => { f.plan.tasks[0].enginePlan.plannedEngine = 'YJK'; }, /PLANNED_ENGINE_ASSIGNMENT_CHANGED/],
    ['unresolved capability', f => { f.audits[0].scenarios[0].unresolvedToolGaps = ['release']; }, /SCENARIO_TOOL_GAPS_REMAIN: STD-001/],
    ['not accepted', f => { f.audits[0].scenarios[0].scenarioCompatible = false; }, /SCENARIO_TOOL_GAPS_REMAIN: STD-001/],
    ['missing evidence', f => { f.audits[0].scenarios[0].evidence = []; }, /SCENARIO_TOOL_GAPS_REMAIN: STD-001/],
    ['empty evidence', f => { f.audits[0].scenarios[0].evidence = ['']; }, /SCENARIO_TOOL_GAPS_REMAIN: STD-001/],
    ['missing requirement', f => { f.audits[0].scenarios[0].requiredCapabilities = []; }, /SCENARIO_TOOL_GAPS_REMAIN: STD-001/],
    ['wrong snapshot', f => { f.audits[0].sourceSnapshot.sha256 = '0'.repeat(64); }, /AUDIT_SOURCE_SNAPSHOT_MISMATCH/],
    ['changed model content', f => { f.plan.models[0].spec = 'unreviewed structure'; f.planBytes = Buffer.from(JSON.stringify(f.plan)); }, /AUDIT_SOURCE_SNAPSHOT_MISMATCH/],
    ['wrong row content hash', f => { f.audits[0].scenarios[0].source.modelSha256 = '0'.repeat(64); }, /SCENARIO_TOOL_GAPS_REMAIN: STD-001/],
  ];
  for (const [name, mutate, expected] of cases) await t.test(name, () => {
    const fixture = coverageFixture();
    mutate(fixture);
    assert.throws(() => validateScenarioCoverage(fixture.plan, fixture.audits, fixture), expected);
  });
});

test('production execution binding detects settings, manifest and PYTHONPATH changes without retaining LLM secrets', () => {
  const python = process.env.PYTHON_FOR_TEST || process.env.SCLAW_TEST_PYTHON;
  assert.ok(python && fs.existsSync(python), 'Set PYTHON_FOR_TEST to the installed analysis interpreter (no solver is launched).');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-freeze-test-'));
  const env = { ...process.env, SCLAW_DATA_DIR: directory };
  for (const key of ['PKPM_CYCLE_PATH', 'ANALYSIS_ENGINE_MANIFEST_PATH', 'PYTHONPATH']) delete env[key];
  const settingsFile = path.join(directory, 'settings.json');
  const settings = { analysis: { pythonBin: python, engineManifestPath: path.join(directory, 'engines.json') },
    llm: { apiKey: 'private-test-key', model: 'experiment-variable' } };
  const collect = extraEnv => collectExecutionBinding(repositoryRoot, { env: { ...env, ...extraEnv } });
  const write = () => fs.writeFileSync(settingsFile, JSON.stringify(settings));
  try {
    write();
    const original = collect();
    assert.equal(original.configured.analysisPythonBin, python);
    assert.equal(original.dataDirectory, directory);
    assert.equal(original.settingsPath, settingsFile);
    assert.ok(original.analysis.executable.sha256);
    assert.ok(original.analysis.modules.numpy.origin.sha256);
    assert.ok(!JSON.stringify(original).includes('private-test-key'));
    assert.ok(!JSON.stringify(original).includes('experiment-variable'));
    settings.llm.apiKey = 'different-secret';
    settings.llm.model = 'different-model';
    write();
    validateExecutionBinding(original, collect());
    const expectChanged = actual => assert.throws(() => validateExecutionBinding(original, actual), /EXECUTION_BINDING_CHANGED/);
    settings.analysis.engineManifestPath = path.join(directory, 'other-engines.json');
    write();
    expectChanged(collect());
    settings.analysis.engineManifestPath = original.configured.analysisEngineManifestPath;
    // Even an alternate spelling of an executable is an explicit selection
    // change; the collector also records sys.executable from the actual process.
    settings.analysis.pythonBin = `${path.dirname(python)}${path.sep}.${path.sep}${path.basename(python)}`;
    write();
    expectChanged(collect());
    settings.analysis.pythonBin = python;
    const cycle = path.join(directory, 'cycle.exe');
    fs.writeFileSync(cycle, 'fixture executable bytes - never executed');
    settings.pkpm = { cyclePath: cycle };
    settings.yjk = { installRoot: path.join(directory, 'sdk'), exePath: path.join(directory, 'yjks.exe') };
    write();
    const commercial = collect({ PKPM_CYCLE_PATH: 'ignored-environment-cycle', YJKS_ROOT: 'ignored-environment-root' });
    expectChanged(commercial);
    assert.equal(commercial.pkpmExecutable.path, cycle);
    assert.equal(commercial.environment.YJKS_ROOT, settings.yjk.installRoot);
    assert.equal(commercial.yjk, null);
    delete settings.pkpm;
    delete settings.yjk;
    write();
    const engines = path.join(directory, 'actual-engines.json');
    fs.writeFileSync(engines, '[]');
    const withManifest = collect({ ANALYSIS_ENGINE_MANIFEST_PATH: engines });
    assert.equal(withManifest.analysis.engineManifest.path, engines);
    fs.writeFileSync(engines, '[{"id":"changed-engine"}]');
    assert.throws(() => validateExecutionBinding(withManifest, collect({ ANALYSIS_ENGINE_MANIFEST_PATH: engines })), /EXECUTION_BINDING_CHANGED/);
    fs.writeFileSync(path.join(directory, 'ezdxf.py'), '# resolution probe; not imported');
    const shadowed = collect({ PYTHONPATH: directory });
    assert.equal(shadowed.analysis.modules.ezdxf.origin.path, path.join(directory, 'ezdxf.py'));
    expectChanged(shadowed);
    const otherData = path.join(directory, 'second-data');
    fs.mkdirSync(otherData);
    fs.writeFileSync(path.join(otherData, 'settings.json'), JSON.stringify(settings));
    expectChanged(collect({ SCLAW_DATA_DIR: otherData }));
    fs.writeFileSync(settingsFile, '{ invalid JSON and private-test-key');
    assert.throws(() => collect(), error => error.message === 'EXECUTION_BINDING_PROBE_FAILED: settings');
    fs.unlinkSync(settingsFile);
    fs.writeFileSync(path.join(directory, 'llm-settings.json'), '{"apiKey":"do-not-migrate"}');
    assert.throws(() => collect(), /LEGACY_SETTINGS_MIGRATION_REQUIRED/);
    assert.equal(fs.existsSync(settingsFile), false);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('sclaw-freeze-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('freeze detects ignored executable and routing changes, while allowing runtime caches', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-freeze-test-'));
  const write = (name, content) => {
    const filename = path.join(directory, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  };
  try {
    write('backend/dist/index.js', 'export const answer = 1;');
    write('frontend/.next/BUILD_ID', 'frozen');
    write('frontend/.next/routes-manifest.json', '{"route":"original"}');
    write('frontend/out/index.html', '<html>original</html>');
    const original = compiledArtifactDigest(directory);
    write('frontend/.next/cache/result', 'runtime cache');
    write('frontend/.next/trace', 'runtime trace');
    assert.deepEqual(compiledArtifactDigest(directory), original);
    write('backend/dist/index.js', 'export const answer = 2;');
    assert.notEqual(compiledArtifactDigest(directory).sha256, original.sha256);
    write('backend/dist/index.js', 'export const answer = 1;');
    write('frontend/.next/routes-manifest.json', '{"route":"changed"}');
    assert.notEqual(compiledArtifactDigest(directory).sha256, original.sha256);
    write('frontend/.next/routes-manifest.json', '{"route":"original"}');
    write('frontend/out/index.html', '<html>changed</html>');
    assert.notEqual(compiledArtifactDigest(directory).sha256, original.sha256);
    write('frontend/out/index.html', '<html>original</html>');
    write('backend/dist/extra.js', 'export const injected = true;');
    assert.notEqual(compiledArtifactDigest(directory).sha256, original.sha256);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('sclaw-freeze-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('freeze detects installed dependency changes without treating Python caches as source', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-freeze-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'solver.py'), 'value = 1');
    const original = dependencyTreeDigest(directory);
    assert.deepEqual(original, { sha256: sha(JSON.stringify([['solver.py', sha('value = 1')]])), fileCount: 1 });
    fs.mkdirSync(path.join(directory, '__pycache__'));
    fs.writeFileSync(path.join(directory, '__pycache__', 'solver.pyc'), 'cache');
    assert.deepEqual(dependencyTreeDigest(directory), original);
    fs.writeFileSync(path.join(directory, 'solver.py'), 'value = 2');
    assert.notEqual(dependencyTreeDigest(directory).sha256, original.sha256);
    fs.writeFileSync(path.join(directory, 'solver.py'), 'value = 1');
    fs.writeFileSync(path.join(directory, 'native.pyd'), 'changed native extension');
    assert.notEqual(dependencyTreeDigest(directory).sha256, original.sha256);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('sclaw-freeze-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
