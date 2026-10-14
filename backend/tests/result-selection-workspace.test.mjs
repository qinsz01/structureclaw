import { expect, test } from '@jest/globals';
import { createQueryResultsTool } from '../dist/agent-langgraph/model-tools.js';
import { createRegisteredTools } from '../dist/agent-langgraph/tool-registry.js';
import { resultCatalogEntry, quantityMatchesSelection } from '../dist/engineering/result-selection.js';
import { scenarios } from './fixtures/opensees-chain-reference.mjs';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { commitModel } from '../dist/engineering/model-state.js';
import { createLocalAnalysisEngineClient } from '../dist/services/analysis-execution.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { AgentSkillRuntime } from '../dist/agent-runtime/index.js';

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

test('scalar IDs are automatic, stable, selection-specific and accepted by the unchanged report provenance gate', async () => {
  const saved = run();
  const first = await invoke(saved, selection);
  const quantity = output(first).quantity;
  expect(quantity.id).toMatch(/^q_[a-f0-9]{64}$/);
  expect(first.update.resultQuantities[`saved:${quantity.id}`]).toEqual(quantity);
  expect(output(await invoke(saved, { ...selection })).quantity.id).toBe(quantity.id);
  for (const changed of [{ timeIndex: 2 }, { unit: 'm' }]) {
    expect(output(await invoke(saved, { ...selection, ...changed })).quantity.id).not.toBe(quantity.id);
  }
  expect(output(await invoke(saved, { ...selection, quantityId: 'caller-label' })).quantity.id).toBe('caller-label');
  await expect(invoke(saved, { ...selection, unit: undefined })).rejects.toThrow('QUANTITY_LOCATION_AND_UNIT_REQUIRED');
  await expect(invoke(saved, { ...selection, unit: 'kN' })).rejects.toThrow('RESULT_UNIT_MISMATCH');
  expect(output(await invoke(saved, { ...selection, timeIndex: undefined, series: {} })).series.points).toHaveLength(3);

  const state = { analysisRuns: { saved }, resultQuantities: first.update.resultQuantities };
  const tool = createRegisteredTools({ workspaceRoot: process.cwd(), skillRuntime: {} }).find(tool => tool.name === 'generate_report');
  const report = args => tool.invoke({ message: 'Selected result', analysisType: 'dynamic', narrative: 'structured', selection: args },
    { toolCall: { id: 'report' }, configurable: { agentState: state, skillScope: ['report-export'] } });
  expect(output(await report(selection)).report.json.requestedQuantities[0]).toEqual(quantity);
  for (const changed of [{ timeIndex: 2 }, { unit: 'm' }, { nodeId: 'A' }, { field: 'reactions' }]) {
    await expect(report({ ...selection, ...changed })).rejects.toThrow('REPORT_SELECTION_QUERY_REQUIRED');
  }
});

test('static member queries explain positions, register automatic scalar IDs and keep physical sides bound', async () => {
  const saved = { runId: 'saved', success: true, selectedResultKey: 'case:D', modelSnapshot: {
    unit_system: 'SI', coordinate_system: { dimension: '3d' }, nodes: [{ id: 'A', x: 0, y: 0, z: 0 }, { id: 'B', x: 4, y: 0, z: 0 }],
    elements: [{ id: 'beam', type: 'beam', nodes: ['A', 'B'] }], materials: [], sections: [], load_cases: [{ id: 'D', loads: [] }],
  }, results: { 'case:D': { success: true, meta: { runId: 'saved' }, data: {
    units: { force: 'kN', moment: 'kN.m' }, forceSemantics: 'simultaneous-signed-stations', nativeContext: { engine: 'yjk', stationConventionsVerified: true },
    memberStations: { beam: [{ positionM: 2, side: 'continuous', referenceFrame: 'element-local',
      components: { N: 0, Vy: 0, Vz: 0, T: 0, My: -2.5, Mz: 0 }, source: 'native-sdk' }] },
  } } } };
  const member = { runId: 'saved', resultKey: 'case:D', elementId: 'beam', field: 'segmentResults' };
  await expect(invoke(saved, member)).rejects.toThrow('positionM in metres');
  const fullPoint = output(await invoke(saved, { ...member, positionM: 2 }));
  expect(fullPoint.quantity).toBeUndefined();
  const scalar = { ...member, positionM: 2, component: 'M2', unit: 'kN.m' };
  const queried = await invoke(saved, scalar);
  const quantity = output(queried).quantity;
  expect(quantity).toMatchObject({ value: -2.5, unit: 'kN.m', location: { kind: 'member', id: 'beam', positionM: 2, side: 'right' } });
  expect(output(await invoke(saved, { ...scalar, side: 'right' })).quantity.id).toBe(quantity.id);
  expect(output(await invoke(saved, { ...scalar, side: 'left' })).quantity.id).not.toBe(quantity.id);
  const state = { analysisRuns: { saved }, resultQuantities: queried.update.resultQuantities };
  const tool = createRegisteredTools({ workspaceRoot: process.cwd(), skillRuntime: {} }).find(tool => tool.name === 'generate_report');
  const report = selected => tool.invoke({ message: 'Member moment', analysisType: 'static', narrative: 'structured', selection: selected },
    { toolCall: { id: 'report' }, configurable: { agentState: state } });
  expect(output(await report(scalar)).report.json.requestedQuantities[0].value).toBe(-2.5);
  await expect(report({ ...scalar, side: 'left' })).rejects.toThrow('REPORT_SELECTION_QUERY_REQUIRED');
  await expect(report({ ...scalar, positionM: 1 })).rejects.toThrow('REPORT_SELECTION_QUERY_REQUIRED');
});

test('real OpenSees reactions and physical member midpoint moments/deflections register and report without caller IDs', async () => {
  const scenario = scenarios.find(item => item.id === 'released-continuous-beam');
  const structureProtocolClient = createLocalStructureProtocolClient();
  const skillRuntime = new AgentSkillRuntime();
  const normalized = await normalizeEngineeringModel(scenario.model, structureProtocolClient);
  const configurable = { skillRuntime, structureProtocolClient, engineClient: createLocalAnalysisEngineClient(),
    skillScope: ['opensees-static'], agentState: { ...commitModel({}, normalized, scenario.id), locale: 'en' } };
  const tools = new Map(createRegisteredTools({ skillRuntime }).map(tool => [tool.name, tool]));
  let sequence = 0;
  const call = async (name, input) => {
    const result = await tools.get(name).invoke(input, { toolCall: { id: `physical-${++sequence}` }, configurable });
    if (result.update) {
      const previous = configurable.agentState;
      configurable.agentState = { ...previous, ...result.update,
        analysisRuns: { ...previous.analysisRuns, ...result.update.analysisRuns },
        resultQuantities: { ...previous.resultQuantities, ...result.update.resultQuantities } };
    }
    return result;
  };
  await call('run_analysis', scenario.analysis);
  const saved = configurable.agentState.analysisResult;
  expect(saved.success).toBe(true);
  const targets = ['case:D-A-R', 'case:D-AB-M-2', 'case:D-AB-u-2'];
  for (const id of targets) {
    const reference = scenario.quantities.find(item => item.id === id);
    const selected = { ...reference.args, runId: saved.runId,
      ...(reference.args.elementId ? { field: 'segmentResults' } : {}) };
    const queried = output(await call('query_results', selected));
    const quantity = queried.quantity;
    expect(quantity.id).toMatch(/^q_[a-f0-9]{64}$/);
    expect(Math.abs(quantity.value - reference.value)).toBeLessThanOrEqual(
      reference.tolerance.absolute + reference.tolerance.relative * Math.abs(reference.value));
    expect(configurable.agentState.resultQuantities[`${saved.runId}:${quantity.id}`]).toEqual(quantity);
    const reported = output(await call('generate_report', { message: 'Verified physical response', analysisType: 'static',
      narrative: 'structured', selection: selected })).report.json;
    expect(reported.requestedQuantities).toEqual([quantity]);
    expect(reported.requestedSelection).toEqual(selected);
    expect(reported.normalizedModel.nodes).toHaveLength(3);
    expect(reported.normalizedModel.elements).toHaveLength(2);
  }
  expect(configurable.agentState.model).toEqual(normalized);
}, 30000);
