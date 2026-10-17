// Build backend first. Runs registered public tools and real OpenSees, without an LLM.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scenarios } from './fixtures/opensees-chain-reference.mjs';
import { AgentSkillRuntime } from '../dist/agent-runtime/index.js';
import { createRegisteredTools } from '../dist/agent-langgraph/tool-registry.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { commitModel, currentAnalysisError, modelHash } from '../dist/engineering/model-state.js';
import { createLocalAnalysisEngineClient } from '../dist/services/analysis-execution.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { createLocalCodeCheckClient } from '../dist/services/code-check-execution.js';
import { runtimeBaseDir } from '../dist/config/index.js';

const root=path.join(runtimeBaseDir,'work');await mkdir(root,{recursive:true});
const directory=await mkdtemp(path.join(root,'opensees-tools-'));
const source=JSON.stringify(scenarios,null,2);
await writeFile(path.join(directory,'frozen-input-reference.json'),source);
const referenceHash=createHash('sha256').update(source).digest('hex');
const skillRuntime=new AgentSkillRuntime();
const tools=new Map(createRegisteredTools({skillRuntime}).map(t=>[t.name,t]));
const engineClient=createLocalAnalysisEngineClient();
const structureProtocolClient=createLocalStructureProtocolClient();
const codeCheckClient=createLocalCodeCheckClient();
const receipts=[];
try {
  for (const scenario of scenarios) {
    const model=await normalizeEngineeringModel(scenario.model,structureProtocolClient);
    const configurable={skillRuntime,engineClient,structureProtocolClient,codeCheckClient,workspaceRoot:directory,
      toolContext:{ skillScope: [scenario.analysis.analysisSkillId,'code-check-gb50017'] },allowShell:false,
      agentState:{...commitModel({},model,scenario.id),locale:'en',lastUserMessage:scenario.basis,
        policy:{analysisType:scenario.analysis.analysisType},inputEvidence:[]}};
    let sequence=0;
    const invoke=async(name,args)=>{
      const returned=await tools.get(name).invoke(args,{toolCall:{id:`${scenario.id}-${++sequence}`},configurable});
      if (returned?.update) {
        const previous=configurable.agentState;
        configurable.agentState={...previous,...returned.update,
          analysisRuns:{...previous.analysisRuns,...returned.update.analysisRuns},
          resultQuantities:{...previous.resultQuantities,...returned.update.resultQuantities}};
      }
      return returned;
    };
    const response=await invoke('run_analysis',scenario.analysis);
    const state=configurable.agentState,run=state.analysisResult;
    assert.ok(run?.success,JSON.stringify(response));
    assert.equal(currentAnalysisError(state),undefined);
    assert.equal(modelHash(run.modelSnapshot),modelHash(model));
    await writeFile(path.join(directory,`${scenario.id}-run.json`),JSON.stringify(run,null,2));
    const checks=[];
    for (const q of scenario.quantities) {
      await invoke('query_results',{...q.args,quantityId:q.id});
      const actual=configurable.agentState.resultQuantities[`${run.runId}:${q.id}`];
      assert.ok(actual && Number.isFinite(actual.value),JSON.stringify(actual));
      const delta=Math.abs((q.compareAbsolute?Math.abs(actual.value):actual.value)-q.value);
      assert.ok(delta<=q.tolerance.absolute+q.tolerance.relative*Math.abs(q.value),`${scenario.id}/${q.id}: ${actual.value} != ${q.value}`);
      if(q.args.timeIndex!==undefined)assert.ok(Math.abs(actual.time-(q.args.timeIndex+1)*scenario.referenceMetadata.dt)<1e-12);
      if(q.args.modeNumber!==undefined){assert.equal(actual.normalization.physicalDisplacement,false);assert.equal(actual.unit,'1');}
      checks.push({id:q.id,expected:q.value,actual:actual.value,delta,unit:q.args.unit});
    }
    for(const [index,frequency] of (scenario.modeFrequencies??[]).entries()){
      const message=await invoke('query_results',{field:'modal',modeNumber:index+1});
      const response=JSON.parse(typeof message==='string'?message:message.content);
      assert.ok(Math.abs(response.values.frequency-frequency)<1e-8);
    }
    if(scenario.rejection)await assert.rejects(invoke('query_results',{...scenario.rejection,quantityId:'unavailable-rotation'}),/NODE_DOF_RESPONSE_UNAVAILABLE/);
    const archived=await tools.get('query_results').invoke({...scenario.quantities[0].args,runId:run.runId,quantityId:'archive-readback'},
      {toolCall:{id:`${scenario.id}-archive`},configurable:{agentState:{}}});
    assert.equal(archived.update.resultQuantities[`${run.runId}:archive-readback`].value,checks[0].actual);
    if(scenario.codeCheck){
      await invoke('run_code_check',{designCode:'GB50017',provider:'builtin'});
      const check=configurable.agentState.codeCheckResult;
      await writeFile(path.join(directory,`${scenario.id}-checks.json`),JSON.stringify(check,null,2));
      assert.equal(check.meta.runId,run.runId);
      // The numerical section lacks complete strength/stability design inputs;
      // missing information must remain explicit rather than a fabricated pass.
      assert.equal(check.completionStatus,'incomplete');
      assert.ok(check.summary.inputRequired>0);
      for(const detail of check.details){
        const item=detail.checks.flatMap(group=>group.items).find(row=>row.clause==='GB50017-2017 10.2.1');
        const expected=scenario.codeCheck.sampledDeflectionMm[detail.resultKey];
        if(expected===undefined){assert.equal(item.status,'input_required');continue;}
        assert.equal(item.status,'pass');
        assert.ok(Math.abs(item.inputs.demand-expected)<1e-8);
        // The check API intentionally formats utilization to four decimals;
        // demand above is still compared at the full numerical precision.
        assert.equal(item.utilization,Number((expected/(4000/300)).toFixed(4)));
      }
    }
    for(const locale of ['en','zh']){
      configurable.agentState.locale=locale;
      await invoke('generate_report',{message:scenario.basis,analysisType:scenario.analysis.analysisType,locale});
      const report=configurable.agentState.report;
      assert.ok(report && typeof report.markdown==='string');
      for(const q of checks){
        assert.ok(report.markdown.includes(q.id),`Missing report quantity ${q.id}`);
        const reported=report.json.requestedQuantities.find(item=>item.id===q.id);
        assert.equal(reported.value,q.actual);assert.equal(reported.unit,q.unit);assert.equal(reported.runId,run.runId);
      }
      await writeFile(path.join(directory,`${scenario.id}-${locale}-report.md`),report.markdown);
    }
    receipts.push({id:scenario.id,status:'passed',runId:run.runId,modelHash:modelHash(model),queries:checks,
      checks:['registered public tool','real OpenSees','current model binding','archived tool query','independent reference','unit conversion','bilingual report',
        ...(scenario.rejection?['undetermined rotation rejected']:[]),...(scenario.codeCheck?['honest partial design check']:[])]});
  }
  await writeFile(path.join(directory,'acceptance.json'),JSON.stringify({status:'passed',referenceHash,receipts},null,2));
  console.log(JSON.stringify({status:'passed',directory,referenceHash,scenarios:receipts.map(r=>({id:r.id,runId:r.runId,queries:r.queries.length}))},null,2));
}catch(error){
  await writeFile(path.join(directory,'acceptance.json'),JSON.stringify({status:'failed',referenceHash,receipts,error:String(error)},null,2));
  console.error(JSON.stringify({status:'failed',directory,error:String(error)},null,2));throw error;
}
