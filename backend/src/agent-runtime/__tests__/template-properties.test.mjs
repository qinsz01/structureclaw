import { describe, expect, test } from '@jest/globals';
import { buildModel } from '../../../dist/agent-runtime/model-builder.js';
import { buildFrameModel } from '../../../dist/agent-skills/structure-type/frame/model.js';
import { normalizeEngineeringDraft, mergeEngineeringDraft } from '../../../dist/agent-runtime/engineering-draft.js';

const beam = () => ({ inferredType:'beam', frameDimension:'2d', lengthM:6, loadKN:10, loadType:'distributed', supportType:'simply-supported', updatedAt:0 });
const material = { id:'M',E:70000,nu:0.3,rho:2700 };
const section = { id:'S',properties:{A:0.02,Iy:2e-4,Iz:3e-4,J:1e-5} };

describe('declared template properties', () => {
  test('missing or unknown physical properties cannot create an executable placeholder model', () => {
    expect(()=>buildModel(beam())).toThrow(/material/);
    expect(()=>buildModel({...beam(), engineeringDraft:{material:{grade:'Q355'}}})).toThrow(/section/);
    expect(()=>buildModel({...beam(), engineeringDraft:{material:{grade:'Q999'},sections:{member:'H300X200X8X12'}}})).toThrow(/unsupported material/);
    expect(()=>buildModel({...beam(), engineeringDraft:{material:{grade:'Q355'},sections:{member:'unlisted'}}})).toThrow(/unsupported section/);
  });
  test('uses explicitly supplied single-role records without requiring hand-authored geometry', () => {
    const state={...beam(),engineeringDraft:{materials:[material],sectionRecords:[section],inputEvidence:[{file:'annex.csv',row:2}]}};
    const model=buildModel(state);
    expect(model.schema_version).toBe('2.2.0');
    expect(model.materials).toEqual([material]); expect(model.sections).toEqual([section]);
    expect(model.elements.every(e=>e.material==='M'&&e.section==='S')).toBe(true);
    expect(model.metadata.inputEvidence).toEqual(state.engineeringDraft.inputEvidence);
  });
  test('requires beam/column role mapping and keeps different materials and sections intact', () => {
    const state={inferredType:'frame',frameDimension:'2d',storyCount:1,bayCount:1,storyHeightsM:[3],bayWidthsM:[6],floorLoads:[{story:1,verticalKN:20}],updatedAt:0,
      engineeringDraft:{materials:[material,{...material,id:'C',E:30000}],sectionRecords:[section,{...section,id:'SC'}]}};
    expect(()=>buildFrameModel(state)).toThrow(/materialId/);
    state.engineeringDraft.templateAssignments={column:{materialId:'C',sectionId:'SC'},beam:{materialId:'M',sectionId:'S'}};
    const model=buildFrameModel(state);
    expect(model.elements.filter(e=>e.type==='column')).toHaveLength(2);
    expect(model.elements.filter(e=>e.type==='beam')).toHaveLength(1);
    expect(model.elements.filter(e=>e.type==='column').every(e=>e.material==='C'&&e.section==='SC')).toBe(true);
    expect(model.elements.filter(e=>e.type==='beam').every(e=>e.material==='M'&&e.section==='S')).toBe(true);
    delete state.engineeringDraft.templateAssignments;
    state.engineeringDraft.materials=[material];state.engineeringDraft.sectionRecords=[section];
    expect(()=>buildFrameModel(state)).toThrow(/sectionId/);
  });
  test('resolves declared grade/section names with no silent catalog substitutions', () => {
    const model=buildModel({...beam(),engineeringDraft:{material:{grade:'Q235'},sections:{member:'H300X200X8X12'}}});
    expect(model.materials[0]).toMatchObject({grade:'Q235',E:206000});
    expect(model.sections[0]).toMatchObject({name:'H300X200X8X12',shape:{H:300,B:200,tw:8,tf:12}});
    expect(model.sections[0].properties.A).toBeCloseTo(0.007008);
  });
  test('normalizes and partially updates explicit role assignment mappings', () => {
    const prior=normalizeEngineeringDraft({templateAssignments:{beam:{materialId:'M',sectionId:'S'},column:{materialId:'C',sectionId:'SC'}}});
    const next=mergeEngineeringDraft(prior,normalizeEngineeringDraft({templateAssignments:{beam:{materialId:'M',sectionId:'SB'}}}));
    expect(next.templateAssignments.column.sectionId).toBe('SC');expect(next.templateAssignments.beam.sectionId).toBe('SB');
    expect(()=>normalizeEngineeringDraft({templateAssignments:{beam:{materialId:'M'}}})).toThrow(/ASSIGNMENTS/);
  });
});

  test('one reviewed named section record is associated by name without redundant user confirmation', () => {
    const s={...section,id:'SEC-1',name:'I32a (reviewed attachment)'};
    const state={...beam(),engineeringDraft:{materials:[material],sectionRecords:[s],sections:{beam:'I32a'}}};
    const model=buildModel(state);
    expect(model.elements.every(e=>e.section==='SEC-1')).toBe(true);
    expect(model.sections[0].properties).toEqual(s.properties);
    expect(()=>buildModel({...state,engineeringDraft:{...state.engineeringDraft,sections:{beam:'different'}}})).toThrow(/sectionId/);
  });
