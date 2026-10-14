// Opt-in integration: public tool session -> real SDK -> native design -> shared report.
// Uses product fixtures and configured private SDK installations; no LLM or Bench.
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPublicToolSession } from '../dist/agent-langgraph/public-tool-contracts.js';
import { currentAnalysisError } from '../dist/engineering/model-state.js';
import { runtimeBaseDir } from '../dist/config/index.js';

const engine = process.argv[2];
const fixture = process.argv[3];
const designFile = process.argv[4];
const resumeSessionId = process.argv[5];
if (!['yjk', 'pkpm'].includes(engine) || !fixture || !designFile) {
  throw new Error('Usage: node tests/engineering-commercial-tool-acceptance.mjs yjk|pkpm model.json design.json');
}
const model = JSON.parse(await readFile(path.resolve(fixture), 'utf8'));
const design = JSON.parse(await readFile(path.resolve(designFile), 'utf8'));
const work = path.join(runtimeBaseDir, 'work'); await mkdir(work, {recursive:true});
const directory = await mkdtemp(path.join(work, `${engine}-public-tools-`));
const source = JSON.stringify({model, design}, null, 2);
await writeFile(path.join(directory, 'input.json'), source);
const sourceHash = createHash('sha256').update(source).digest('hex');
const checks = [];
let session;
try {
  session = await createPublicToolSession(resumeSessionId ? {sessionId:resumeSessionId,resume:true} : {model, locale:'en', message:'Explicit native analysis and design with recorded defaults.',
    runPolicy:{skillIds:[`${engine}-static`, 'report-export-builtin', 'postprocess-builtin'],
      repair:{enabled:false}, tools:{enabledIds:['run_analysis','run_code_check','query_results','generate_report']},
      budgets:{maxToolCallsPerTurn:20}}});
  const invoke = async (name, args) => {
    const result = await session.invoke(name, args);
    await writeFile(path.join(directory, `${checks.length}-${name}.json`), JSON.stringify({sessionId:result.sessionId,
      policy:result.policy,usage:result.usage,messages:result.messages,runId:result.state.analysisResult?.runId,
      checkSummary:result.state.codeCheckResult?.summary}, null, 2));
    checks.push(name); return result;
  };
  const cases = model.load_cases.map(item=>String(item.id));
  let response = resumeSessionId ? session.snapshot() : await invoke('run_analysis', {analysisSkillId:`${engine}-static`,analysisType:'static',loadCaseIds:cases});
  const analysis = resumeSessionId ? Object.values(response.state.analysisRuns).find(run=>run.success===true
    && !run.data?.nativeDesignContext?.request?.requested) : response.state.analysisResult;
  assert.equal(analysis?.success, true, JSON.stringify(response.messages));
  assert.equal(currentAnalysisError(response.state), undefined);
  assert.deepEqual(Object.keys(analysis.results).sort(), cases.map(id=>`case:${id}`).sort());
  if(!resumeSessionId){
    assert.ok(response.state.codeCheckResult == null, 'Ordinary analysis must not publish native design conclusions');
    response = await invoke('run_code_check', {provider:'auto',designCode:design.code,design});
  }else checks.push('resume verified analysis and design');
  const run = response.state.analysisResult, check = response.state.codeCheckResult;
  assert.equal(run?.success, true, JSON.stringify(response.messages));
  assert.notEqual(run.runId, analysis.runId, 'Design settings own a fresh analysis run');
  assert.equal(check?.completionStatus, 'complete', JSON.stringify(check));
  assert.equal(check.meta.runId, run.runId);
  assert.equal(check.provider, 'native');
  assert.equal(check.designCode,design.code);
  if (design.mode === 'required-reinforcement') {
    assert.equal(check.complianceStatus, 'not_evaluated');
    assert.ok(check.records.length > 0);
  }
  // All selections must come from one owned native project, not repeated jobs.
  const projects = Object.values(run.results).map(result => result.data.nativeDesignContext.nativeProject);
  assert.ok(projects.every(Boolean)); assert.equal(new Set(projects).size, 1);
  const quantities = [];
  for (const [selection, result] of Object.entries(run.results)) {
    const reactions = result.data.reactions;
    const [nodeId, values] = Object.entries(reactions).find(([,v]) => Number.isFinite(v.fz));
    const id = `${selection}-reaction`;
    response = await invoke('query_results', {resultKey:selection,field:'reactions',nodeId,component:'fz',unit:'kN',quantityId:id});
    const actual = response.state.resultQuantities[`${run.runId}:${id}`];
    assert.equal(actual?.value, values.fz); assert.equal(actual.runId,run.runId);
    quantities.push(actual);
  }
  for (const locale of ['en','zh']) {
    response = await invoke('generate_report', {message:'Native SDK result delivery',analysisType:'static',locale});
    const report = response.state.report;
    assert.equal(report.json.meta.runId, run.runId);
    for(const q of quantities) assert.deepEqual(report.json.requestedQuantities.find(item=>item.id===q.id),q);
    if(design.mode==='required-reinforcement') assert.equal(report.json.keyMetrics.codeCheckPassRate,null);
    assert.ok(report.summary.startsWith(locale==='en'?'Analysis type':'分析类型'),`Wrong report locale: ${locale}`);
    await writeFile(path.join(directory,`${locale}-report.md`),report.markdown);
  }
  const resumed = await createPublicToolSession({sessionId:session.sessionId,resume:true});
  assert.equal(resumed.policy.policyHash,session.policy.policyHash);
  assert.deepEqual(resumed.snapshot().usage,session.snapshot().usage);
  // A missing design prerequisite must not become pass or reuse the previous design.
  response = await invoke('run_code_check', {provider:'native',designCode:design.code,design:{mode:design.mode}});
  assert.equal(response.state.codeCheckResult?.completionStatus,'incomplete');
  assert.equal(response.state.codeCheckResult?.executionStatus,'insufficient_data');
  assert.notEqual(response.state.codeCheckResult?.complianceStatus,'pass');
  assert.ok(currentAnalysisError(response.state));
  const receipt = {status:'passed',engine,sourceHash,directory,sessionId:session.sessionId,
    policyHash:session.policy.policyHash,analysisRunId:analysis.runId,designRunId:run.runId,
    nativeProjects:[...new Set(projects)],checks,quantities,
    nativeCheckSummary:check.summary,complianceStatus:check.complianceStatus,usage:session.snapshot().usage};
  await writeFile(path.join(directory,'acceptance.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt,null,2));
} catch(error) {
  await writeFile(path.join(directory,'acceptance.json'),JSON.stringify({status:'failed',sourceHash,checks,sessionId:session?.sessionId,error:String(error)},null,2));
  console.error(directory); throw error;
}
