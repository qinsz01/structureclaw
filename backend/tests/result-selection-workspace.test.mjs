import { expect, test } from '@jest/globals';
import { createQueryResultsTool } from '../dist/agent-langgraph/model-tools.js';
import { createRegisteredTools } from '../dist/agent-langgraph/tool-registry.js';
import { resultCatalogEntry, quantityMatchesSelection } from '../dist/engineering/result-selection.js';

const model = { schema_version:'2.1', unit_system:'SI', nodes:[{id:'A',x:0,y:0,z:0},{id:'B',x:4,y:0,z:0}],
  elements:[{id:'beam',node_ids:['A','B'],type:'beam'}], materials:[], sections:[],load_cases:[] };
function run() {
  const child = { success:true, selection:{kind:'analysis',key:'analysis:dynamic',id:'dynamic'}, meta:{runId:'saved'},
    data:{timeHistory:[{time:0,nodes:{B:{uz:0}}},{time:.03,nodes:{B:{uz:-.002}}},{time:.11,nodes:{B:{uz:.001}}}],responseDefinition:{displacement:'relative'}} };
  return {runId:'saved',success:true,analysis_type:'dynamic',selectedResultKey:'analysis:dynamic',modelSnapshot:model,
    results:{'analysis:dynamic':child},meta:{runId:'saved'},data:child.data};
}
const selection = { runId:'saved',resultKey:'analysis:dynamic',field:'displacements',nodeId:'B',component:'uz',unit:'mm',timeIndex:1 };
const invoke = (saved, input) => createQueryResultsTool().invoke(input,{toolCall:{id:'query'},configurable:{agentState:{analysisRuns:{saved}}}});
function output(value) { return typeof value === 'string' ? JSON.parse(value) : JSON.parse(value.content ?? value.update.messages[0].content); }

test('recorded time series uses real nonuniform timestamps, signed scalar units, explicit stride and no nearest sample', async () => {
  const saved=run(); const args={...selection,quantityId:'curve',timeIndex:undefined,series:{}};
  expect(output(await invoke(saved,args)).series).toMatchObject({unit:'mm',interpolation:'none',sampled:false,
    points:[{timeIndex:0,time:0,value:0},{timeIndex:1,time:.03,value:-2},{timeIndex:2,time:.11,value:1}]});
  expect(output(await invoke(saved,{...args,series:{stride:2}})).series).toMatchObject({sampled:true,points:[{timeIndex:0,time:0,value:0},{timeIndex:2,time:.11,value:1}]});
  await expect(invoke(saved,{...args,timeIndex:1})).rejects.toThrow('TIME_SERIES_REQUIRES');
  await expect(invoke(saved,{...args,series:{endIndex:3}})).rejects.toThrow('TIME_SERIES_RANGE');
  delete saved.results['analysis:dynamic'].data.timeHistory[1].nodes.B;
  await expect(invoke(saved,args)).rejects.toThrow('RESULT_NODE_NOT_FOUND');
});

test('historical display uses archived geometry and mode values explicitly remain dimensionless', async () => {
  const saved=run();
  const point=output(await invoke(saved,{...selection,quantityId:'point',includeModelSnapshot:true}));
  expect(point.modelSnapshot.nodes[1].x).toBe(4);
  expect(point.visualizationData).toMatchObject({time:.03,displacements:{B:{uz:-.002}}});
  const modes={modes:[{modeNumber:2,modeShape:{A:[0,0,0],B:[-2,1,0]}}]};
  saved.results['analysis:dynamic'].data=modes;
  const mode=output(await invoke(saved,{...selection,timeIndex:undefined,modeNumber:2,component:'ux',unit:'1',quantityId:'mode',includeModelSnapshot:true}));
  expect(mode.quantity.value).toBe(-1);
  expect(mode.visualizationData.normalization).toMatchObject({physicalDisplacement:false,divisor:2});
  expect(mode.visualizationData.displacements.B).toEqual({ux:-1,uy:.5,uz:0});
  await expect(invoke(saved,{...selection,timeIndex:undefined,modeNumber:2,quantityId:'wrong',unit:'mm'})).rejects.toThrow('DIMENSIONLESS');
  expect(resultCatalogEntry(saved,false)).toMatchObject({runId:'saved',current:false,nodes:['A','B'],members:['beam'],results:[{modes:[{modeNumber:2}]}]});
});

test('selected structured report binds the archived run, location, time and scalar without invoking a model or replacing the current report', async () => {
  const saved=run(); const queried=await invoke(saved,{...selection,quantityId:'point'});
  const state={model:{...model,nodes:[]},analysisRuns:{saved},resultQuantities:queried.update.resultQuantities,modelPending:true,report:{sentinel:'current'}};
  let narrativeCalls=0;
  const tool=createRegisteredTools({workspaceRoot:process.cwd(),skillRuntime:{executeReportSkill(){narrativeCalls++;throw new Error('unexpected model');}}}).find(tool=>tool.name==='generate_report');
  const result=await tool.invoke({message:'selected point',analysisType:'dynamic',locale:'en',selection,narrative:'structured'},
    {toolCall:{id:'report'},configurable:{agentState:state,skillScope:['report-export']}});
  const body=output(result);
  expect(narrativeCalls).toBe(0); expect(result.update.report).toBeUndefined();
  expect(body.report.json.normalizedModel).toEqual(model);
  expect(body.report.json.requestedQuantities).toHaveLength(1);
  expect(body.report.json.requestedQuantities[0]).toMatchObject({value:-2,time:.03,unit:'mm',location:{id:'B'}});
  expect(body.report.json.requestedSelection).toEqual(selection);
  expect(body.report.markdown).toContain('saved');
  await expect(tool.invoke({message:'wrong time',analysisType:'dynamic',selection:{...selection,timeIndex:2},narrative:'structured'},
    {toolCall:{id:'bad-report'},configurable:{agentState:state,skillScope:['report-export']}})).rejects.toThrow('REPORT_SELECTION_QUERY_REQUIRED');
  expect(quantityMatchesSelection(body.report.json.requestedQuantities[0],{...selection,nodeId:'A'},'saved','analysis:dynamic')).toBe(false);
});
