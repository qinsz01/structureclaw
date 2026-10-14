// Public column force delivery from an existing native run; no solver submission.
// The run's separate displacement acceptance remains authoritative and unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import {createHash} from 'node:crypto';
import {verifyNativeRigidDelivery} from './engineering-native-rigid-query.mjs';
import {normalizeEngineeringModel} from '../dist/engineering/model-boundary.js';
import {createLocalStructureProtocolClient} from '../dist/services/structure-protocol-execution.js';

const [directoryArgument,outputArgument]=process.argv.slice(2);
if(!directoryArgument || !outputArgument)throw new Error('Usage: engineering-native-axial-query.mjs <native-directory> <new-receipt.json>');
const directory=path.resolve(directoryArgument);
const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
const model=await normalizeEngineeringModel(read('source.json'),createLocalStructureProtocolClient());
const reference=read('reference.json'),data=read('selected-D-data.json'),acceptance=read('acceptance.json');
assert.equal(data.nativeContext.effectiveLoads.verified,true);
assert.equal(data.nativeContext.effectiveLoads.selfWeight.consistentLoadCompilation.verified,true);
const memberIds=model.elements.filter(member=>member.type==='column').map(member=>member.id);
assert.equal(memberIds.length,4);
const evidence=['source.json','reference-model.json','reference.json','selected-D-data.json','acceptance.json']
  .map(name=>({path:path.join(directory,name),sha256:createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex')}));
let receipt;
try {
  const counts=verifyNativeRigidDelivery({model,referenceModel:read('reference-model.json'),referenceCases:reference.cases,
    memberMap:reference.memberMap,memberIds,cases:{D:data},runId:path.basename(directory)});
  receipt={status:'passed',scope:'D case, four physical columns, six force components; queries/charts/bilingual reports',counts};
}catch(error) {
  const failures=[];
  for(let cause=error;cause instanceof Error;cause=cause.cause)failures.push({message:cause.message,
    ...(cause.cause && !(cause.cause instanceof Error)?{details:cause.cause}:{})});
  receipt={status:'failed',failures};process.exitCode=1;
}
receipt={...receipt,directory,evidence,nativeAcceptance:acceptance,
  interpretation:'Public force delivery only. This does not turn the separately failed native displacement acceptance into a pass.'};
fs.writeFileSync(path.resolve(outputArgument),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt,null,2));
