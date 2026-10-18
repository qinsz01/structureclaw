import { describe, test, expect, beforeAll } from '@jest/globals';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.SCLAW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-request-scope-'));
let createLocalAnalysisEngineClient, createRunAnalysisTool, createQueryResultsTool;
beforeAll(async () => {
  ({ createLocalAnalysisEngineClient } = await import('../dist/services/analysis-execution.js'));
  ({ createRunAnalysisTool } = await import('../dist/agent-langgraph/tools.js'));
  ({ createQueryResultsTool } = await import('../dist/agent-langgraph/model-tools.js'));
});
const scope = { responses: ['forces', 'reactions'], design: false, report: false, outputs: [] };
const CANTILEVER = { schema_version: '2.2.0', unit_system: 'SI',
  coordinate_system: { semantics: 'global-z-up', version: 1, dimension: '2d', plane: 'xz', dof_order: ['ux','uy','uz','rx','ry','rz'] },
  nodes: [{ id: 'A', x: 0, y: 0, z: 0, restraints: [true,true,true,true,true,true] }, { id: 'B', x: 10, y: 0, z: 0 }],
  materials: [{ id: 'M', name: 'Elastic steel', type: 'steel', E: 206000, nu: 0.3 }],
  sections: [{ id: 'S', name: 'Reviewed custom section', type: 'custom', properties: { A: 0.02, Iy: 0.00006, Iz: 0.00002, J: 0.00004 } }],
  elements: [{ id: 'E', type: 'beam', nodes: ['A','B'], material: 'M', section: 'S' }],
  load_cases: [{ id: 'LC1', type: 'other', loads: [{ id: 'P', type: 'nodal', node: 'B', fz: -1 }] }] };
/** The cantilever normalised through the same boundary as build_model. */
async function cantileverModel() {
  const { normalizeEngineeringModel } = await import('../dist/engineering/model-boundary.js');
  const { createLocalStructureProtocolClient } = await import('../dist/services/structure-protocol-execution.js');
  return normalizeEngineeringModel({ ...CANTILEVER, analysis_control: { self_weight: false } }, createLocalStructureProtocolClient());
}
describe('scoped engineering delivery', () => {
  test('generic no-self-weight model without density reaches real OpenSees and retains units', async () => {
    const { tryBuildGenericModelWithLlm } = await import('../dist/agent-skills/structure-type/generic/llm-model-builder.js');
    const { normalizeEngineeringModel } = await import('../dist/engineering/model-boundary.js');
    const { createLocalStructureProtocolClient } = await import('../dist/services/structure-protocol-execution.js');
    const candidate = CANTILEVER;
    const generated = await tryBuildGenericModelWithLlm({ invoke: async () => ({ content: [{ type: 'text', text: JSON.stringify(candidate) }] }) },
      'Cantilever, ignore self weight', { inferredType: 'beam', updatedAt: 0, engineeringDraft: { analysisControl: { self_weight: false } } }, 'en');
    const model = await normalizeEngineeringModel(generated, createLocalStructureProtocolClient())
      .catch(error => { throw new Error(JSON.stringify(error.detail), { cause: error }); });
    const client = createLocalAnalysisEngineClient();
    const { data } = await client.post('/analyze', { type: 'static', engineId: 'builtin-opensees', model, parameters: {} });
    expect(data.success).toBe(true);
    const state = { analysisRuns: { [data.runId]: data } };
    for (const [nodeId, field, component, unit, value] of [['A','reactions','fz','kN',1], ['A','reactions','my','kN.m',-10],
      ['B','displacements','uz','mm',-1 * 10 ** 3 / (3 * 206000000 * 0.00006) * 1000]]) {
      const result = await createQueryResultsTool().invoke({ runId: data.runId, resultKey: 'case:LC1', nodeId, field, component, unit },
        { toolCall: { id: `query-${component}` }, configurable: { agentState: state } });
      expect(JSON.parse(result.update.messages[0].content).quantity.value).toBeCloseTo(value, 8);
    }
  }, 30000);

  test.each([
    {},
    { requestScope: scope },
    { method: 'modal', analysisType: 'dynamic' },
    { analysisSkillId: 'opensees-static' },
  ])('a saved goal with the retired equilibrium method still reaches the solver (%j)', async selection => {
    const state = { model: { nodes: [], elements: [], materials: [], sections: [], load_cases: [] },
      modelRevision: 1, modelPending: false, requestScope: { ...scope, method: 'equilibrium' } };
    let options;
    const runtime = { executeAnalysisSkill: async value => { options = value; throw new Error('REAL_SOLVER_REACHED'); } };
    await expect(createRunAnalysisTool(runtime).invoke({ analysisType: 'static', ...selection },
      { toolCall: { id: 'changed-method' }, configurable: { agentState: state, toolContext: { skillScope: ['opensees-static', 'opensees-dynamic'] } } })).rejects.toThrow('REAL_SOLVER_REACHED');
    expect(options.model).toBe(state.model);
    expect(options.analysisType).toBe(selection.analysisType ?? 'static');
  });

  test('a partial action plan cannot drop the displacement requested in the full extracted goal', async () => {
    const {resolveExtractedScope}=await import('../dist/engineering/request-scope.js');
    expect(resolveExtractedScope(scope,{responses:['forces','displacements'],design:false,report:false,
      outputs:['unbound_output_label']})).toMatchObject({responses:['forces','reactions','displacements'],outputs:[],design:false});
    expect(resolveExtractedScope(undefined,undefined,scope)).toEqual(scope);
    // The retired method field of a saved goal or an extractor patch is dropped without a diagnostic.
    const diagnostics=[];
    expect(resolveExtractedScope(undefined,{method:'equilibrium',report:true},{...scope,method:'equilibrium'},diagnostics)).toEqual({...scope,report:true});
    expect(diagnostics).toEqual([]);
  });
  test('internal goal patches retain accepted fields and do not weaken the public contract', async () => {
    const {resolveExtractedScope,requestScopeSchema}=await import('../dist/engineering/request-scope.js');
    const previous={...scope,design:true,responses:['forces','displacements']};
    const diagnostics=[];
    expect(resolveExtractedScope(undefined,{responses:[],report:true},previous,diagnostics)).toMatchObject({
      responses:['forces','displacements'],design:true,report:true});
    expect(diagnostics).toContainEqual({field:'requestScope.responses',code:'EXTRACTED_SCOPE_FIELD_IGNORED'});
    const unresolved=[];
    expect(resolveExtractedScope(undefined,{design:true,responses:[]},undefined,unresolved)).toBeUndefined();
    expect(unresolved).toContainEqual({field:'requestScope.responses',code:'REQUEST_GOAL_REQUIRED'});
    expect(()=>requestScopeSchema.parse({...scope,responses:[]})).toThrow();
    expect(()=>requestScopeSchema.parse({...scope,responses:undefined})).toThrow();
    const {requestScopeInputSchema}=await import('../dist/engineering/request-scope.js');
    expect(requestScopeInputSchema.parse({...scope,method:'equilibrium'})).toEqual(scope);
    expect(requestScopeSchema.safeParse({...scope,method:'equilibrium'}).success).toBe(false);
  });
  test('analysis scope avoids reinforcement design', async () => {
    const {handler}=await import('../dist/agent-skills/structure-type/concrete-frame/handler.js');
    const {computeDraftMissing}=await import('../dist/agent-runtime/draft-readiness.js');
    const analysisScope={responses:['displacements','forces'],design:false,report:false,outputs:[]};
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
    // Whether to check or report is the agent's decision; those tools validate state only (no scope gate).
  });

  test.each(['disabled', 'budget'])('automatic requested queries obey server permissions and budget (%s)', async restriction => {
    const {resolveRunPolicy}=await import('../dist/runtime/run-policy.js');
    const {createRunContext,withRunContext,reserveToolCall}=await import('../dist/runtime/run-context.js');
    const policy=resolveRunPolicy({availableSkillIds:[],availableToolIds:['run_analysis','query_results'],defaultToolIds:['run_analysis','query_results'],
      requested:restriction==='disabled'?{tools:{disabledIds:['query_results']}}:{budgets:{maxToolCallsPerTurn:1}}});
    const context=createRunContext(policy);
    const requestedScope={...scope,outputs:[{field:'forces',elementId:'E',positionM:5,component:'M2',unit:'kN.m'},
      {field:'reactions',nodeId:'A',component:'fz',unit:'kN'}]};
    const model=await cantileverModel();
    const state={model,requestScope:requestedScope,modelRevision:1,modelPending:false,analysisRequestSequence:0};
    const runtime={executeAnalysisSkill:async options=>({skillId:'opensees-static',
      result:(await options.postToEngineWithRetry('/analyze',{type:'static',engineId:'builtin-opensees',model:options.model,parameters:options.parameters},
        {retries:0,traceId:options.traceId,tool:'run_analysis'})).data})};
    const answer=await withRunContext(context,async()=>{
      reserveToolCall('run_analysis','parent');
      const command=await createRunAnalysisTool(runtime).invoke({analysisType:'static'},{toolCall:{id:'parent'},
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
});
