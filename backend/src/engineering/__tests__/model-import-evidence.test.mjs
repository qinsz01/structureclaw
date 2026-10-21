import {expect,test} from '@jest/globals';
import {bindImportedModelEvidence,assertInputEvidenceMatchesModel} from '../../../dist/engineering/input-evidence.js';
const model={schema_version:'2.2.0',nodes:[{id:'A',x:0,y:0,z:0}],elements:[]};
const record=(id,field,complete=true,sha256='same')=>({id,field,status:complete?'unread':'truncated',required:true,
 requirement:complete?'field-mapping':'complete-read',source:{file:'model.json',sha256,complete}});
test('model import covers all complete reads of the same source without rewriting them',()=>{
 const sources=[record('first','file:model.json:fields'),record('second','file:model.json:fields')];
 const bound=bindImportedModelEvidence(model,sources,'same');
 expect(bound.slice(0,2)).toEqual(sources);
 expect(()=>assertInputEvidenceMatchesModel(model,bound)).not.toThrow();
 const changed=structuredClone(model);changed.nodes[0].x=1;
 expect(()=>assertInputEvidenceMatchesModel(changed,bound)).toThrow('INPUT_EVIDENCE_IMPORTED_MODEL_CHANGED');
});
test.each([record('truncated','file:model.json:remaining',false),record('other','file:other.json:fields',true,'other')])(
 'import does not resolve truncated or unrelated required evidence', pending=>{
 const bound=bindImportedModelEvidence(model,[record('first','file:model.json:fields'),pending],'same');
 expect(()=>assertInputEvidenceMatchesModel(model,bound)).toThrow('INPUT_EVIDENCE_UNRESOLVED');
});
