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
});
