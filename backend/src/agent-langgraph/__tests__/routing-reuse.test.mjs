import { expect, jest, test } from '@jest/globals';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
const extract=jest.fn();
jest.unstable_mockModule('../../../dist/agent-langgraph/param-extractor.js',()=>({invokeParamExtractor:extract}));
const {handler}=await import('../../../dist/agent-skills/structure-type/beam/handler.js');
const {createExtractDraftParamsTool}=await import('../../../dist/agent-langgraph/tools.js');
const match={key:'beam',mappedType:'beam',skillId:'beam',supportLevel:'supported',routingSource:'llm-suggested'};
const plugin={id:'beam',structureType:'beam',manifest:{structuralTypeKeys:['beam']},handler};
async function run(state) {
 const route=jest.fn(async()=>match);
 extract.mockResolvedValue({engineeringDraft:{material:{grade:'Q235'}}});
 const result=await createExtractDraftParamsTool({resolvePluginForType:async()=>plugin,detectStructuralTypeWithLlm:route})
 .invoke({message:'Q235 steel'}, {toolCall:{id:'update'},configurable:{agentState:state}});
 return {route,result};
}
const draft={inferredType:'beam',structuralTypeKey:'beam',skillId:'beam',supportLevel:'supported',routingSource:'llm-suggested',updatedAt:0,
 engineeringDraft:{structureType:'beam',geometry:{lengthM:10},boundary:{supportType:'simply-supported'},loads:[{kind:'point',magnitude:1,unit:'kN',location:{xM:5}}]},
 requestScope:{responses:['forces','reactions'],design:false,report:false,outputs:[]}};
test('parameter replies reuse the accepted LLM route across human turns',async()=>{
 const {route,result}=await run({draftState:draft,messages:[new HumanMessage('Q235 steel')]});
 expect(route).not.toHaveBeenCalled();
 expect(result.update.draftState.skillId).toBe('beam');
});
test('a saved keyword route is not allowed to bypass the LLM',async()=>{
 const {route}=await run({draftState:{...draft,routingSource:'explicit-keyword'},messages:[new HumanMessage('Q235 steel')]});
 expect(route).toHaveBeenCalledTimes(1);
});
test('a fresh detection wins over the saved conversation route',async()=>{
 const changed={...match,key:'cantilever-beam'};
 const {route,result}=await run({draftState:draft,messages:[new HumanMessage('Change to a cantilever'),new ToolMessage({content:JSON.stringify(changed),name:'detect_structure_type',tool_call_id:'route'})]});
 expect(route).not.toHaveBeenCalled();
 expect(result.update.draftState.structuralTypeKey).toBe('cantilever-beam');
});
