import { expect, test } from '@jest/globals';
import { AIMessage } from '@langchain/core/messages';
import { resolveRunPolicy } from '../dist/runtime/run-policy.js';
import { createRunContext, withRunContext } from '../dist/runtime/run-context.js';
import { executeToolsSequentially } from '../dist/agent-langgraph/sequential-tools.js';
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
  // Providers sometimes emit the documented default for a single-result query.
  // It must neither trigger a comparison nor change the signed scalar or its ID.
  const defaulted = output(await invoke(saved, { ...scalar, comparison: 'absolute-max' }));
  expect(defaulted.quantity).toEqual(quantity);
  expect(defaulted.values).toEqual(output(queried).values);
  expect(defaulted.comparison).toBeUndefined();
  for (const comparison of ['max', 'min']) {
    await expect(invoke(saved, { ...scalar, comparison })).rejects.toThrow('RESULT_COMPARISON_KEYS_REQUIRED');
  }
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


test('solver mesh receipts distinguish internal nodes and expose physical cuts for midpoint displacement queries', async () => {
  const structureProtocolClient = createLocalStructureProtocolClient();
  const skillRuntime = new AgentSkillRuntime();
  const normalized = await normalizeEngineeringModel({
    schema_version: '2.2.0', unit_system: 'SI',
    coordinate_system: { semantics: 'global-z-up', version: 1, dimension: '2d', plane: 'xz',
      dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] },
    analysis_control: { self_weight: false },
    nodes: [{ id: 'A', x: 0, y: 0, z: 0, restraints: [true, true, true, true, false, true] },
      { id: 'B', x: 4, y: 0, z: 0, restraints: [false, true, true, true, false, true] }],
    elements: [{ id: 'beam', type: 'beam', nodes: ['A', 'B'], material: 'steel', section: 'rect' }],
    materials: [{ id: 'steel', name: 'Elastic steel', E: 200000, nu: .3, rho: 7850 }],
    sections: [{ id: 'rect', name: '100 x 200 mm', type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 } }],
    load_cases: [{ id: 'D', type: 'other', loads: [{ type: 'point', element: 'beam', position: 2, fz: -1 }] }],
    load_combinations: [],
  }, structureProtocolClient);
  const configurable = { skillRuntime, structureProtocolClient, engineClient: createLocalAnalysisEngineClient(),
    skillScope: ['opensees-static'], agentState: { ...commitModel({}, normalized, 'interior-point-load'), locale: 'en' } };
  const tools = new Map(createRegisteredTools({ skillRuntime }).map(tool => [tool.name, tool]));
  const analyzed = await tools.get('run_analysis').invoke({ analysisType: 'static', analysisSkillId: 'opensees-static', loadCaseIds: ['D'] },
    { toolCall: { id: 'mesh-analysis' }, configurable });
  configurable.agentState = { ...configurable.agentState, ...analyzed.update };
  const saved = configurable.agentState.analysisResult;
  expect(saved.success).toBe(true);
  const query = input => tools.get('query_results').invoke({ runId: saved.runId, resultKey: 'case:D', ...input },
    { toolCall: { id: 'mesh-query' }, configurable });
  const receipt = output(await query({ field: 'solverMesh' }));
  expect(receipt.queryGuidance.nodeIdsByField.displacements.sort()).toEqual(['A', 'B']);
  const interior = receipt.queryGuidance.internalNodeLocations.find(node =>
    node.memberPositions.some(position => position.elementId === 'beam' && position.positionM === 2));
  expect(interior).toMatchObject({ queryableAsNode: false, memberPositions: expect.arrayContaining([
    { elementId: 'beam', positionM: 2, side: 'left' }, { elementId: 'beam', positionM: 2, side: 'right' },
  ]) });
  expect(receipt.values.nodes.find(node => node.id === interior.solverNodeId)).toMatchObject({ physicalNodeId: null, x: 2 });
  expect(receipt.queryGuidance.instruction).toContain('内部节点ID');
  expect(receipt.queryGuidance.instruction).toContain('elementId + positionM');
  await expect(query({ field: 'displacements', nodeId: interior.solverNodeId, component: 'uz', unit: 'mm' }))
    .rejects.toThrow('RESULT_NODE_NOT_FOUND');
  const physical = output(await query({ field: 'displacements', elementId: 'beam', positionM: 2, component: 'uz', unit: 'mm' }));
  expect(physical.quantity.value).toBeCloseTo(-.1, 10);
  expect(physical.quantity.location).toMatchObject({ kind: 'member', id: 'beam', positionM: 2 });
  expect(configurable.agentState.model).toEqual(normalized);
}, 30000);

test('real physical nodal queries without field resolve only the documented component/unit and preserve report binding', async () => {
  const protocol = createLocalStructureProtocolClient();
  const skillRuntime = new AgentSkillRuntime();
  const normalized = await normalizeEngineeringModel({
    schema_version: '2.2.0', unit_system: 'SI',
    coordinate_system: { semantics: 'global-z-up', version: 1, dimension: '2d', plane: 'xz',
      dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] },
    analysis_control: { self_weight: false },
    nodes: [{ id: '1', x: 0, y: 0, z: 0, restraints: [true, true, true, true, false, true] },
      { id: '2', x: 2, y: 0, z: 0 },
      { id: '3', x: 4, y: 0, z: 0, restraints: [false, true, true, true, false, true] }],
    elements: [{ id: '1', type: 'beam', nodes: ['1', '2'], material: 'steel', section: 'rect' },
      { id: '2', type: 'beam', nodes: ['2', '3'], material: 'steel', section: 'rect' }],
    materials: [{ id: 'steel', name: 'Elastic steel', E: 200000, nu: .3, rho: 7850 }],
    sections: [{ id: 'rect', name: '100 x 200 mm', type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 } }],
    load_cases: [{ id: 'LC1', type: 'other', loads: [{ id: 'P', type: 'nodal', node: '2', fz: -1 }] }],
    load_combinations: [],
  }, protocol);
  const configurable = { skillRuntime, structureProtocolClient: protocol, engineClient: createLocalAnalysisEngineClient(),
    skillScope: ['opensees-static'], agentState: { ...commitModel({}, normalized, 'physical-nodal-query'), locale: 'en' } };
  const tools = new Map(createRegisteredTools({ skillRuntime }).map(tool => [tool.name, tool]));
  const analyzed = await tools.get('run_analysis').invoke({ analysisType: 'static', analysisSkillId: 'opensees-static', loadCaseIds: ['LC1'] },
    { toolCall: { id: 'nodal-analysis' }, configurable });
  expect(output(analyzed)).toMatchObject({ deliveryScope: 'declared-output-selections', deliveryStatus: 'not-specified' });
  configurable.agentState = { ...configurable.agentState, ...analyzed.update };
  const saved = configurable.agentState.analysisResult;
  expect(saved.success).toBe(true);
  expect(saved.results['case:LC1'].data.execution.executed).toBe(true);
  expect(Object.keys(saved.results['case:LC1'].data.displacements)).toEqual(['1', '2', '3']);
  expect(Object.keys(saved.results['case:LC1'].data.reactions)).toEqual(['1', '3']);
  const query = input => tools.get('query_results').invoke({ resultKey: 'case:LC1', ...input },
    { toolCall: { id: 'nodal-query' }, configurable });
  for (const [args, field, expected] of [
    [{ nodeId: '2', component: 'uz', unit: 'mm' }, 'displacements', -.1],
    [{ nodeId: '1', component: 'fz', unit: 'kN' }, 'reactions', .5],
    [{ nodeId: '3', component: 'fz', unit: 'N' }, 'reactions', 500],
  ]) {
    const before = structuredClone(args);
    const command = await query(args), inferred = output(command);
    const explicit = output(await query({ ...args, field }));
    expect(args).toEqual(before);
    expect(inferred.fieldResolution).toEqual({ field, source: 'node-component-unit', component: args.component, unit: args.unit });
    expect(explicit.fieldResolution).toBeUndefined();
    expect(inferred.quantity).toEqual(explicit.quantity);
    expect(inferred.quantity).toMatchObject({ field, runId: saved.runId, selection: 'case:LC1', location: { kind: 'node', id: args.nodeId } });
    expect(inferred.quantity.value).toBeCloseTo(expected, 8);
    expect(quantityMatchesSelection(inferred.quantity, args, saved.runId, 'case:LC1')).toBe(true);
    const report = await tools.get('generate_report').invoke({ message: 'Verified nodal scalar', analysisType: 'static', narrative: 'structured',
      selection: { runId: saved.runId, resultKey: 'case:LC1', ...args } },
    { toolCall: { id: 'nodal-report' }, configurable: { ...configurable,
      agentState: { ...configurable.agentState, resultQuantities: command.update.resultQuantities } } });
    expect(output(report).report.json.requestedQuantities).toEqual([inferred.quantity]);
  }
  const rotation = output(await query({ nodeId: '1', component: 'ry', unit: 'rad' }));
  expect(rotation.quantity.field).toBe('displacements');
  expect(rotation.quantity.value).toBe(saved.results['case:LC1'].data.displacements['1'].ry);
  const moment = output(await query({ nodeId: '1', component: 'my', unit: 'kN.m' }));
  expect(moment.quantity.field).toBe('reactions');
  expect(moment.quantity.value).toBe(0);
  await expect(query({ nodeId: 'missing', component: 'uz', unit: 'mm' })).rejects.toThrow('RESULT_NODE_NOT_FOUND');
  await expect(query({ field: 'displacements', nodeId: '1', component: 'fz', unit: 'kN' })).rejects.toThrow('RESULT_COMPONENT_UNAVAILABLE');
  await expect(query({ field: 'displacements', nodeId: '2', component: 'uz', unit: 'kN' })).rejects.toThrow('RESULT_UNIT_MISMATCH');
  for (const args of [{ nodeId: '2' }, { nodeId: '2', component: 'uz', unit: 'kN' },
    { nodeId: '2', component: 'uz', unit: 'm/s' }, { nodeId: '2', component: 'uz', unit: 'm/s2' }]) {
    await expect(query(args)).rejects.toThrow('NODE_RESULT_FIELD_REQUIRED');
  }
  expect(configurable.agentState.model).toEqual(normalized);
}, 30000);

test('field resolution preserves explicit dynamic vectors, implicit time-history displacement and modal selection', async () => {
  const saved = run();
  saved.results['analysis:dynamic'].data.timeHistory[1].velocities = { B: { uz: .003 } };
  const implicit = { ...selection, field: undefined };
  const queried = output(await invoke(saved, implicit));
  expect(queried.quantity).toMatchObject({ field: 'displacements', value: -2, timeIndex: 1, time: .03 });
  expect(queried.quantity).toEqual(output(await invoke(saved, selection)).quantity);
  expect(output(await invoke(saved, { ...implicit, component: undefined, unit: undefined })).values).toEqual({ uz: -.002 });
  expect(output(await invoke(saved, { ...selection, field: 'velocities', unit: 'mm/s' })).quantity.value).toBe(3);
  await expect(invoke(saved, { ...implicit, unit: 'mm/s' })).rejects.toThrow('NODE_RESULT_FIELD_REQUIRED');
  const series = output(await invoke(saved, { ...implicit, timeIndex: undefined, series: {} }));
  expect(series.series.field).toBe('displacements');
  expect(series.fieldResolution.field).toBe('displacements');
  saved.results['analysis:dynamic'].data = { modes: [{ modeNumber: 2, modeShape: { A: [0, 0, 0], B: [-2, 1, 0] } }] };
  const modal = output(await invoke(saved, { ...implicit, timeIndex: undefined, modeNumber: 2, component: 'ux', unit: '1' }));
  expect(modal.quantity).toMatchObject({ value: -1, modeNumber: 2 });
  expect(modal.fieldResolution).toBeUndefined();
  expect(modal.quantity.field).toBeUndefined();
});


test.each(['en', 'zh'])('report discloses an unresolved registered query failure without hiding valid results or bypassing repair=0 (%s)', async locale => {
  const saved = run();
  const queried = await invoke(saved, selection);
  const tools = createRegisteredTools({ workspaceRoot: process.cwd(), skillRuntime: {} });
  const ids = ['query_results', 'generate_report'];
  const policy = resolveRunPolicy({ availableSkillIds: [], availableToolIds: ids, defaultToolIds: ids,
    requested: { repair: { enabled: false }, tools: { enabledIds: ids } } });
  const context = createRunContext(policy);
  const state = { analysisRuns: { saved }, resultQuantities: queried.update.resultQuantities, locale,
    messages: [new AIMessage({ content: '', tool_calls: [
      { id: 'ambiguous-query', name: 'query_results', args: { ...selection, elementId: 'beam' } },
      { id: 'blocked-retry', name: 'query_results', args: selection },
      { id: 'partial-report', name: 'generate_report', args: { message: 'Report the requested results', analysisType: 'dynamic', locale, selection, narrative: 'structured' } },
    ] })] };
  let current = state;
  const messages = [];
  for (let index = 0; index < 3; index++) {
    const result = await withRunContext(context, () => executeToolsSequentially(tools, current,
      { configurable: { runContext: context, skillScope: [] } }));
    messages.push(...result.update.messages);
    current = { ...current, ...result.update, messages: [...current.messages, ...result.update.messages] };
  }
  expect(messages[0].content).toContain('RESULT_LOCATION_AMBIGUOUS');
  expect(messages[1].content).toContain('RECOVERY_BUDGET_EXHAUSTED');
  const response = JSON.parse(messages[2].content);
  expect(response.success).toBe(true);
  expect(response.workflowStatus).toMatchObject({ completionStatus: 'incomplete', reasonCodes: ['UNRESOLVED_RESULT_QUERY'] });
  expect(response.report.json.workflowStatus).toEqual(response.workflowStatus);
  const warning = locale === 'zh' ? '未解决的结果查询失败' : 'unresolved result query failure';
  expect(response.summary).toContain(warning);
  expect(response.report.markdown).toContain(warning);
  expect(response.report.json.requestedQuantities).toHaveLength(1);
  expect(response.report.json.requestedQuantities[0].value).toBe(-2);
  expect(context.usage).toMatchObject({ toolCalls: 2, recoveries: 0 });
  expect(context.usage.pendingFailures.query_results).toContain('RESULT_LOCATION_AMBIGUOUS');

  const next = createRunContext(policy);
  const cleanReport = await withRunContext(next, () => tools.find(tool => tool.name === 'generate_report').invoke(
    { message: 'Report this saved scalar only', analysisType: 'dynamic', locale, selection, narrative: 'structured' },
    { toolCall: { id: 'new-turn-report' }, configurable: { agentState: state } }));
  expect(output(cleanReport).workflowStatus).toBeUndefined();
  expect(output(cleanReport).report.json.workflowStatus).toBeUndefined();
  expect(output(cleanReport).report.json.requestedQuantities[0].value).toBe(-2);
});
