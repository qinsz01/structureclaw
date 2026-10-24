import { describe, expect, test } from '@jest/globals';
import { buildModel } from '../../../dist/agent-runtime/model-builder.js';
import { buildFrameModel } from '../../../dist/agent-skills/structure-type/frame/model.js';
import { normalizeEngineeringDraft, mergeEngineeringDraft } from '../../../dist/agent-runtime/engineering-draft.js';

const beam = () => ({ inferredType:'beam', frameDimension:'2d', lengthM:6, loadKN:10, loadType:'distributed', loadPosition:'full-span', supportType:'simply-supported', updatedAt:0 });
const material = { id:'M',E:70000,nu:0.3,rho:2700 };
const section = { id:'S',properties:{A:0.02,Iy:2e-4,Iz:3e-4,J:1e-5} };

describe('declared template properties', () => {
  test('template case declarations retain compiled nodal loads and reject duplicate executable sources', () => {
    const state = { inferredType:'frame',frameDimension:'3d',storyCount:1,bayCountX:1,bayCountY:1,
      storyHeightsM:[3.6],bayWidthsXM:[4],bayWidthsYM:[5],frameBaseSupportType:'fixed',updatedAt:0,
      engineeringDraft:{materials:[material],sectionRecords:[section],
        templateAssignments:{beam:{materialId:'M',sectionId:'S'},column:{materialId:'M',sectionId:'S'}},
        loads:[{id:'F',kind:'nodal',magnitude:50,unit:'kN',direction:'gravity',caseId:'D',caseType:'dead',location:{nodeRole:'all-top-nodes'}}],
        loadCases:[{id:'D',type:'dead',loads:[]}]}};
    const model = buildFrameModel(state);
    expect(model.load_cases).toHaveLength(1);
    expect(model.load_cases[0]).toMatchObject({id:'D',type:'dead'});
    expect(model.load_cases[0].loads).toHaveLength(4);
    expect(model.load_cases[0].loads.every(load=>load.fz===-50)).toBe(true);
    const before = structuredClone(state.engineeringDraft);
    const bad = structuredClone(before);bad.loadCases[0].loads=[{node:'invented-node',fz:50}];
    expect(()=>normalizeEngineeringDraft(bad)).toThrow('DRAFT_LOAD_REPRESENTATION_CONFLICT');
    expect(state.engineeringDraft).toEqual(before);
    expect(()=>normalizeEngineeringDraft({topology:{nodes:[{id:'A',x:0,y:0,z:0}],members:[{id:'bad',nodes:['A','missing'],type:'beam'}]}})).toThrow('INVALID_EXPLICIT_TOPOLOGY');
  });
  test('templates do not invent analysis or design combinations; declared combinations remain exact', () => {
    const state = { ...beam(), engineeringDraft: { materials: [material], sectionRecords: [section] } };
    expect(buildModel(state).load_combinations).toEqual([]);
    state.engineeringDraft.analysis = { loadCombinations: [{ id: 'specified', factors: { LC1: 1.25 } }] };
    expect(buildModel(state).load_combinations).toEqual(state.engineeringDraft.analysis.loadCombinations);
    state.engineeringDraft.analysis.loadCombinations = [];
    expect(buildModel(state).load_combinations).toEqual([]);
  });
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
    const partial=mergeEngineeringDraft(prior,normalizeEngineeringDraft({templateAssignments:{beam:{materialId:'NEW'},column:{}}}));
    expect(partial.templateAssignments.beam).toEqual({materialId:'NEW',sectionId:'S'});
    expect(partial.templateAssignments.column).toEqual(prior.templateAssignments.column);
    expect(mergeEngineeringDraft(prior,normalizeEngineeringDraft({templateAssignments:{beam:{materialId:' ',sectionId:null},column:null}})).templateAssignments).toEqual(prior.templateAssignments);
    expect(()=>normalizeEngineeringDraft({templateAssignments:{beam:{materialId:42}}})).toThrow(/ASSIGNMENTS/);
  });
  test('a partial draft mapping preserves supplied properties while unresolved physical choices still block execution', () => {
    const draft=normalizeEngineeringDraft({materials:[material],sectionRecords:[section],templateAssignments:{beam:{materialId:'M'},column:{}}});
    const model=buildModel({...beam(),engineeringDraft:draft});
    expect(model.elements.every(e=>e.material==='M'&&e.section==='S')).toBe(true);
    expect(model.materials).toEqual([material]);expect(model.sections).toEqual([section]);
    expect(()=>buildModel({...beam(),engineeringDraft:{...draft,materials:[material,{...material,id:'OTHER'}],templateAssignments:{beam:{sectionId:'S'}}}})).toThrow(/materialId/);
    expect(()=>buildModel({...beam(),engineeringDraft:{...draft,sectionRecords:[section,{...section,id:'OTHER'}]}})).toThrow(/sectionId/);
    expect(()=>buildModel({...beam(),engineeringDraft:{...draft,templateAssignments:{beam:{materialId:'UNKNOWN'}}}})).toThrow(/materialId/);
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

  test.each(['Q235B', 'Q235D', 'Q355B', 'Q345E'])('preserves declared quality grade %s while resolving its elastic properties', grade => {
    const model = buildModel({...beam(), engineeringDraft:{material:{grade}, sections:{beam:'100X200'}}});
    expect(model.materials[0]).toMatchObject({name:grade, grade, E:206000, nu:0.3, rho:7850});
  });
  test('unknown quality suffixes remain unsupported', () => {
    expect(() => buildModel({...beam(), engineeringDraft:{material:{grade:'Q235X'}, sections:{beam:'100X200'}}})).toThrow(/unsupported material/);
  });

  test('a rolled designation without dimensions is a label: no catalog supplies its properties', () => {
    expect(()=>buildModel({...beam(),engineeringDraft:{material:{grade:'Q235B'},sections:{beam:'I20a'}}})).toThrow(/unsupported section I20a/);
    expect(()=>buildModel({...beam(),engineeringDraft:{material:{grade:'Q235B'},sections:{beam:'HN300×150'}}}))
      .toThrow(/web thickness tw and flange thickness tf/);
  });

  test.each(['HN300×150×6.5×9', 'H300x150x6.5x9', 'hn300X150X6.5X9'])('a four-dimension designation %s is sharp-corner H geometry', designation => {
    const model=buildModel({...beam(),engineeringDraft:{material:{grade:'Q355'},sections:{beam:designation}}});
    expect(model.sections[0]).toMatchObject({type:'H',shape:{kind:'H',H:300,B:150,tw:6.5,tf:9}});
    const hw=300-18;
    expect(model.sections[0].properties.Iy).toBeCloseTo((6.5*hw**3/12+2*(150*9**3/12+150*9*((hw+9)/2)**2))/1e12,14);
  });

test('name-only section records parse a full designation and preserve IDs, purpose and notes without mutating the draft', () => {
  const record={id:'USER-SECTION',name:'H型钢 HN300×150×6.5×9',type:'custom',purpose:'column',standard_steel_name:'HN300×150×6.5×9',extra:{note:'supplied label'}};
  const state={...beam(),engineeringDraft:{materials:[material],sectionRecords:[record]}};
  const model=buildModel(state);
  expect(model.sections[0]).toMatchObject({id:'USER-SECTION',name:'H型钢 HN300×150×6.5×9',type:'H',purpose:'column',
    shape:{kind:'H',H:300,B:150,tw:6.5,tf:9},extra:{note:'supplied label'}});
  expect(model.sections[0]).not.toHaveProperty('standard_steel_name');
  expect(model.elements.every(row=>row.section==='USER-SECTION')).toBe(true);
  expect(record).not.toHaveProperty('shape');
  expect(()=>buildModel({...beam(),engineeringDraft:{materials:[material],sectionRecords:[{id:'S',name:'I20a',type:'custom'}]}}))
    .toThrow(/section S \(I20a\): provide explicit dimensions/);
  // A word ending in "h" before dimensions is not an H designation.
  expect(()=>buildModel({...beam(),engineeringDraft:{materials:[material],sectionRecords:[{id:'S',name:'width 300×150',type:'custom'}]}}))
    .toThrow(/section S \(width 300×150\): provide explicit dimensions/);
});

test('explicit numerical or geometric inputs under a designation name are used as given', () => {
  const record={id:'S',name:'I20a',type:'custom',properties:{A:.004,Iy:.00003,Iz:.000002}};
  const model=buildModel({...beam(),engineeringDraft:{materials:[material],sectionRecords:[record]}});
  expect(model.sections[0].properties).toEqual(record.properties);
  expect(model.sections[0].extra?.catalogSource).toBeUndefined();
  expect(()=>buildModel({...beam(),engineeringDraft:{materials:[material],sectionRecords:[{id:'S',name:'I20a',type:'custom',width:120}]}})).toThrow(/provide explicit dimensions/);
});


test.each([['Q235', 7850], ['Q355B', 7850], ['C30', 2500]])('fills omitted density even with explicit E: %s', async (grade, rho) => {
  const { completeDeclaredGradeMaterials } = await import('../../../dist/agent-runtime/template-properties.js');
  const input = [{ id: 'M', name: grade, E: 123456, nu: .23 }];
  const result = completeDeclaredGradeMaterials(input);
  expect(result[0]).toMatchObject({ ...input[0], rho });
  expect(result[0].G).toBeUndefined();
  expect(input[0].rho).toBeUndefined();
  expect(completeDeclaredGradeMaterials([{ ...input[0], rho: 999 }])[0].rho).toBe(999);
  expect(completeDeclaredGradeMaterials([{ id: 'X', name: 'unknown', E: 1 }])[0].rho).toBeUndefined();
});

test.each([['Q235钢', 206000, 7850], ['Q355B钢材', 206000, 7850], ['Q235 steel', 206000, 7850],
  ['steel Q235', 206000, 7850], ['C30混凝土', 30000, 2500], ['concrete C30', 30000, 2500]])(
  'a bilingual grade display name supplies omitted elastic constants and density: %s', async (name, E, rho) => {
    const { completeDeclaredGradeMaterials } = await import('../../../dist/agent-runtime/template-properties.js');
    const input = [{ id: 'M', name }];
    expect(completeDeclaredGradeMaterials(input)[0]).toMatchObject({ id: 'M', name, E, rho });
    expect(input[0]).not.toHaveProperty('E');
    expect(completeDeclaredGradeMaterials([{ ...input[0], E: 123, rho: 456 }])[0]).toMatchObject({ E: 123, rho: 456 });
    expect(completeDeclaredGradeMaterials([{ id: 'X', name: 'Q235/Q355 steel' }])[0]).not.toHaveProperty('rho');
  });

test('a declared grade supplies a missing display name without another material question', async () => {
  const { completeDeclaredGradeMaterials } = await import('../../../dist/agent-runtime/template-properties.js');
  expect(completeDeclaredGradeMaterials([{ id: 'M', grade: 'Q235' }])[0])
    .toMatchObject({ id: 'M', name: 'Q235', grade: 'Q235', E: 206000, rho: 7850 });
});


test('an omitted self-weight switch is not a missing input, while explicit conflicts survive', async () => {
  const { mergeDraftState } = await import('../../../dist/agent-runtime/draft/boundary.js');
  const issue = { field: 'analysisControl.self_weight', kind: 'missing', severity: 'ambiguous', reason: 'not specified' };
  expect(mergeDraftState(undefined, { engineeringDraft: {}, draftIssues: [issue] }).draftIssues ?? []).toEqual([]);
  expect(mergeDraftState(undefined, { engineeringDraft: { analysisControl: { self_weight: true } },
    draftIssues: [{ ...issue, kind: 'confirmation', severity: 'conflict' }] }).draftIssues).toHaveLength(1);
});
