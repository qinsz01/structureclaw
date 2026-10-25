import {expect,test} from '@jest/globals';
import {regularFrameGeometry,GeometryIdentityError} from '../../../../dist/skill-shared/modelling/geometry.js';
const options={dimension:'3d',bayWidthsX:[4],bayWidthsY:[5],storeyHeights:[3],baseRestraint:'fixed'};

test.each(['2d','3d'])('two-storey %s node maps start at base level zero and end at level two',dimension=>{
  const model=regularFrameGeometry({...options,dimension,storeyHeights:[3.6,3.6],nodeIds:{'0,0,0':'base','1,0,0':'floor-1','2,0,0':'roof'}});
  expect(model.nodes.find(n=>n.id==='base')).toMatchObject({x:0,y:0,z:0});
  expect(model.nodes.find(n=>n.id==='floor-1')).toMatchObject({x:0,y:0,z:3.6});
  expect(model.nodes.find(n=>n.id==='roof')).toMatchObject({x:0,y:0,z:7.2});
  expect(()=>regularFrameGeometry({...options,dimension,storeyHeights:[3.6,3.6],nodeIds:{'3,0,0':'extra'}})).toThrow('MODEL_ID_MAPPING_INVALID');
});
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
