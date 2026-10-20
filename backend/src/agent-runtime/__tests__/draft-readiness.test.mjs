import { describe, expect, test } from '@jest/globals';
import { computeDraftMissing, buildDraftQuestions } from '../../../dist/agent-runtime/draft-readiness.js';
import { handler } from '../../../dist/agent-skills/structure-type/beam/handler.js';
import { handler as concreteFrameHandler } from '../../../dist/agent-skills/structure-type/concrete-frame/handler.js';

const beam = { inferredType:'beam', frameDimension:'2d', lengthM:6, loadKN:10, loadType:'point', loadPosition:'end', supportType:'cantilever', updatedAt:0 };
const material = { id:'M',name:'Elastic material',E:206000,nu:0.3,rho:7850 };
const section = { id:'S',properties:{A:0.01,Iy:1e-4,Iz:1e-4,J:1e-5} };
const plugin={id:'beam',handler};

describe('unified draft readiness',()=>{
  test.each(['name','E','nu','rho'])('identifies a missing numerical material %s before build or solve', field=>{
    const incomplete={...material};delete incomplete[field];
    const state={...beam,engineeringDraft:{materials:[incomplete],sections:{beam:'100X200'}}};
    const missing=computeDraftMissing(plugin,state,'execution');
    expect(missing.critical).toEqual([`materials.M.${field}`]);
    for(const locale of ['en','zh']){
      const questions=buildDraftQuestions(plugin,missing.critical,[],state,locale);
      expect(questions).toHaveLength(1);
      expect(questions[0]).toMatchObject({paramKey:`materials.M.${field}`,required:true,critical:true});
      expect(questions[0].question).toContain('M');
      expect(questions[0].question).not.toContain('templateProperties');
      if(field==='rho') expect(questions[0].question).toContain('kg/m³');
    }
  });
  test('reports invalid density without inventing a value',()=>{
    const state={...beam,engineeringDraft:{materials:[{...material,rho:0}],sections:{beam:'100X200'}}};
    expect(computeDraftMissing(plugin,state,'execution').critical).toEqual(['materials.M.rho']);
    expect(state.engineeringDraft.materials[0].rho).toBe(0);
  });
  test.each(['interactive','execution'])('asks for physical properties during %s before building',phase=>{
    const missing=computeDraftMissing(plugin,beam,phase);
    expect(missing.critical).toContain('templateProperties');
    for(const locale of ['en','zh']) {
      const question=buildDraftQuestions(plugin,missing.critical,missing.optional,beam,locale).find(q=>q.paramKey==='templateProperties');
      expect(question).toMatchObject({required:true,critical:true});expect(question.question).toMatch(/material|材料/);
      expect(question.question).not.toContain('TEMPLATE_PROPERTY_REQUIRED');
      expect(question.question).not.toContain(' / ');
    }
    expect(computeDraftMissing(plugin,{...beam,engineeringDraft:{materials:[material],sectionRecords:[section]}},phase).critical).toEqual([]);
  });
  test('does not impose a beam template on a generic model route',()=>{
    const generic={id:'generic',handler:{...handler,computeMissing:()=>({critical:[],optional:[]})}};
    expect(computeDraftMissing(generic,beam,'execution').critical).toEqual([]);
  });
  test('uses complete explicit topology directly and identifies invalid references',()=>{
    const state={...beam,engineeringDraft:{topology:{nodes:[{id:'A',x:0,y:0,z:0},{id:'B',x:6,y:0,z:0}],
      members:[{id:'E',type:'beam',nodes:['A','B'],material:'M',section:'S'}]},materials:[material],sectionRecords:[section],loadCases:[]}};
    delete state.lengthM;
    expect(computeDraftMissing(plugin,state,'execution').critical).toEqual([]);
    state.engineeringDraft.topology.members[0].section='absent';
    expect(computeDraftMissing(plugin,state,'execution').critical).toEqual(['engineeringDraft']);
    expect(buildDraftQuestions(plugin,['engineeringDraft'],[],state,'en')[0].question).toContain('unknown section');
  });
  test('checks concrete-specific material fields without demanding frameMaterial',()=>{
    const concrete={id:'concrete-frame',handler:{...concreteFrameHandler,computeMissing:()=>({critical:[],optional:[]})}};
    const state={...beam,inferredType:'frame',frameConcreteGrade:'C30',frameRebarGrade:'HRB400',frameColumnSection:'500X500',frameBeamSection:'300X600'};
    expect(computeDraftMissing(concrete,state,'execution').critical).toEqual([]);
    // The rebar grade is a check input only: its absence never blocks analysis.
    delete state.frameRebarGrade;
    expect(computeDraftMissing(concrete,state,'execution').critical).toEqual([]);
    delete state.frameConcreteGrade;
    expect(computeDraftMissing(concrete,state,'execution').critical).toEqual(['frameConcreteGrade']);
  });
});

  test('analysis with self-weight explicitly disabled does not ask for unused density', () => {
    const withoutDensity={...material};delete withoutDensity.rho;
    const state={...beam,requestScope:{responses:['displacements'],design:false,report:false,outputs:[]},
      engineeringDraft:{materials:[withoutDensity],sections:{beam:'100X200'},analysisControl:{self_weight:false}}};
    expect(computeDraftMissing(plugin,state,'execution').critical).toEqual([]);
    expect(state.engineeringDraft.materials[0].rho).toBeUndefined();
    state.engineeringDraft.analysisControl.self_weight=true;
    expect(computeDraftMissing(plugin,state,'execution').critical).toContain('materials.M.rho');
  });

  test.each([{}, {properties:{}}])('a named section with no numerical definition cannot be reported ready: %j', definition => {
    const state={...beam,engineeringDraft:{materials:[material],sectionRecords:[{id:'S',name:'UNREVIEWED-I999',type:'custom',...definition}]}};
    const missing=computeDraftMissing(plugin,state,'execution');
    expect(missing.critical).toEqual(['templateProperties', 'sectionConfirmation']);
    const questions=buildDraftQuestions(plugin,missing.critical,[],state,'en');
    expect(questions.find(question=>question.paramKey==='templateProperties').question).toContain('section S');
    expect(questions.find(question=>question.paramKey==='sectionConfirmation').suggestedValue)
      .toEqual([{id:'S',name:'UNREVIEWED-I999',fields:['shape'],requiresNumericDefinition:true}]);
  });

test.each([{}, { properties: {} }, { shape: {}, dimensions: {} }])('a name-only section record is a label: no catalog completes it, so its properties are asked for: %j', definition => {
  const state={...beam,engineeringDraft:{materials:[material],sectionRecords:[{id:'S',name:'I20a',type:'custom',...definition}]}};
  expect(computeDraftMissing(plugin,state,'execution').critical).toEqual(['templateProperties', 'sectionConfirmation']);
  expect(state.engineeringDraft.sectionRecords[0].properties?.A).toBeUndefined();
});


describe('analysis readiness is separate from code-check completeness', () => {
  const designFields = ['design.standard', 'design.lateralBracing', 'design.deflectionLimit',
    'designCheck.stabilityCoefficient', 'designCheck.loadApplicationPoint', 'engineeringDraft.designCriteria.strength',
    'designParameters.gammaX', 'engineeringDraft.designParameters.l0', 'material.designStrength'];
  const issues = fields => fields.map(field => ({ field, severity:'ambiguous', reason:'User input is still required.' }));
  const complete = { ...beam, requestScope:{ responses:['forces','displacements'], design:true, report:true, outputs:[] },
    engineeringDraft:{ materials:[material], sectionRecords:[section], analysisControl:{ self_weight:false } },
    draftIssues:issues(designFields), skillState:{ invalidDraftFields:designFields } };

  test.each(['interactive','execution'])('drops code-check inputs from %s model readiness: they neither block nor prompt', phase => {
    const snapshot=JSON.stringify(complete);
    expect(computeDraftMissing(plugin,complete,phase)).toEqual({critical:[],optional:[]});
    // The handler has its own readiness gate; it must agree with the public gate.
    expect(handler.computeMissing(complete,phase)).toEqual({critical:[],optional:[]});
    const model=handler.buildModel(complete);
    expect(model?.nodes.length).toBeGreaterThan(0);
    expect(model?.elements.length).toBeGreaterThan(0);
    expect(JSON.stringify(complete)).toBe(snapshot);
    expect(model?.design?.stabilityCoefficient).toBeUndefined();
  });

  test.each(['loadKN','supportType','materials.M.E','sections.beam','loads[0].direction','unknownPhysicalInput'])(
    'still blocks an unresolved physical input %s even when its draft value exists', field => {
      const state={...complete,draftIssues:[...complete.draftIssues,...issues([field])]};
      expect(computeDraftMissing(plugin,state,'execution').critical).toContain(field);
      expect(handler.buildModel(state)).toBeUndefined();
    });

  test('the generic route also drops design diagnostics without marking analysis unready', () => {
    const generic={id:'generic',handler:{...handler,computeMissing:()=>({critical:[...designFields,'topology.members'],optional:[]})}};
    expect(computeDraftMissing(generic,complete,'execution')).toEqual({critical:['topology.members'],optional:[]});
  });
});
