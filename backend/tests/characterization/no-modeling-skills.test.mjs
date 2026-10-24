import {describe,expect,test} from '@jest/globals';
import {runTurn,setupHarness,TURN_TIMEOUT_MS} from './helpers/harness.mjs';

describe('characterization: an empty structure-skill scope remains a usable conversation',()=>{
  const ctx=setupHarness();
  test.each(['zh','en'])('binds no unavailable modeling tools and retains existing-model tools (%s)',async locale=>{
    const reply=locale==='zh'?'本轮未启用建模技能，不能从自然语言新建模型。已有或导入模型仍可查询和分析。'
      :'No modeling skill is enabled, so a new natural-language model cannot be built. Existing or imported models can still be queried and analyzed.';
    const turn=await runTurn(ctx,{message:locale==='zh'?'建一个6m简支梁并分析。':'Build and analyze a simply supported 6 m beam.',
      context:{locale,runPolicy:{skillIds:[],routing:{mode:'auto'}}}},[body=>{
        const names=body.tools.map(tool=>tool.function.name);
        for(const name of ['detect_structure_type','extract_draft_params','build_model'])expect(names).not.toContain(name);
        for(const name of ['query_model','query_results','run_analysis','analyze_file'])expect(names).toContain(name);
        expect(body.messages[0].content).toContain(locale==='zh'?'未启用任何结构建模技能':'No structure-modeling skill is enabled');
        return reply;
      }]);
    expect(turn.result.content.response).toBe(reply);
    expect(turn.steps).toEqual([]);
    const session=await ctx.backend.session(turn.conversationId);
    expect(session).toMatchObject({busy:false,waitingForReply:false,policy:{activeSkillIds:[]},analysis:{current:false},modeling:{usedSkillIds:[]}});
    expect((await ctx.backend.inputReview(turn.conversationId)).model).toBeNull();
  },TURN_TIMEOUT_MS);
});
