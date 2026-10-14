// Independent right-hand free body of frozen physical member end actions.
// No production response algorithm, SDK execution or new numerical reference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';
import console from 'node:console';
import { referenceMember, verifyNativeRigidDelivery } from './engineering-native-rigid-query.mjs';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';

const [sourceArgument, outputArgument]=process.argv.slice(2);
if(!sourceArgument || !outputArgument) throw new Error('Usage: engineering-native-interior-query.mjs <completed-native-directory> <new-receipt.json>');
const directory=path.resolve(sourceArgument);
const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
const acceptance=read('acceptance.json');
assert.equal(acceptance.status,'native-completed');
assert.equal(acceptance.completePhysicalOutputAccepted,true);
for(const key of ['timoshenkoChecks','timoshenkoForceChecks','equilibriumChecks']) {
  assert.ok(acceptance[key].length>0 && acceptance[key].every(row=>row.passed===true));
}
const model=await normalizeEngineeringModel(read('frozen-source-model.json'),createLocalStructureProtocolClient());
const reference=read('frozen-timoshenko-reference.json'), native=read('result.json');
const selections=Object.fromEntries([
  ...model.load_cases.map(row=>[row.id,{kind:'case',id:row.id}]),
  ...model.load_combinations.map(row=>[row.id,{kind:'combination',id:row.id}])]);
const factorsFor=id=>selections[id].kind==='case'?{[id]:1}:model.load_combinations.find(row=>row.id===id).factors;
const positions=Object.fromEntries(model.elements.map(member=>[member.id,
  model.load_cases.flatMap(row=>row.loads.filter(load=>load.element===member.id).flatMap(load=>
    load.type==='point'?[load.position]:load.type==='distributed'?[load.start??0,load.end??referenceMember(model,member).length]:[]))]));
const referenceAt=(caseId,memberId,x,side)=>{
  const member=model.elements.find(row=>row.id===memberId), {length,axes}=referenceMember(model,member);
  const end=reference[caseId].localEndActions[memberId].slice(6);
  const force=[0,0,0],lever=[0,0,0],moment=[0,0,0];
  const local=vector=>axes.map(axis=>axis.reduce((sum,value,i)=>sum+value*vector[i],0));
  for(const [id,factor] of Object.entries(factorsFor(caseId))) {
    for(const load of model.load_cases.find(row=>row.id===id).loads) {
      if(load.element!==memberId)continue;
      assert.ok(!load.reference_frame || load.reference_frame==='global');
      if(load.type==='distributed') {
        assert.ok(!load.distribution || load.distribution==='uniform');
        const a=Math.max(x,load.start??0),b=load.end??length;
        if(b<=a)continue;
        const q=local(['wx','wy','wz'].map(key=>(load[key]??0)*factor));
        for(let i=0;i<3;i++) {force[i]+=q[i]*(b-a);lever[i]+=q[i]*(b-a)*((a+b)/2-x);}
      } else {
        assert.equal(load.type,'point');
        const atCut=Math.abs(load.position-x)<=8*Number.EPSILON*Math.max(1,length);
        if(load.position<=0 || load.position>=length || (atCut ? side!=='left':load.position<x))continue;
        const p=local(['fx','fy','fz'].map(key=>(load[key]??0)*factor));
        const m=local(['mx','my','mz'].map(key=>(load[key]??0)*factor));
        for(let i=0;i<3;i++) {force[i]+=p[i];lever[i]+=p[i]*(load.position-x);moment[i]+=m[i];}
      }
    }
  }
  return {N:end[0]+force[0],Vy:-end[1]-force[1],Vz:-end[2]-force[2],T:end[3]+moment[0],
    My:end[4]-end[2]*(length-x)-lever[2]+moment[1],Mz:end[5]+end[1]*(length-x)+lever[1]+moment[2]};
};
const evidence=['frozen-source-model.json','frozen-timoshenko-reference.json','result.json','acceptance.json']
  .map(name=>({path:path.join(directory,name),sha256:createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex')}));
let receipt;
try {
  const counts=verifyNativeRigidDelivery({model,referenceModel:model,referenceCases:reference,referenceAt,positions,selections,
    cases:{...native.caseResults,...native.combinationResults},runId:path.basename(directory)});
  receipt={status:'passed',counts,directory,evidence,referenceMethod:'frozen independent Timoshenko end actions + right-hand cut equilibrium'};
} catch(error) {
  const failures=[];
  for(let cause=error;cause instanceof Error;cause=cause.cause) failures.push({message:cause.message,
    ...(cause.cause && !(cause.cause instanceof Error)?{details:cause.cause}:{})});
  receipt={status:'failed',directory,evidence,failures};process.exitCode=1;
}
fs.writeFileSync(path.resolve(outputArgument),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt,null,2));
