import { describe, test, expect, beforeAll } from '@jest/globals';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.SCLAW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-request-scope-'));
let createLocalAnalysisEngineClient, equilibriumModel, solveBeamEquilibrium, equilibriumResponse, createRunAnalysisTool, createQueryResultsTool, currentAnalysisError, loadAnalysisRun;
beforeAll(async () => {
  ({ createLocalAnalysisEngineClient } = await import('../dist/services/analysis-execution.js'));
  ({ equilibriumModel, solveBeamEquilibrium, equilibriumResponse } = await import('../dist/engineering/beam-equilibrium.js'));
  ({ createRunAnalysisTool } = await import('../dist/agent-langgraph/tools.js'));
  ({ createQueryResultsTool } = await import('../dist/agent-langgraph/model-tools.js'));
  ({ currentAnalysisError } = await import('../dist/engineering/model-state.js'));
  ({ loadAnalysisRun } = await import('../dist/engineering/analysis-runs.js'));
});
const scope = { responses: ['forces', 'reactions'], method: 'equilibrium', design: false, report: false, outputs: [] };
const draft = (support='simply-supported', loads) => ({ inferredType: 'beam', updatedAt: 0, engineeringDraft: {
  structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: support }, analysisControl: { self_weight: false },
  loads: loads ?? [{ kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', location: { xM: 5 } }],
} });
describe('deterministic beam equilibrium and scoped engineering delivery', () => {
  test('simply-supported beam is solved without material or section; point-load sides remain distinct', () => {
    const model = equilibriumModel(draft()); const result = solveBeamEquilibrium({ model, parameters: {} });
    expect(model.materials).toEqual([]); expect(model.sections).toEqual([]);
    expect(result.data.reactions.A.fz).toBe(0.5); expect(result.data.reactions.B.fz).toBe(0.5);
    expect(equilibriumResponse(model, {}, 'beam', 5, 'left').sample).toMatchObject({ V3: 0.5, M2: -2.5 });
    expect(equilibriumResponse(model, {}, 'beam', 5, 'right').sample).toMatchObject({ V3: -0.5, M2: -2.5 });
    expect(result.data.displacements).toBeUndefined();
    expect(result.data.envelope.maxAbsDisplacement).toBeUndefined();
    expect(result.data.execution.balance.verticalResidual).toBe(0);
    expect(result.meta).toMatchObject({coordinateSemantics:'global-z-up',coordinateContractVersion:1,dimension:'2d',plane:'xz',
      dofOrder:['ux','uy','uz','rx','ry','rz'],activeDofs:['ux','uz','ry'],nodalResultFrame:'global',elementForceFrame:'element-local'});
  });
  test('cantilever end load has the correct force and signed global support moment', () => {
    const d=draft('cantilever', [{ kind:'point',magnitude:2,unit:'kN',direction:'gravity',location:{xM:10} }]);
    d.engineeringDraft.boundary.supportPositionsM=[0];
    const model=equilibriumModel(d);
    const r=solveBeamEquilibrium({model,parameters:{}});
    expect(r.data.reactions.A).toMatchObject({fz:2,my:-20});
    expect(equilibriumResponse(model,{},'beam',0,'right').sample.M2).toBe(20);
    expect(equilibriumResponse(model,{},'beam',10,'left').sample.M2).toBe(0);
  });
  test('public equilibrium execution rejects unsupported components, boundary changes and dynamics', () => {
    for (const mutate of [
      m=>{m.load_cases[0].loads[0].fx=1;},
      m=>{m.load_cases[0].loads[0].start=2;},
      m=>{m.nodes[0].restraints[2]=false;},
    ]) {
      const model=equilibriumModel(draft());mutate(model);
      expect(()=>solveBeamEquilibrium({model,parameters:{}})).toThrow(/EQUILIBRIUM_/);
    }
    expect(()=>solveBeamEquilibrium({type:'dynamic',model:equilibriumModel(draft()),parameters:{}})).toThrow('STATIC_ONLY');
  });
  test('full-span UDL and signed combinations use force balance, not envelope combinations', () => {
    const d=draft('simply-supported',[{kind:'line',magnitude:2,unit:'kN/m',direction:'gravity',caseId:'D',target:'full-span'},
      {kind:'point',magnitude:4,unit:'kN',direction:'gravity',caseId:'L',location:{xM:5}}]);
    d.engineeringDraft.analysis={loadCombinations:[{id:'C',factors:{D:1.2,L:1.4}}]};
    const m=equilibriumModel(d),r=solveBeamEquilibrium({model:m,parameters:{loadCombinationId:'C'}});
    expect(m.load_cases[0].loads[0]).toMatchObject({type:'distributed',wz:-2});
    expect(r.data.reactions.A.fz).toBeCloseTo(14.8,10);
    expect(equilibriumResponse(m,{loadCombinationId:'C'},'beam',5,'right').sample.M2).toBeCloseTo(-44,10);
    const single=solveBeamEquilibrium({model:m,parameters:{loadCaseIds:['D']}});
    expect(single.data.envelope.maxAbsMoment).toBe(25);
  });
  test('validated single-beam topology retains stable node/member IDs', () => {
    const d=draft();d.engineeringDraft.topology={nodes:[
      {id:'N1',x:0,y:0,z:0,restraints:[true,true,true,false,false,false]},
      {id:'N2',x:10,y:0,z:0,restraints:[false,true,true,false,false,false]}],members:[{id:'B1',nodes:['N1','N2']}]};
    const model=equilibriumModel(d),result=solveBeamEquilibrium({model,parameters:{}});
    expect(result.data.reactions.N1.fz).toBe(0.5);
    expect(equilibriumResponse(model,{},'B1',5,'left').sample.M2).toBe(-2.5);
    d.engineeringDraft.topology.nodes[1].z=1;
    expect(()=>equilibriumModel(d)).toThrow('SINGLE_SPAN_TOPOLOGY_REQUIRED');
  });
  test('a partial action plan cannot drop the displacement requested in the full extracted goal', async () => {
    const {resolveExtractedScope}=await import('../dist/engineering/request-scope.js');
    expect(resolveExtractedScope(scope,{responses:['forces','displacements'],method:'solver',design:false,report:false,
      outputs:['unbound_output_label']})).toMatchObject({responses:['forces','reactions','displacements'],method:'solver',outputs:[],design:false});
    expect(resolveExtractedScope(undefined,undefined,scope)).toEqual(scope);
  });
  test.each([
    d=>{d.engineeringDraft.boundary.supportType='fixed-fixed'},
    d=>{d.engineeringDraft.analysis={engineTarget:'opensees'}},
    d=>{d.engineeringDraft.geometry.spanLengthsM=[5,5]},
    d=>{d.engineeringDraft.loads[0].direction=undefined},
    d=>{d.engineeringDraft.loads[0].location.xM=11},
    d=>{d.engineeringDraft.analysisControl.self_weight=true},
    d=>{d.draftIssues=[{severity:'conflict',field:'support',reason:'drawings disagree'}]},
  ])('rejects unsupported or unresolved physics instead of quietly using the simple beam', mutate=>{
    const d=draft();mutate(d);expect(()=>equilibriumModel(d)).toThrow(/EQUILIBRIUM_|INPUT/);
  });
  test('same run service, immutable archive, scalar query, unavailable displacement, and source freshness', async () => {
    let state={draftState:draft(),requestScope:{...scope,outputs:[{field:'forces',elementId:'beam',positionM:5,component:'M2',unit:'kN.m'}]},modelRevision:0,modelPending:true,analysisRequestSequence:0};
    const config={toolCall:{id:'equilibrium'},configurable:{agentState:state,engineClient:createLocalAnalysisEngineClient()}};
    const command=await createRunAnalysisTool({}).invoke({analysisType:'static',method:'equilibrium'},config);
    state={...state,...command.update};
    expect(currentAnalysisError(state)).toBeUndefined();
    expect(state.model).toBeUndefined();
    const run=await loadAnalysisRun(state.analysisResult.runId);
    expect(run.meta.requestScope).toEqual(state.requestScope);
    expect(Object.values(state.resultQuantities)[0].value).toBe(-2.5);
    expect(run.results['case:LC1'].meta.sourceDraftHash).toBeTruthy();
    const queryConfig={toolCall:{id:'query'},configurable:{agentState:state}};
    const q=await createQueryResultsTool().invoke({field:'forces',elementId:'beam',positionM:5,component:'M2',unit:'kN.m'},queryConfig);
    expect(JSON.parse(q.update.messages[0].content).quantity.value).toBe(-2.5);
    await expect(createQueryResultsTool().invoke({field:'displacements',nodeId:'A',component:'uz',unit:'mm'},queryConfig)).rejects.toThrow('RESPONSE_NOT_CALCULATED');
    const changed=structuredClone(state);changed.draftState.engineeringDraft.loads[0].magnitude=2;
    expect(currentAnalysisError(changed)).toBe('ANALYSIS_STALE_OR_LEGACY');
    const changedLegacy=structuredClone(state);changedLegacy.draftState.supportType='cantilever';
    expect(currentAnalysisError(changedLegacy)).toBe('ANALYSIS_STALE_OR_LEGACY');
    await expect(createRunAnalysisTool({}).invoke({analysisType:'static',method:'equilibrium',analysisSkillId:'opensees-static'},config)).rejects.toThrow('EQUILIBRIUM_NOT_A_SOLVER_FALLBACK');
    await expect(createRunAnalysisTool({}).invoke({analysisType:'static',method:'equilibrium',requestScope:{...scope,responses:['displacements']}},config)).rejects.toThrow('EQUILIBRIUM_FORCE_ONLY_REQUIRED');
  });
});

  test('analysis scope avoids reinforcement design and unwanted code/report execution', async () => {
    const {handler}=await import('../dist/agent-skills/structure-type/concrete-frame/handler.js');
    const {computeDraftMissing}=await import('../dist/agent-runtime/draft-readiness.js');
    const analysisScope={responses:['displacements','forces'],method:'solver',design:false,report:false,outputs:[]};
    const state={inferredType:'frame',skillId:'concrete-frame',frameDimension:'2d',storyCount:1,bayCount:1,storyHeightsM:[3],bayWidthsM:[6],
      floorLoads:[{story:1,verticalKN:20}],frameBaseSupportType:'fixed',frameConcreteGrade:'C30',frameColumnSection:'500X500',frameBeamSection:'300X600',
      requestScope:analysisScope,updatedAt:0};
    expect(computeDraftMissing({id:'concrete-frame',handler},state,'execution').critical).not.toContain('frameRebarGrade');
    const model=handler.buildModel(state);
    expect(model.materials[0].E).toBe(30000);
    expect(model.elements).toHaveLength(3);
    expect(model.elements.every(e=>e.rebar_grade===undefined)).toBe(true);
    expect(model.metadata.memberSizing).toBeUndefined();
    const numerical=structuredClone(state);delete numerical.frameConcreteGrade;
    numerical.engineeringDraft={materials:[{id:'elastic',name:'Declared concrete stiffness',type:'concrete',E:31000,nu:0.2,rho:2400}]};
    expect(computeDraftMissing({id:'concrete-frame',handler},numerical,'execution').critical).toEqual([]);
    expect(handler.buildModel(numerical).materials[0].E).toBe(31000);
    const {createRunCodeCheckTool,createGenerateReportTool}=await import('../dist/agent-langgraph/tools.js');
    const config={toolCall:{id:'unrequested'},configurable:{agentState:{requestScope:analysisScope}}};
    const check=await createRunCodeCheckTool({}).invoke({designCode:'GB50010'},config);
    expect(JSON.parse(check.update.messages[0].content)).toMatchObject({success:true,skipped:true,reason:'DESIGN_NOT_REQUESTED'});
    const report=await createGenerateReportTool({}).invoke({message:'ordinary analysis',analysisType:'static'},config);
    expect(JSON.parse(report.update.messages[0].content)).toMatchObject({success:true,skipped:true,reason:'REPORT_NOT_REQUESTED'});
  });

  test('missing stiffness does not block independently determined force outputs', async () => {
    const scope={responses:['forces','displacements'],method:'solver',design:false,report:false,outputs:[
      {field:'forces',elementId:'beam',positionM:5,component:'M2',unit:'kN.m'},
      {field:'displacements',nodeId:'B',component:'uz',unit:'mm'}]};
    const state={draftState:draft(),requestScope:scope,modelRevision:0,modelPending:true,analysisRequestSequence:0};
    const config={toolCall:{id:'partial'},configurable:{agentState:state,engineClient:createLocalAnalysisEngineClient()}};
    const command=await createRunAnalysisTool({}).invoke({method:'equilibrium',
      requestScope:{responses:['forces','reactions'],method:'equilibrium',design:false,report:false,outputs:[]}},config);
    const answer=JSON.parse(command.update.messages[0].content);
    expect(answer).toMatchObject({success:true,deliveryStatus:'partial',capabilityStatus:'partial',missingRequestedResponses:['displacements']});
    expect(answer.requestedQuantities[0].value).toBe(-2.5);
    expect(answer.missingRequestedOutputs).toHaveLength(1);
    const run=await loadAnalysisRun(command.update.analysisResult.runId);
    expect(run.data.displacements).toBeUndefined();
    expect(run.data.missingRequestedResponses).toEqual(['displacements']);
  });

  test.each(['disabled', 'budget'])('automatic requested queries obey server permissions and budget (%s)', async restriction => {
    const {resolveRunPolicy}=await import('../dist/runtime/run-policy.js');
    const {createRunContext,withRunContext,reserveToolCall}=await import('../dist/runtime/run-context.js');
    const policy=resolveRunPolicy({availableSkillIds:[],availableToolIds:['run_analysis','query_results'],defaultToolIds:['run_analysis','query_results'],
      requested:restriction==='disabled'?{tools:{disabledIds:['query_results']}}:{budgets:{maxToolCallsPerTurn:1}}});
    const context=createRunContext(policy);
    const requestedScope={...scope,outputs:[{field:'forces',elementId:'beam',positionM:5,component:'M2',unit:'kN.m'},
      {field:'reactions',nodeId:'A',component:'fz',unit:'kN'}]};
    const state={draftState:draft(),requestScope:requestedScope,modelRevision:0,modelPending:true,analysisRequestSequence:0};
    const answer=await withRunContext(context,async()=>{
      reserveToolCall('run_analysis','parent');
      const command=await createRunAnalysisTool({}).invoke({method:'equilibrium'},{toolCall:{id:'parent'},
        configurable:{agentState:state,engineClient:createLocalAnalysisEngineClient()}});
      return JSON.parse(command.update.messages[0].content);
    });
    expect(answer.success).toBe(true);
    expect(answer.requestedQuantities).toEqual([]);
    expect(answer.missingRequestedOutputs).toHaveLength(2);
    expect(answer.missingRequestedOutputs[0].reason).toContain(restriction==='disabled'?'TOOL_NOT_ALLOWED':'TOOL_CALL_BUDGET_EXHAUSTED');
    expect(context.usage.toolCalls).toBe(1);
    expect(context.usage.recoveries).toBe(0);
    expect(context.usage.pendingFailures).toEqual({});
  });
