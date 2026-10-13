import { describe, expect, test } from '@jest/globals';
import { assertInputEvidenceMatchesModel, mergeInputEvidence } from '../dist/engineering/input-evidence.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { applyModelEdits } from '../dist/engineering/model-state.js';

const model = () => ({ nodes:[{id:'A',x:4,y:0,z:0,restraints:[true,true,true,false,false,false]}, {id:'B',x:8,y:0,z:0}],
  elements:[{id:'e',type:'beam',nodes:['A','B'],material:'m',section:'s'}],
  materials:[{id:'m',E:200000,G:80000,nu:.25,rho:7850}], sections:[{id:'s',properties:{A:.002,Iy:1e-5}}],
  load_cases:[{id:'D',loads:[{id:'p',type:'point',element:'e',position:2,fz:-.5}]}] });
const review = (field,value,unit,extra={}) => mergeInputEvidence([], [{id:`review:${field}`,field,status:'resolved',required:true,
  resolution:{value,unit,reason:'Explicit engineering review',...extra}}]);

describe('reviewed engineering values must be applied to the physical model', () => {
  test('a selected source binds the actual coordinate, not merely the evidence status', () => {
    const observations = [{id:'old',field:'nodes.A.x',value:4,unit:'m',status:'observed',required:true},
      {id:'drawing',field:'nodes.A.x',value:5000,unit:'mm',status:'observed',required:true}];
    const evidence = mergeInputEvidence(observations, [{id:'review',field:'nodes.A.x',required:true,status:'resolved',
      resolution:{selectedSource:'drawing',reason:'Reviewed updated dimension'}}]);
    const current = model();
    expect(() => assertInputEvidenceMatchesModel(current,evidence)).toThrow('INPUT_EVIDENCE_MODEL_VALUE_MISMATCH');
    current.nodes[0].x = 5;
    expect(() => assertInputEvidenceMatchesModel(current,evidence)).not.toThrow();
  });

  test('force, modulus, section area/inertia and load position use declared units', () => {
    for (const [field,value,unit] of [['load_cases.D.loads.p.fz',-500,'N'], ['materials.m.G',80,'GPa'],
      ['sections.s.properties.A',2000,'mm²'], ['sections.s.properties.Iy',10000000,'mm^4'],
      ['load_cases.D.loads.p.position',200,'cm'], ['materials.m.nu',25,'%']]) {
      expect(() => assertInputEvidenceMatchesModel(model(),review(field,value,unit))).not.toThrow();
    }
    expect(() => assertInputEvidenceMatchesModel(model(),review('load_cases.D.loads.p.fz',500,'N'))).toThrow('VALUE_MISMATCH');
  });

  test('missing units, unsupported units and wrong dimensional families are rejected', () => {
    for (const [unit,code] of [[undefined,'UNIT_REQUIRED'], ['ft','UNIT_UNSUPPORTED'], ['MPa','UNIT_UNSUPPORTED']]) {
      expect(() => assertInputEvidenceMatchesModel(model(),review('nodes.A.x',4,unit))).toThrow(code);
    }
    expect(() => assertInputEvidenceMatchesModel(model(),review('nodes.A.x','4','m'))).toThrow('VALUE_MISMATCH');
  });

  test('noncanonical engineering labels require an explicit stable model-field mapping', () => {
    expect(() => assertInputEvidenceMatchesModel(model(),review('drawing.dimension-A',4000,'mm'))).toThrow('MODEL_FIELD_REQUIRED');
    expect(() => assertInputEvidenceMatchesModel(model(),review('drawing.dimension-A',4000,'mm',{modelField:'nodes.A.x'}))).not.toThrow();
    expect(() => assertInputEvidenceMatchesModel(model(),review('drawing.dimension-A',4000,'mm',{modelField:'nodes.unknown.x'}))).toThrow('NOT_FOUND_OR_AMBIGUOUS');
    expect(() => assertInputEvidenceMatchesModel(model(),review('nodes.A.x',8,'m',{modelField:'nodes.B.x'}))).toThrow('MODEL_FIELD_CONFLICT');
  });

  test('stable IDs survive reordering and dotted IDs resolve without numeric array indexes', () => {
    const current=model(); current.nodes.reverse(); current.load_cases[0].loads[0].id='p.1';
    expect(() => assertInputEvidenceMatchesModel(current,review('load_cases.D.loads.p.1.position',2,'m'))).not.toThrow();
    expect(() => assertInputEvidenceMatchesModel(current,review('nodes.0.x',8,'m'))).toThrow('NOT_FOUND_OR_AMBIGUOUS');
    current.nodes=[{id:'A',b:{x:4}},{id:'A.b',x:4}];
    expect(() => assertInputEvidenceMatchesModel(current,review('nodes.A.b.x',4,'m'))).toThrow('NOT_FOUND_OR_AMBIGUOUS');
  });

  test('last explicit review supersedes old review, while subsequent evidence reopens the conflict', () => {
    const first=review('nodes.A.x',5,'m');
    const latest=mergeInputEvidence(first,[{id:'review:corrected',field:'nodes.A.x',status:'resolved',required:true,
      resolution:{value:4,unit:'m',reason:'Corrected transcription'}}]);
    expect(() => assertInputEvidenceMatchesModel(model(),latest)).not.toThrow();
    const later=mergeInputEvidence(latest,[{id:'new',field:'nodes.A.x',status:'observed',required:true,value:6,unit:'m'}]);
    expect(() => assertInputEvidenceMatchesModel(model(),later)).toThrow('INPUT_EVIDENCE_UNRESOLVED');
  });

  test('normalized observations retain their normalized unit and booleans compare exactly', () => {
    const evidence=mergeInputEvidence([{id:'source',field:'nodes.A.x',value:4000,unit:'mm',normalizedValue:4,normalizedUnit:'m',status:'observed'}],
      [{id:'review',field:'nodes.A.x',status:'resolved',resolution:{selectedSource:'source',reason:'Confirmed dimension'}}]);
    expect(() => assertInputEvidenceMatchesModel(model(),evidence)).not.toThrow();
    expect(() => assertInputEvidenceMatchesModel(model(),review('nodes.A.restraints',[true,true,true,false,false,false]))).not.toThrow();
    expect(() => assertInputEvidenceMatchesModel(model(),review('nodes.A.restraints',[false,true,true,false,false,false]))).toThrow('VALUE_MISMATCH');
    expect(() => assertInputEvidenceMatchesModel(model(),review('sections.s.properties',{A:.002},'m2'))).toThrow('SCALAR_MAPPING_REQUIRED');
  });

  test('workflow acknowledgments do not masquerade as engineering field assignments', () => {
    const evidence=[...review('file:scan.pdf:1','read'),...review('coverage.supports','reviewed')];
    expect(() => assertInputEvidenceMatchesModel(model(),evidence)).not.toThrow();
    expect(() => assertInputEvidenceMatchesModel(model(),review('supports.left','pin'))).toThrow('MODEL_FIELD_REQUIRED');
  });

  test('an unrelated edit cannot clear a pending reviewed coordinate during normalization', async () => {
    const current=model(); current.metadata={inputEvidence:review('nodes.A.x',5,'m')};
    const unrelated=applyModelEdits(current,[{operation:'update',collection:'materials',id:'m',values:{name:'steel'}}]);
    const protocol={post:async (_path,payload) => ({data:{model:structuredClone(payload.model)}})};
    await expect(normalizeEngineeringModel(unrelated,protocol)).rejects.toThrow('VALUE_MISMATCH');
    const applied=applyModelEdits(unrelated,[{operation:'update',collection:'nodes',id:'A',values:{x:5}}]);
    await expect(normalizeEngineeringModel(applied,protocol)).resolves.toMatchObject({nodes:expect.arrayContaining([{id:'A',x:5,y:0,z:0,restraints:[true,true,true,false,false,false]}])});
  });
});
