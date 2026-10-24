import {expect,test} from '@jest/globals';
import {toolCall} from './helpers/llm-fixture.mjs';
import {describeWithOpenSees,setupHarness,runTurn,internalResponder,toolResultSeenByAgent,TURN_TIMEOUT_MS} from './helpers/harness.mjs';

describeWithOpenSees('characterization: repair frame node selector namespace before publishing',()=>{
  const ctx=setupHarness();
  test('the column-only selector is repaired by extraction without asking for already supplied node forces',async()=>{
    let attempts=0;
    const draft={engineeringDraft:{structureType:'frame',coordinateSystem:{dimension:'3d'},geometry:{storyHeightsM:[3.6],bayWidthsXM:[4],bayWidthsYM:[5]},
      material:{family:'steel',grade:'Q235'},sections:{column:'300X300',beam:'300X300'},boundary:{frameBaseSupportType:'fixed'},
      loads:[{id:'F',kind:'nodal',magnitude:50,unit:'kN',direction:'gravity',target:'column-top',location:{story:1},caseId:'D',caseType:'dead'}],
      analysis:{type:'static',engineTarget:'opensees'},analysisControl:{self_weight:false}},
      requestScope:{responses:['reactions','displacements'],design:false,report:false,outputs:[]}};
    ctx.llm.setInternal(internalResponder({'param-extractor':()=>{
      const next=structuredClone(draft);if(++attempts>1){delete next.engineeringDraft.loads[0].target;next.engineeringDraft.loads[0].location.nodeRole='all-top-nodes';}
      return next;
    }}));
    const turn=await runTurn(ctx,{message:'Analyze a 3-D single-storey Q235 frame: X span 4m, Y span 5m, height 3.6m. Four fixed-base columns and four rigidly connected roof beams, solid 300x300mm rectangular sections. Each of the four column tops carries 50kN downward in case D. No self weight, no floor pressure, no other loads. Return reactions and displacements only.',
      context:{locale:'en',runPolicy:{skillIds:['frame'],routing:{mode:'fixed',skillId:'frame'}}}},[
      toolCall('extract_draft_params',{locale:'en'},'extract'),toolCall('build_model',{},'build'),
      toolCall('run_analysis',{analysisType:'static',analysisSkillId:'opensees-static'},'run'),'FRAME_DONE',
    ]);
    expect(attempts).toBe(2);
    expect(toolResultSeenByAgent(turn.requests,'extract').criticalMissing).toEqual([]);
    expect(turn.interactions).toEqual([]);
    const session=await ctx.backend.session(turn.conversationId);expect(session.analysis.current).toBe(true);
    const run=(await ctx.backend.get(`/runs/${session.analysis.runId}`)).body;
    const result=run.results['case:D'];
    expect(Object.values(result.data.reactions).reduce((sum,r)=>sum+r.fz,0)).toBeCloseTo(200,8);
  },TURN_TIMEOUT_MS);
});
