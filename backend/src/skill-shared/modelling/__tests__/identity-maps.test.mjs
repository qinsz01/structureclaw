import {expect,test} from '@jest/globals';
import {regularFrameGeometry,GeometryIdentityError} from '../../../../dist/skill-shared/modelling/geometry.js';
const options={dimension:'3d',bayWidthsX:[4],bayWidthsY:[5],storeyHeights:[3],baseRestraint:'fixed'};
test('all invalid generated identity-map keys are reported together and never silently ignored',()=>{
  const input={...options,nodeIds:{'2,0,0':'missing-node'},memberIds:{BX1:'missing-beam'},storyIds:{2:'missing-floor'}};
  const before=structuredClone(input);
  let error;try{regularFrameGeometry(input);}catch(e){error=e;}
  expect(error).toBeInstanceOf(GeometryIdentityError);
  expect(error.details.invalidMappings).toEqual([
    expect.objectContaining({field:'nodeIds',invalidKeys:['2,0,0'],availableKeys:expect.arrayContaining(['1,0,0'])}),
    expect.objectContaining({field:'memberIds',invalidKeys:['BX1'],availableKeys:expect.arrayContaining(['BX5','BX6'])}),
    expect.objectContaining({field:'storyIds',invalidKeys:['2'],availableKeys:['1']}),
  ]);
  expect(input).toEqual(before);
});
test('valid source IDs remain on the generated nodes, members and stories',()=>{
  const model=regularFrameGeometry({...options,nodeIds:{'1,1,1':'top-NE'},memberIds:{BX5:'beam-south'},storyIds:{1:'roof'}});
  expect(model.nodes.find(n=>n.id==='top-NE')).toMatchObject({x:4,y:5,z:3,story:'roof'});
  expect(model.elements.find(e=>e.id==='beam-south')).toBeDefined();
  expect(model.stories[0].id).toBe('roof');
});
