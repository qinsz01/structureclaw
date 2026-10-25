import { expect,test } from '@jest/globals';
import {buildModel} from '../../../dist/agent-runtime/model-builder.js';
import {normalizeEngineeringDraft} from '../../../dist/agent-runtime/engineering-draft.js';
import {appliedLoadTotals} from '../../../dist/engineering/model-physics.js';
import {compileTemplateLoadCases} from '../../../dist/agent-runtime/model-builder/load-cases.js';

test('two point loads in different cases keep their own positions, case IDs and combination factors',()=>{
  const state={inferredType:'beam',updatedAt:0,lengthM:6,supportType:'simply-supported',frameDimension:'2d',
    engineeringDraft:{materials:[{id:'M',E:206000,nu:.3,rho:7850}],sectionRecords:[{id:'S',properties:{A:.02,Iy:.0002,Iz:.0001,J:.00005}}],
      loads:[{id:'pD',kind:'point',magnitude:10,unit:'kN',direction:'gravity',target:'beam',location:{xM:2},caseId:'D',caseType:'dead'},
        {id:'pL',kind:'point',magnitude:20,unit:'kN',direction:'gravity',target:'beam',location:{xM:4},caseId:'L',caseType:'live'}],
      loadCases:[{id:'D',type:'dead',description:'Declared dead case',loads:[]},{id:'L',type:'live',loads:[]}],
      analysis:{loadCombinations:[{id:'U',factors:{D:1.2,L:1.6}}]}}};
  const model=buildModel(state);
  expect(appliedLoadTotals(model)).toEqual({D:[0,0,-10],L:[0,0,-20]});
  const loadedX=id=>model.nodes.find(n=>n.id===model.load_cases.find(c=>c.id===id).loads[0].node).x;
  expect(loadedX('D')).toBe(2);expect(loadedX('L')).toBe(4);
  expect(model.load_cases[0].description).toBe('Declared dead case');
  expect(model.load_combinations).toEqual([{id:'U',factors:{D:1.2,L:1.6}}]);
});

test('misplaced node roles and member type selectors cannot poison an accepted frame draft',()=>{
  const source={structureType:'frame',loads:[{id:'p',kind:'nodal',magnitude:10,unit:'kN',direction:'gravity',target:'all-top-nodes'}]};
  expect(()=>normalizeEngineeringDraft(source)).toThrow('LOAD_NODE_ROLE_FIELD_INVALID');
  source.loads[0]={...source.loads[0],target:undefined,selector:{type:'node',coordinate:{axis:'z',eq:3}}};
  expect(()=>normalizeEngineeringDraft(source)).toThrow('LOAD_NODE_SELECTOR_TYPE_INVALID');
});

test('an explicit node ID equal to a formal role remains an exact ID in new and partial topology input',()=>{
  const source={structureType:'frame',topology:{nodes:[{id:'left-side',x:0,y:0,z:3}]},
    loads:[{id:'P',kind:'nodal',magnitude:10,unit:'kN',direction:'gravity',target:'left-side'}]};
  expect(normalizeEngineeringDraft(source).loads[0].target).toBe('left-side');
  expect(normalizeEngineeringDraft({loads:source.loads},source).loads[0].target).toBe('left-side');
});

test('an unassigned source never picks a case based on source ordering',()=>{
  const inputs=[{caseId:'D'},{},{caseId:'L'}],before=structuredClone(inputs);
  for(const order of [inputs,[...inputs].reverse(),[inputs[1],inputs[0],inputs[2]]]) {
    expect(()=>compileTemplateLoadCases(order,undefined,()=>[{node:'N',fz:-10}])).toThrow('LOAD_MAPPING_CASE_REQUIRED');
  }
  expect(inputs).toEqual(before);
  expect(()=>compileTemplateLoadCases([{caseId:'D'}],[{id:'D',loads:'invalid'}],()=>[])).toThrow('DRAFT_LOAD_REPRESENTATION_CONFLICT');
});

test('an atomic endpoint repair validates the replaced member instead of its stale version',()=>{
  const old={topology:{nodes:[{id:'A',x:0,y:0,z:0}],members:[{id:'M',type:'beam',nodes:['A','removed']} ]}};
  const patch={topology:{nodes:[{id:'C',x:3,y:0,z:0}],members:[{id:'M',type:'beam',nodes:['A','C']}]}};
  expect(normalizeEngineeringDraft(patch,old).topology.members[0].nodes).toEqual(['A','C']);
});
