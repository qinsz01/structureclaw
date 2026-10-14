/* global structuredClone */
import {test,expect} from '@jest/globals';
import fs from 'node:fs';
import {URL} from 'node:url';
import {queryPhysicalResponse} from '../dist/engineering/result-data.js';
import {nativeRigidMember} from '../dist/engineering/native-rigid-offsets.js';
import {yjkConsistentAxialGravity} from '../dist/engineering/native-axial-gravity.js';

const original=JSON.parse(fs.readFileSync(new URL('./fixtures/yjk-consistent-axial-load-readback.json',import.meta.url),'utf8'));
function fixture() {
  const {model,data}=structuredClone(original);
  model.unit_system='SI';
  return {model,data};
}
function parts(model,data,id='C00') {
  const context=data.nativeContext,gravity=context.effectiveLoads.selfWeight;
  const member=model.elements.find(row=>row.id===id);
  const segment=gravity.physicalCompilation.find(row=>row.physicalElementId===id);
  const rigid=nativeRigidMember(model,context,member,segment.endM);
  return {context,gravity,segment,rigid,row:gravity.consistentLoadCompilation.members.find(row=>row.physicalElementId===id)};
}
function invoke(model,data) {
  const {context,gravity,segment,rigid}=parts(model,data);
  return yjkConsistentAxialGravity(model,context,gravity,segment,rigid);
}
function nestedMessages(error) {
  const messages=[];
  for(let cause=error;cause instanceof Error;cause=cause.cause)messages.push(cause.message);
  return messages.join(':');
}

test.each([1,-1.5,0])('actual SDK axial load readback recovers physical uniform fields with factor %s',factor=>{
  const {model,data}=fixture(),before=JSON.stringify(data);
  const result={success:true,selection:{kind:'case',id:'D'},data};
  const sourceData=structuredClone(data);
  if(factor!==1) {
    model.load_combinations=[{id:'signed',factors:{D:factor}}];
    result.selection={kind:'combination',id:'signed'};
    for(const rows of Object.values(data.memberStations))for(const row of rows)
      for(const key of Object.keys(row.components))row.components[key]*=factor;
  }
  for(const id of Object.keys(data.memberStations)) {
    const {row,rigid}=parts(model,data,id),end=sourceData.memberStations[id].at(-1).components;
    const q=row.executedPoint.forceVectorKn[2]/row.elasticLengthM;
    const arm=row.nativeNodeAggregates[0].executedTotalForceVectorKn[2]/row.nativeRigidLengthsM[0];
    for(const x of [.071,1.5,2.775,2.9,3]) {
      // Independent right cut: native elastic end + audited loads to the right.
      const expectedN=x<=rigid.end?end.N+q*(rigid.end-x):end.N-arm*(x-rigid.end);
      const response=queryPhysicalResponse(model,result,id,x,x===3?'left':'right');
      expect(response.provenance).toBe('mechanics-recovery');
      expect(response.source.loadBasis).toBe('audited-native-input');
      expect(Math.abs(response.sample.N-factor*expectedN)).toBeLessThanOrEqual(Math.max(1e-5,1e-5*Math.abs(factor*expectedN)));
    }
    const direct=queryPhysicalResponse(model,result,id,rigid.end,'left');
    expect(direct.provenance).toBe('solver-direct');
    expect(direct.sample.N).toBe(data.memberStations[id].at(-1).components.N);
  }
  if(factor===1)expect(JSON.stringify(data)).toBe(before);
});

const defects={
  'missing verification':p=>{p.gravity.consistentLoadCompilation.verified=false;},
  'wrong source hash':p=>{p.gravity.consistentLoadCompilation.sourceModelHash='0'.repeat(64);},
  'wrong final input hash':p=>{p.gravity.consistentLoadCompilation.sourceFeaSha256='0'.repeat(64);},
  'missing geometry hash':p=>{delete p.gravity.consistentLoadCompilation.geometryFeaSha256;},
  'wrong source endpoints':p=>{p.row.sourceNodeIds.reverse();},
  'wrong native endpoints':p=>{p.row.nativeNodeIds.reverse();},
  'wrong rigid lengths':p=>{p.row.nativeRigidLengthsM.reverse();},
  'wrong frame identity':p=>{p.row.nativeFrameId='other';},
  'wrong gravity case':p=>{p.row.loadCaseId='other';},
  'wrong source uniform load':p=>{p.row.sourceIntensityVectorKnM[2]*=1.01;},
  'wrong equivalent force':p=>{p.row.point.forceVectorKn[2]*=1.01;},
  'wrong point coordinate':p=>{p.row.executedPoint.nativePositionM=.75;},
  'wrong local direction':p=>{p.row.executedPoint.nativeDirection='LY';},
  'wrong wire value':p=>{p.row.executedPoint.nativeValues[1]*=-1;},
  'unexecuted source intensity':p=>{p.row.executedPoint.forceVectorKn[2]=p.row.point.forceVectorKn[2];},
  'wrong equivalent nodal work':p=>{p.row.consistentEndForceVectorKn[0][2]*=1.01;},
  'missing arm record':p=>{p.row.rigidSegmentNodeLoads=[];},
  'wrong arm endpoint':p=>{p.row.rigidSegmentNodeLoads[0].sourceNodeId='N000';},
  'wrong arm readback':p=>{p.row.nativeNodeAggregates[0].executedTotalForceVectorKn[2]*=1.01;},
  'duplicate member':p=>{p.gravity.consistentLoadCompilation.members.push(structuredClone(p.row));},
};
test.each(Object.entries(defects))('%s cannot establish physical load execution',(_name,mutate)=>{
  const {model,data}=fixture();mutate(parts(model,data));
  expect(()=>invoke(model,data)).toThrow('NATIVE_AXIAL_GRAVITY_UNVERIFIED');
});
test('rounded aggregate of multiple actions is not assigned to one member',()=>{
  const {model,data}=fixture();
  const {row}=parts(model,data);row.nativeNodeAggregates[0].sourceTotalForceVectorKn[2]-=10;
  expect(()=>invoke(model,data)).toThrow('NATIVE_AXIAL_GRAVITY_NODE_SHARE_UNVERIFIED');
});
test.each(['missing execution record','missing method','changed method','false native point station'])('%s cannot bypass public recovery validation',defect=>{
  const {model,data}=fixture();
  const {gravity}=parts(model,data);
  const actual=gravity.executedCompilation.find(row=>row.physicalElementId==='C00');
  if(defect==='missing execution record')delete gravity.executedCompilation;
  else if(defect==='missing method')delete actual.executionMethod;
  else if(defect==='changed method')actual.executionMethod='uniform';
  else data.memberStations.C00.splice(1,0,{...structuredClone(data.memberStations.C00[0]),positionM:1.5,side:'continuous'});
  let failure;
  try {queryPhysicalResponse(model,{success:true,selection:{kind:'case',id:'D'},data},'C00',.2,'right');}catch(error){failure=error;}
  expect(nestedMessages(failure)).toContain(defect==='false native point station'
    ?'NATIVE_COMPUTATIONAL_STATION_NOT_PHYSICAL':'NATIVE_FORCE_RECOVERY_UNVERIFIED');
  if(defect==='false native point station')expect(()=>queryPhysicalResponse(model,
    {success:true,selection:{kind:'case',id:'D'},data},'C00',1.5,'right')).toThrow('NATIVE_COMPUTATIONAL_STATION_NOT_PHYSICAL');
});
