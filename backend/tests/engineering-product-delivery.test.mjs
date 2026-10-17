import { describe, expect, test } from '@jest/globals';
import { createEngineeringReport } from '../dist/agent-runtime/engineering-report.js';
import { nativeDesignRecord, resolveCheckProvider } from '../dist/engineering/native-design.js';
import { modelHash } from '../dist/engineering/model-state.js';
import { createQueryResultsTool } from '../dist/agent-langgraph/model-tools.js';
import { assertInputEvidenceMatchesModel, mergeInputEvidence } from '../dist/engineering/input-evidence.js';

const model = { nodes: [{ id: 'A', x: 0, y: 0, z: 0 }], elements: [], materials: [], sections: [] };
const run = () => ({ runId: 'run', success: true, meta: { runId: 'run', modelHash: modelHash(model), engineId: 'builtin-yjk' }, data: {} });
describe('product report and native design provenance', () => {
  test('provider selection never silently replaces commercial native design', () => {
    expect(resolveCheckProvider('auto', run())).toBe('native');
    expect(resolveCheckProvider('builtin', run())).toBe('builtin');
    expect(() => resolveCheckProvider('native', {meta:{engineId:'builtin-opensees'}})).toThrow('NATIVE_DESIGN_ENGINE_REQUIRED');
  });
  test('raw SDK arrays and empty checks cannot become compliance', () => {
    const r = run(); r.data.nativeDesignContext = { request: { requested:true, code:'GB50017' }, eligibleForConclusion:true, status:'completed', missingInputs:[] };
    r.data.nativeDesignResults = { status:'completed', beamAs: [[1,0,0]], checks:[] };
    expect(nativeDesignRecord(model,r,'GB50017')).toMatchObject({completionStatus:'incomplete',complianceStatus:'incomplete'});
    r.data.nativeDesignResults.checks = [{status:'pass',source:{method:'SDK'}}];
    expect(nativeDesignRecord(model,r,'GB50017').complianceStatus).toBe('incomplete');
    r.data.nativeDesignResults.checks[0].nativeCombination = 12;
    expect(nativeDesignRecord(model,r,'GB50017').complianceStatus).toBe('pass');
    r.data.nativeDesignResults.checks[0].status = 'fail';
    expect(nativeDesignRecord(model,r,'GB50017').complianceStatus).toBe('fail');
    expect(nativeDesignRecord(model,r,'different-code').complianceStatus).toBe('incomplete');
    r.data.nativeDesignResults.checks.push(null);
    expect(nativeDesignRecord(model,r,'GB50017').complianceStatus).toBe('incomplete');
  });
  test('residual eligibility cannot publish unfinished native design', () => {
    const r = run();
    r.data.nativeDesignContext = {request:{requested:true,code:'GB50017'},eligibleForConclusion:true,status:'completed',missingInputs:[]};
    r.data.nativeDesignResults = {status:'completed',checks:[{status:'pass',source:{method:'SDK'},nativeCombination:12}]};
    expect(nativeDesignRecord(model,r,'GB50017').complianceStatus).toBe('pass');
    for (const status of [undefined,'running','needs-input','failed']) {
      r.data.nativeDesignContext.status = status;
      expect(nativeDesignRecord(model,r,'GB50017').completionStatus).toBe('incomplete');
      r.data.nativeDesignContext.status = 'completed';
      r.data.nativeDesignResults.status = status;
      expect(nativeDesignRecord(model,r,'GB50017').completionStatus).toBe('incomplete');
      r.data.nativeDesignResults.status = 'completed';
    }
    for (const missingInputs of [[{field:'cover'}],{field:'cover'}]) {
      r.data.nativeDesignContext.missingInputs = missingInputs;
      expect(nativeDesignRecord(model,r,'GB50017').complianceStatus).toBe('incomplete');
    }
  });
  test('required reinforcement completes without certifying installed reinforcement', () => {
    const r = run();
    r.data.nativeDesignContext = {request:{requested:true,code:'GB/T50010-2010(2024)',mode:'required-reinforcement'},eligibleForConclusion:true,status:'completed',missingInputs:[]};
    r.data.nativeDesignResults = {status:'completed',records:[{elementId:'B',component:'top',requiredArea:550,calculatedArea:565,unit:'mm2',source:{method:'SDK.BeamAs'},nativeCombination:{id:2}}]};
    const check = nativeDesignRecord(model,r,'GB/T50010-2010(2024)');
    expect(check).toMatchObject({completionStatus:'complete',complianceStatus:'not_evaluated',reinforcementScope:'required-not-installed'});
    const report = createEngineeringReport({message:'Report',analysisType:'static',analysis:r,codeCheck:check,locale:'en'});
    expect(report.summary).toContain('installed reinforcement was not checked');
    expect(report.markdown).toContain('own software design combinations');
    expect(report.markdown).toContain('| top | 550 | 565 | mm2 |');
    expect(report.markdown).toContain('SDK.BeamAs');
    expect(report.json.keyMetrics.codeCheckPassRate).toBeNull();
    delete r.data.nativeDesignResults.records[0].calculatedArea;
    expect(nativeDesignRecord(model,r,'GB/T50010-2010(2024)').completionStatus).toBe('complete');
    r.data.nativeDesignResults.records.push({elementId:'bad',requiredArea:0});
    expect(nativeDesignRecord(model,r,'GB/T50010-2010(2024)').completionStatus).toBe('incomplete');
  });
  test.each(['required-reinforcement','steel-check'])('native %s failures and per-row provenance survive bilingual delivery', (mode) => {
    const r = run();
    r.data.nativeDesignContext = {request:{requested:true,code:'native-profile',mode},eligibleForConclusion:true,status:'completed',missingInputs:[]};
    r.data.nativeDesignResults = {status:'completed',
      checks:[{elementId:'C1',nativeStationIndex:3,check:'axial-compression-ratio',demand:.91,capacity:.75,unit:'ratio',status:'fail',
        source:{method:'dsnGetColumnAxialCompRatio'},nativeCombination:{id:27}}],
      records:[{elementId:'B',component:'top',requiredArea:550,unit:'mm2',source:{method:'SDK.BeamAs'},nativeCombination:{id:2}}]};
    const check = nativeDesignRecord(model,r,'native-profile');
    expect(check).toMatchObject({completionStatus:'complete',complianceStatus:'fail',summary:{failed:1}});
    if (mode === 'required-reinforcement') expect(check.reinforcementScope).toBe('required-not-installed');
    for (const locale of ['en','zh']) {
      const report = createEngineeringReport({message:'Report',analysisType:'static',analysis:r,codeCheck:check,locale});
      expect(report.markdown).toContain('| C1 | 3 | axial-compression-ratio | 0.91 | 0.75 | ratio | fail | {"id":27} |');
      expect(report.markdown).toContain('dsnGetColumnAxialCompRatio');
      if (mode === 'required-reinforcement') {
        expect(report.summary).toContain(locale === 'zh' ? '1 项原生检查未通过' : '1 native checks failed');
        expect(report.summary).toContain(locale === 'zh' ? '未验算已有配筋' : 'installed reinforcement was not checked');
        expect(report.json.keyMetrics.codeCheckPassRate).toBeNull();
      }
    }
  });
  test.each([['DESIGN_INPUT_REQUIRED','insufficient_data'],['NATIVE_RESULT_UNAVAILABLE','failed'],['SDK_UNAVAILABLE','environment_unavailable'],['DESIGN_MODE_UNSUPPORTED','unsupported']])('native failure %s retains its cause', (error_code,executionStatus) => {
    const r={...run(),success:false,error_code:'RESULT_SET_INCOMPLETE',selectedResultKey:'case:D',results:{'case:D':{success:false,error_code,message:'specific native cause'}}};
    expect(nativeDesignRecord(model,r,'GB50017')).toMatchObject({completionStatus:'incomplete',executionStatus,errorCode:error_code,message:'specific native cause',designStatus:executionStatus});
  });
  test('one report source preserves quantities; mismatched models and design runs fail', () => {
    const r = run(); r.requestedQuantities = [{id:'reaction',runId:'run',selection:'case:D',location:{kind:'node',id:'A'},component:'fz',value:-500,unit:'N'}];
    for (const locale of ['zh','en']) {
      const input = {message:'Report',analysisType:'static',normalizedModel:model,analysis:r,locale};
      const report = createEngineeringReport(input);
      expect(report.json.meta.runId).toBe('run');
      expect(report.markdown).toContain('| reaction | case:D | A | fz | -500 | N |');
      expect(() => createEngineeringReport({...input,normalizedModel:{...model,nodes:[]}})).toThrow('REPORT_MODEL_MISMATCH');
      expect(() => createEngineeringReport({...input,codeCheck:{meta:{runId:'old'},summary:{total:1,passed:1}}})).toThrow('REPORT_DESIGN_RUN_MISMATCH');
    }
  });
});

test('required semantic observations must bind to a stable model field', () => {
  const evidence = [{ id:'drawing:A',field:'support-A-x',status:'observed',required:true,value:0,unit:'m',source:{file:'drawing.pdf',page:1,region:[0,0,.2,.2]} }];
  expect(() => assertInputEvidenceMatchesModel(model,evidence)).toThrow('INPUT_EVIDENCE_MODEL_FIELD_REQUIRED');
  const reviewed = mergeInputEvidence(evidence,[{id:'review-A',field:'support-A-x',status:'resolved',resolution:{selectedSource:'drawing:A',modelField:'nodes.A.x',reason:'Identified support A'}}]);
  expect(() => assertInputEvidenceMatchesModel(model,reviewed)).not.toThrow();
  expect(() => assertInputEvidenceMatchesModel({...model,nodes:[{id:'A',x:1}]},reviewed)).toThrow('INPUT_EVIDENCE_MODEL_VALUE_MISMATCH');
  expect(evidence[0].status).toBe('observed');
});

test('time queries select reactions and physical member ends from the requested frame', async () => {
  const r = { ...run(), data: { responseDefinition:{displacement:'relative'},
    timeHistory:[{time:0.1,timeIndex:0,nodes:{A:{ry:.2}},velocities:{A:{ux:.03,ry:.04}},accelerations:{A:{ux:.05,ry:.06}},reactions:{A:{fz:-.5}},
      forces:{beam:{referenceFrame:'element-local',n1:{M2:3},n2:{M2:0}}}}] } };
  const invoke = args => createQueryResultsTool().invoke({runId:'run',quantityId:'q',timeIndex:0,...args},
    {toolCall:{id:'q'},configurable:{agentState:{analysisRuns:{run:r}}}});
  const reaction = (await invoke({field:'reactions',nodeId:'A',component:'fz',unit:'N'})).update.resultQuantities['run:q'];
  expect(reaction).toMatchObject({value:-500,time:.1,timeIndex:0});
  const force = (await invoke({field:'forces',elementId:'beam',end:'n1',component:'M2',unit:'kN.m'})).update.resultQuantities['run:q'];
  expect(force).toMatchObject({value:3,location:{id:'beam',end:'n1'}});
  expect((await invoke({field:'velocities',nodeId:'A',component:'ux',unit:'mm/s'})).update.resultQuantities['run:q']).toMatchObject({value:30,field:'velocities',time:.1});
  expect((await invoke({field:'accelerations',nodeId:'A',component:'ry',unit:'rad/s2'})).update.resultQuantities['run:q'].value).toBe(.06);
  await expect(invoke({field:'accelerations',nodeId:'A',component:'ux',unit:'m'})).rejects.toThrow('RESULT_UNIT_MISMATCH');
  r.requestedQuantities=[force];
  const report = createEngineeringReport({message:'Time result',analysisType:'dynamic',analysis:r,locale:'en'});
  expect(report.markdown).toContain('t=0.1s [0]'); expect(report.markdown).toContain('beam:n1');
  expect(report.markdown).not.toContain('undefined');
  await expect(invoke({field:'forces',elementId:'beam',positionM:0,component:'M2',unit:'kN.m'})).rejects.toThrow('DYNAMIC_MEMBER_END_REQUIRED');
  r.data.nodalResponseAvailability={A:{ry:false}};
  await expect(invoke({field:'displacements',nodeId:'A',component:'ry',unit:'rad'})).rejects.toThrow('NODE_DOF_RESPONSE_UNAVAILABLE');
});

test('modal queries normalize translations explicitly and cannot claim physical displacement', async () => {
  const r = {...run(),data:{modal:{modes:[{modeNumber:1,modeShape:{A:[0,0,0],B:[-2,1,0]}}]}}};
  const invoke = args => createQueryResultsTool().invoke({runId:'run',quantityId:'mode',modeNumber:1,nodeId:'B',component:'ux',unit:'1',...args},
    {toolCall:{id:'mode'},configurable:{agentState:{analysisRuns:{run:r}}}});
  expect((await invoke({})).update.resultQuantities['run:mode']).toMatchObject({value:-1,unit:'1',modeNumber:1,
    normalization:{method:'maximum-absolute-translational-component',divisor:2,physicalDisplacement:false}});
  await expect(invoke({unit:'mm'})).rejects.toThrow('MODAL_TRANSLATION_REQUIRES_DIMENSIONLESS_UNIT');
  await expect(invoke({component:'ry'})).rejects.toThrow('MODAL_TRANSLATION_REQUIRES_DIMENSIONLESS_UNIT');
  await expect(invoke({field:'forces'})).rejects.toThrow('MODAL_FIELD_UNAVAILABLE');
  expect(r.data.modal.modes[0].modeShape.B).toEqual([-2,1,0]);
});
