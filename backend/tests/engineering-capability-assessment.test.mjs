import { describe, expect, test } from '@jest/globals';
import { assessCurrentEngineeringInput } from '../dist/engineering/capability-assessment.js';
import { beginAnalysisRequest, modelHash } from '../dist/engineering/model-state.js';
import { AgentCapabilityService } from '../dist/services/agent-capability.js';

const model={nodes:[{id:'A',x:0,y:0,z:0}],elements:[],materials:[],sections:[]};
function currentState() {
  const initial={model,modelRevision:2,inputEvidence:[]};
  const state={...initial,...beginAnalysisRequest(initial,'settings')};
  state.analysisResult={success:true,runId:'run',capabilityStatus:'complete',meta:{...state.analysisRequest,modelHash:modelHash(model)}};
  return state;
}

describe('read-only capability assessment separates task state from implementation and environment',()=>{
  test('missing availability is unknown and cannot become a compatible available engine',async()=>{
    const service=new AgentCapabilityService({listSkills:()=>[],listSkillManifests:async()=>[]},
      {listBuiltinSkills:async()=>[],resolveCanonicalSkillId:id=>id},
      {listEngines:async()=>({engines:[{id:'unverified',enabled:true,supportedAnalysisTypes:['static'],supportedModelFamilies:['frame']},
        {id:'missing-sdk',available:false,unavailableReason:'SDK missing',checkedAt:'2026-10-14T00:00:00Z'}]})});
    const matrix=await service.getCapabilityMatrix();
    expect(matrix.engines[0]).toMatchObject({available:false,environment:{status:'unknown',scope:'environment-readiness-only'}});
    expect(matrix.engines[1].environment).toMatchObject({status:'unavailable',reason:'SDK missing',checkedAt:'2026-10-14T00:00:00Z'});
    expect(matrix.analysisCompatibility.static.compatibleEngineIds).toEqual([]);
  });
  test('recommended tools follow the effective run policy; without a policy the matrix is unchanged',async()=>{
    const text={zh:'梁',en:'Beam'};
    const manifests=[{id:'beam',domain:'structure-type',name:text,description:text,stages:['draft'],compatibility:{minRuntimeVersion:'0.1.0',skillApiVersion:'v1'}},
      {id:'validation-core',domain:'validation',name:text,description:text,stages:['analysis'],compatibility:{minRuntimeVersion:'0.1.0',skillApiVersion:'v1'}}];
    const service=new AgentCapabilityService({listSkills:()=>[],listSkillManifests:async()=>manifests},
      {listBuiltinSkills:async()=>[],resolveCanonicalSkillId:id=>id},{listEngines:async()=>({engines:[]})});
    const toolDefinitions=['build_model','validate_model','run_analysis'].map(id=>({id,category:'engineering',risk:'low',defaultEnabled:true}));
    const full=await service.getCapabilityMatrix({toolDefinitions});
    expect(full.enabledToolIdsBySkill.beam).toContain('validate_model');
    expect(full.enabledToolIdsBySkill['validation-core']).toEqual(['validate_model']);
    expect(Object.keys(full.skillIdsByToolId)).toContain('validate_model');
    const gated=await service.getCapabilityMatrix({toolDefinitions,runPolicy:{activeToolIds:['build_model','run_analysis']}});
    expect(gated.enabledToolIdsBySkill.beam).toEqual(['build_model','run_analysis']);
    expect(gated.enabledToolIdsBySkill['validation-core']).toEqual([]);
    expect(Object.keys(gated.skillIdsByToolId).sort()).toEqual(['build_model','run_analysis']);
    expect(gated.tools.map(tool=>tool.id)).toEqual(full.tools.map(tool=>tool.id));
  });
  test('no selected task cannot be called ready',()=>{
    expect(assessCurrentEngineeringInput()).toMatchObject({status:'not_assessed',issues:[]});
    expect(assessCurrentEngineeringInput(undefined,'missing')).toMatchObject({status:'unavailable'});
  });
  test('an observed but unmapped required field blocks even without a previous run',()=>{
    const result=assessCurrentEngineeringInput({model,inputEvidence:[{field:'drawing.span',value:4,unit:'m',status:'observed',required:true}]},'conversation');
    expect(result.status).toBe('needs_attention');
    expect(result.issues.some(item=>item.reason.includes('MODEL_FIELD_REQUIRED'))).toBe(true);
  });
  test('current results are not a claim that code checks ran or passed',()=>{
    const state=currentState();const original=structuredClone(state);
    expect(assessCurrentEngineeringInput(state,'conversation')).toMatchObject({status:'current_result',analysisStatus:'current',codeCheckStatus:'not_current_or_not_run'});
    expect(state).toEqual(original);
  });
  test('current design missing inputs are separate from genuine failures; stale checks are ignored',()=>{
    const state=currentState();
    state.codeCheckResult={meta:{runId:'run'},completionStatus:'incomplete',summary:{passed:0,failed:1,inputRequired:1,unsupported:1},details:[{elementId:'b',resultKey:'D',checks:[{items:[
      {clause:'strength',status:'fail'},{clause:'deflection',status:'input_required'},{clause:'wall',status:'unsupported'}]}]}]};
    const result=assessCurrentEngineeringInput(state,'conversation');
    expect(result.codeCheckCounts).toEqual({passed:0,failed:1,inputRequired:1,unsupported:1});
    expect(result.issues).toEqual([{kind:'code-check',field:'D/b/deflection',reason:'input_required'},{kind:'code-check',field:'D/b/wall',reason:'unsupported'}]);
    state.codeCheckResult.meta.runId='old';
    expect(assessCurrentEngineeringInput(state,'conversation').issues).toEqual([]);
  });
  test('new evidence and partial output stay visible instead of a green skill badge',()=>{
    const state=currentState();state.analysisResult.capabilityStatus='partial';
    expect(assessCurrentEngineeringInput(state,'c').issues).toContainEqual({kind:'result',field:'results',reason:'partial'});
    state.inputEvidence=[{field:'supports.left',status:'missing',required:true}];
    expect(assessCurrentEngineeringInput(state,'c').issues).toContainEqual({kind:'input',field:'supports.left',reason:'missing'});
  });
  test('native design flat records and missing inputs use the same current-task layer',()=>{
    const state=currentState();
    state.codeCheckResult={meta:{runId:'run'},provider:'native',completionStatus:'incomplete',
      missingInputs:[{field:'sections.s',reason:'physical-design-geometry-required'}],
      details:[{id:'b:steel-strength',status:'unsupported'}]};
    expect(assessCurrentEngineeringInput(state,'c').issues).toEqual([
      {kind:'code-check',field:'sections.s',reason:'physical-design-geometry-required'},
      {kind:'code-check',field:'b:steel-strength',reason:'unsupported'},
    ]);
  });
});
