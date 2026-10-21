import {expect,test} from '@jest/globals';
import {handler} from '../../../../../dist/agent-skills/structure-type/concrete-frame/handler.js';
test('elastic concrete readiness and construction accept the same located nodal loads',()=>{
 const state={inferredType:'frame',skillId:'concrete-frame',structuralTypeKey:'concrete-frame',updatedAt:0,
  requestScope:{responses:['forces','reactions'],design:false,report:false,outputs:[]},frameDimension:'2d',
  storyCount:1,bayCount:1,storyHeightsM:[3.6],bayWidthsM:[6],frameConcreteGrade:'C30',
  frameColumnSection:'500X500',frameBeamSection:'300X600',frameBaseSupportType:'fixed',
  engineeringDraft:{structureType:'frame',material:{family:'concrete',grade:'C30'},sections:{beam:'300X600',column:'500X500'},
   loads:[{kind:'nodal',magnitude:10,unit:'kN',direction:'globalX',location:{story:1,nodeRole:'left-side'}},
    {kind:'nodal',magnitude:20,unit:'kN',direction:'gravity',location:{story:1,nodeRole:'left-side'}}],analysisControl:{self_weight:false}}};
 expect(handler.computeMissing(state,'execution').critical).toEqual([]);
 const model=handler.buildModel(state);
 expect(model).toBeDefined();
 expect(model.load_cases.flatMap(c=>c.loads)).toEqual(expect.arrayContaining([
  expect.objectContaining({type:'nodal',node:'N1_0',fx:10}),expect.objectContaining({type:'nodal',node:'N1_0',fz:-20})]));
 expect(model.analysis_control?.rigid_floor??false).toBe(false);
 expect(model.materials[0].E).toBe(30000);
});
