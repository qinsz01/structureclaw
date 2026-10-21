import { expect, test } from '@jest/globals';
import { handler } from '../../../../../dist/agent-skills/structure-type/frame/handler.js';
import { buildFrameModel } from '../../../../../dist/agent-skills/structure-type/frame/model.js';
import { withDeclaredProperties } from '../../../../../tests/fixtures/declared-template-properties.mjs';

function draft(location, target) {
  const patch = handler.extractDraft({locale:'en', llmDraftPatch:{frameDimension:'2d',storyCount:1,bayCount:2,
    storyHeightsM:[3],bayWidthsM:[6,6],frameBaseSupportType:'fixed',
    engineeringDraft:{structureType:'steel-frame',loads:[{kind:'point',magnitude:10,unit:'kN',direction:'gravity',
      target,location,caseId:'D',caseType:'dead'}]}}});
  return handler.mergeState(undefined,patch);
}

test.each([['span',{story:1,spanIndex:1,xM:3},undefined],['member',{xM:2},'B4']])(
  'preserves a located %s point load without a joint or floor clarification', (_,location,target) => {
    const state=draft(location,target);
    expect(state.floorLoads).toBeUndefined();
    const missing=handler.computeMissing(state,'execution').critical;
    expect(missing).not.toContain('floorLoads');
    expect(missing).not.toContain('frameNodalLoadLocation');
    const model=buildFrameModel(withDeclaredProperties(state));
    expect(model.load_cases).toEqual([expect.objectContaining({id:'D',loads:[expect.objectContaining({
      type:'point',element:'B4',position:location.xM,fz:-10,reference_frame:'global'})]})]);
  });

test.each([{story:1,xM:3},{spanIndex:1,xM:3}])('an incomplete member identity remains missing: %j', location => {
  expect(handler.computeMissing(draft(location),'execution').critical).toContain('frameNodalLoadLocation');
});

test.each([{story:1,spanIndex:3,xM:3},{story:1,spanIndex:1,xM:7},{story:1,spanIndex:1,xM:-1}])(
  'rejects a nonexistent member or out-of-bounds position: %j', location => {
    expect(()=>buildFrameModel(withDeclaredProperties(draft(location)))).toThrow('INVALID_MEMBER_LOAD_LOCATION');
  });
