import {describe,test,expect} from '@jest/globals';
import {pkpmExecutedUniformLoad} from '../dist/engineering/native-load-readback.js';
import {queryPhysicalResponse,scalarResultQuantity,enrichResultData} from '../dist/engineering/result-data.js';

// Values frozen from native input serialization, independent of native end forces.
const start = 0.09999990463256836, end = 5.9000000059604645;
const actualQ = -19.999964792153545;
function fixture(factor = 1) {
  const model = {unit_system:'SI',coordinate_system:{dimension:'3d'},analysis_control:{self_weight:false,rigid_offsets:true},
    stories:[],nodes:[{id:'a',x:0,y:0,z:3},{id:'b',x:6,y:0,z:3}],elements:[{id:'beam',type:'beam',nodes:['a','b']}],
    materials:[],sections:[],load_cases:[{id:'D',loads:[{type:'nodal',node:'a',fz:1},{type:'distributed',element:'beam',wz:-20}]}],
    load_combinations:[{id:'C',factors:{D:factor}}]};
  const row = {loadCaseId:'D',sourceLoadId:'D:1',sourceLoadIndex:1,elementId:'beam',sourceIntervalM:[0,6],
    sourceIntensityVectorKnM:[0,0,-20],elasticIntervalM:[start,end],effectiveElasticIntensityVectorKnM:[0,0,actualQ],
    nativeWireReadback:{nativeCaseId:1,globalZIntensityKnM:-19.33329963684082,
      inputValues:[1,2,0,-19.33329963684082,-19.33329963684082,0,6,31,1],file:'DATA.SAT',byteOffset:53888,nativeFloor:1,nativeOrdinal:1,
      sourceText:'1,5,0,0,-0,19.3333,0,0,0,0,-0,19.3333,0,0,0,0,0,0,0,0,0,0,0,0,0,-1,0',intensityToken:'19.3333',
      sdkValues:[1,19.33333396911621,0,0,0,0],quantization:'SDK-float32 -> native-text-six-significant-digits -> solver-float32',
      files:{'DATA.SAT':'a'.repeat(64),'spas_sat.txt':'b'.repeat(64)}}};
  const context = {engine:'pkpm',engineVersion:'test',physicalModelHash:'frozen',stiffnessHash:'same',settingsHash:'same',
    linearStatic:true,effectiveSettingsVerified:true,stationConventionsVerified:true,
    effectiveRigidOffsets:{verified:true,sourceFeaSha256:'a'.repeat(64),sourceLoadSemanticsPreserved:true,method:'native-rigid-end-readback',
      members:{beam:{physicalLengthM:6,elasticStartM:start,elasticEndM:end,startLengthM:start,endLengthM:6-end,
        sourceNodeIds:['a','b'],nativeStationDomain:'elastic-span',source:{kind:'independent-rigid-arm-fixture'}}},
      loadCompilation:{method:'full-physical-load; elastic-span-plus-rigid-segment-node-integrals',sourceFeaSha256:'a'.repeat(64),
        executionReadbackMethod:'native-text-and-binary-load-record-readback',elementLoads:[row]}}};
  // Closed-form free-end equilibrium. Integrate only the free body to the RIGHT
  // of each cut; neither production anchor integration nor solver forces are used.
  const cut = x => {
    let Vz=0, My=0;
    for(const [a,b,q] of [[0,start,-20],[start,end,actualQ],[end,6,-20]]) {
      const left=Math.max(a,x);
      if(left<b) { Vz-=q*(b-left); My-=q*(b-left)*((left+b)/2-x); }
    }
    return {N:0,Vy:0,Vz:factor*Vz,T:0,My:factor*My,Mz:0};
  };
  const data={units:{force:'kN',moment:'kN.m'},forceSemantics:'simultaneous-signed-stations',nativeContext:context,
    memberStations:{beam:[start,2,4,end].map(positionM=>({positionM,side:'continuous',components:cut(positionM),
      referenceFrame:'element-local',localAxes:[[1,0,0],[0,1,0],[0,0,1]],source:{kind:'independent-free-body-equilibrium'}}))}};
  return {model,row,context,cut,result:{success:true,selection:{kind:'combination',id:'C'},data}};
}

describe('PKPM executed line-load input and physical response',()=>{
  test.each([1,1.5,-1,0])('preserves source rigid-arm loads, audited net load and combination factor %s',factor=>{
    const {model,result,context,cut}=fixture(factor), before=structuredClone({model,result});
    expect(pkpmExecutedUniformLoad(context,'D',1,'beam',6,[start,end],[0,0,-20])).toEqual([0,0,actualQ]);
    for(const x of [0,.031,start,.731,2.731,end,5.971,6]) {
      const response=queryPhysicalResponse(model,result,'beam',x,x===6?'left':'right');
      expect(response.sample.Vz).toBeCloseTo(cut(x).Vz,10);
      expect(response.sample.My).toBeCloseTo(cut(x).My,10);
      expect(scalarResultQuantity(response,'My','N.m',true)).toBeCloseTo(cut(x).My*1000,7);
      if(response.provenance==='mechanics-recovery') expect(response.source.loadBasis).toBe('audited-native-input');
      expect(()=>scalarResultQuantity(response,'uz','mm',true)).toThrow('RESULT_COMPONENT_UNAVAILABLE');
    }
    const chart=enrichResultData(model,result,result.selection).memberResponses[0];
    expect(chart.recovery).toEqual({status:'verified',method:'section-equilibrium'});
    for(const sample of chart.samples) expect(sample.M2).toBeCloseTo(cut(sample.x).My,10);
    expect({model,result}).toEqual(before);
  });

  test.each(['missing-case','missing-index','selfweight-index','duplicate','wrong-member','source-q','source-range','elastic-range',
    'SDK-value','SDK-type','native-q','text-q','precision','case-marker','text-case','direction','offset','input-hash','text-hash','effective-q'])
  ('refuses %s evidence without accepting a fitted force curve',defect=>{
    const {context,row}=fixture(), r=row.nativeWireReadback;
    if(defect==='missing-case')row.loadCaseId='L';
    if(defect==='missing-index')row.sourceLoadIndex=0;
    if(defect==='selfweight-index')row.sourceLoadIndex=null;
    if(defect==='duplicate')context.effectiveRigidOffsets.loadCompilation.elementLoads.push(structuredClone(row));
    if(defect==='wrong-member')row.elementId='another';
    if(defect==='source-q')row.sourceIntensityVectorKnM[2]=-19;
    if(defect==='source-range')row.sourceIntervalM[0]=.1;
    if(defect==='elastic-range')row.elasticIntervalM[0]=.1;
    if(defect==='SDK-value')r.sdkValues[1]=19.333;
    if(defect==='SDK-type')r.sdkValues[0]=2;
    if(defect==='native-q')r.inputValues[3]=-19.3333;
    if(defect==='text-q')r.sourceText=r.sourceText.replaceAll('19.3333','19.3334');
    if(defect==='precision')r.quantization='estimated-from-forces';
    if(defect==='case-marker')r.inputValues[2]=9999;
    if(defect==='text-case')r.sourceText='2'+r.sourceText.slice(1);
    if(defect==='direction')r.inputValues[7]=32;
    if(defect==='offset')r.byteOffset++;
    if(defect==='input-hash')r.files['DATA.SAT']='c'.repeat(64);
    if(defect==='text-hash')delete r.files['spas_sat.txt'];
    if(defect==='effective-q')row.effectiveElasticIntensityVectorKnM[2]=-20;
    expect(()=>pkpmExecutedUniformLoad(context,'D',1,'beam',6,[start,end],[0,0,-20])).toThrow('NATIVE_EXECUTED_LOAD_UNVERIFIED');
  });

  test('custom case input requires its matching official file and case ID',()=>{
    const {context,row}=fixture(), r=row.nativeWireReadback;
    r.file='LoadZDY.SAT';r.nativeCaseId=201;r.files[r.file]='c'.repeat(64);
    r.inputValues[2]=9999;r.inputValues.push(201);r.sourceText='201'+r.sourceText.slice(1);
    expect(pkpmExecutedUniformLoad(context,'D',1,'beam',6,[start,end],[0,0,-20])).toEqual([0,0,actualQ]);
    r.inputValues[9]=202;
    expect(()=>pkpmExecutedUniformLoad(context,'D',1,'beam',6,[start,end],[0,0,-20])).toThrow();
  });

  test('upward global loads retain their sign through both native serializations',()=>{
    const {context,row}=fixture(), r=row.nativeWireReadback;
    row.sourceIntensityVectorKnM[2]=20;
    row.effectiveElasticIntensityVectorKnM[2]=-actualQ;
    r.sdkValues[1]*=-1;r.inputValues[3]*=-1;r.inputValues[4]*=-1;r.globalZIntensityKnM*=-1;
    r.intensityToken='-19.3333';r.sourceText=r.sourceText.replaceAll('19.3333','-19.3333');
    expect(pkpmExecutedUniformLoad(context,'D',1,'beam',6,[start,end],[0,0,20])).toEqual([0,0,-actualQ]);
  });

  test('native disagreement remains a failure at the original force tolerance',()=>{
    const {model,result}=fixture();
    result.data.memberStations.beam[1].components.My+=.01;
    expect(()=>queryPhysicalResponse(model,result,'beam',.731,'right')).toThrow('EXACT_NATIVE_STATION_UNAVAILABLE');
    const chart=enrichResultData(model,result,result.selection).memberResponses[0];
    expect(chart.samples).toHaveLength(4);
    expect(chart.recovery).toMatchObject({status:'unavailable',reason:'NATIVE_FORCE_RECOVERY_UNVERIFIED',
      details:{code:'NATIVE_STATION_EQUILIBRIUM_MISMATCH',memberId:'beam',positionM:2,component:'My',unit:'kN.m'}});
    expect(chart.recovery.details.absoluteDifference).toBeGreaterThan(chart.recovery.details.tolerance);
    let failure;
    try { queryPhysicalResponse(model,result,'beam',.731,'right'); } catch(error) { failure=error; }
    expect(failure.cause.cause).toEqual(chart.recovery.details);
  });
});
