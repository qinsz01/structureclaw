import { describe, expect, test } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeAnalysisRun, loadAnalysisRun } from '../dist/engineering/analysis-runs.js';
import { beginAnalysisRequest } from '../dist/engineering/model-state.js';
import { createQueryResultsTool } from '../dist/agent-langgraph/model-tools.js';
import { resultTableMarkdown, scalarResultQuantity, queryPhysicalResponse, enrichResultData } from '../dist/engineering/result-data.js';

describe('archived and requested results', () => {
  test('adapter provenance conflicts become failed archived results instead of being overwritten', async () => {
    const model = { nodes:[], elements:[], materials:[], sections:[], load_cases:[{id:'D',loads:[]}] };
    let archive;
    const run = await executeAnalysisRun({ model, type:'static', parameters:{} },
      async () => ({ success:true, meta:{ modelHash:'wrong-model' }, data:{ displacements:{a:{uz:99}} } }),
      async (_id, record) => { archive = record; });
    expect(run.success).toBe(false);
    expect(archive.results['case:D'].error_code).toBe('ANALYSIS_RESULT_BINDING_MISMATCH');
    expect(archive.results['case:D'].data.displacements).toBeUndefined();
  });
  test('run reload retains the physical snapshot and rejects traversal or inconsistent provenance', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'structureclaw-run-'));
    try {
      const model = { nodes: [], elements: [], materials: [], sections: [], load_cases: [{ id: 'D', loads: [] }] };
      let stored;
      const result = await executeAnalysisRun({ model, type: 'static', parameters: {} },
        async () => ({ success: true, data: { displacements: { tip: { uz: -0.001 } } } }),
        async (id, record) => { stored = record; await mkdir(path.join(directory, id));
          await writeFile(path.join(directory, id, 'run.json'), JSON.stringify(record)); });
      const loaded = await loadAnalysisRun(result.runId, directory);
      expect(loaded.modelSnapshot).toEqual(model);
      expect(loaded.results['case:D'].data.displacements.tip.uz).toBe(-0.001);
      await expect(loadAnalysisRun('../settings', directory)).rejects.toThrow('RUN_ID_INVALID');
      stored.request.model.nodes.push({ id: 'changed' });
      await writeFile(path.join(directory, result.runId, 'run.json'), JSON.stringify(stored));
      await expect(loadAnalysisRun(result.runId, directory)).rejects.toThrow('RUN_ARCHIVE_INVALID');
    } finally {
      if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('structureclaw-run-')) throw new Error('Invalid test directory');
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('a signed node query and bilingual report use the same value, case and unit', async () => {
    const model = { nodes: [], elements: [], materials: [], sections: [] };
    const state = { model, ...beginAnalysisRequest({ model }, 'settings'), resultQuantities: {}, analysisRuns: {} };
    state.analysisResult = { runId: 'r', selectedResultKey: 'case:D', meta: state.analysisRequest,
      results: { 'case:D': { success: true, meta: { runId: 'r' }, data: { reactions: { base: { fz: -.5 } } } } } };
    const response = await createQueryResultsTool().invoke({ field: 'reactions', nodeId: 'base',
      quantityId: 'reaction', component: 'fz', unit: 'N' }, { toolCall: { id: 'query' }, configurable: { agentState: state } });
    const quantity = response.update.resultQuantities['r:reaction'];
    expect(quantity).toMatchObject({ id: 'reaction', selection: 'case:D', value: -500, unit: 'N' });
    for (const locale of ['zh','en']) {
      const markdown = resultTableMarkdown({ ...state.analysisResult, requestedQuantities: [quantity,
        { ...quantity, runId: 'old', value: 999 }] }, locale);
      expect(markdown).toContain('| reaction | case:D | base | fz | -500 | N |');
      expect(markdown).not.toContain('999');
    }
  });

  test('wrong dimensions and display interpolation cannot masquerade as a recovered quantity', () => {
    expect(() => scalarResultQuantity({ fz: 3 }, 'fz', 'mm', false)).toThrow('RESULT_UNIT_MISMATCH');
    expect(() => scalarResultQuantity({ state: 'interpolated', sample: { V3: 2 } }, 'V3', 'kN', true)).toThrow('EXACT_MEMBER_RESPONSE_UNAVAILABLE');
    expect(() => scalarResultQuantity({ state: 'recovered', method: 'nearest-sample', sample: { V3: 2 } }, 'V3', 'kN', true)).toThrow('EXACT_MEMBER_RESPONSE_UNAVAILABLE');
  });

  test('commercial queries use the exact signed physical station and never fabricate displacement', () => {
    const model = nativeModel();
    const result = { data:{ units:{force:'kN',moment:'kN.m'}, forceSemantics:'simultaneous-signed-stations', nativeContext:{stationConventionsVerified:true},
      memberStations:{ beam:[{positionM:2, side:'left', referenceFrame:'element-local',
        components:{N:1,Vy:2,Vz:-3,T:4,My:-5,Mz:6},source:'native-sdk'}] } } };
    const value = queryPhysicalResponse(model,result,'beam',2,'left');
    expect(value.provenance).toBe('solver-direct');
    expect(scalarResultQuantity(value,'M2','N.m',true)).toBe(-5000);
    expect(scalarResultQuantity(value,'V3','N',true)).toBe(-3000);
    expect(() => scalarResultQuantity(value,'uz','mm',true)).toThrow('RESULT_COMPONENT_UNAVAILABLE');
    expect(() => queryPhysicalResponse(model,result,'beam',2,'right')).toThrow('EXACT_NATIVE_STATION_UNAVAILABLE');
    expect(() => queryPhysicalResponse(model,result,'beam',2.1,'left')).toThrow('EXACT_NATIVE_STATION_UNAVAILABLE');
    result.data.nativeContext.stationConventionsVerified=false;
    expect(() => queryPhysicalResponse(model,result,'beam',2,'left')).toThrow('NATIVE_STATION_CONVENTIONS_UNVERIFIED');
  });

  test('native samples feed chart, report and exact query without creating interior displacement', () => {
    const model = nativeModel();
    const result = { success:true, meta:{engineId:'builtin-yjk',runId:'native'}, data:{
      units:{force:'kN',moment:'kN.m'}, nativeContext:{engine:'yjk',stationConventionsVerified:true},
      forceSemantics:'simultaneous-signed-stations', memberStations:{beam:[0,2,4].map((x,index) => ({
        positionM:x, side:index===0?'right':index===2?'left':'continuous', referenceFrame:'element-local',
        components:{N:0,Vy:1,Vz:2-x,T:0.25,My:-4+x,Mz:0},
        source:{kind:'native-station-coordinate-mapping',artifact:'fea.dat',sha256:'bound'},
      }))} } };
    const data = enrichResultData(model,result,{kind:'case',id:'D'});
    expect(data.memberResponses[0]).toMatchObject({state:'native-stations',length:4});
    expect(data.memberResponses[0].samples[1]).toMatchObject({x:2,position:[2,0,3],M2:-2,V3:0,provenance:'solver-direct'});
    expect(data.memberResponses[0].samples.some(row => 'displacement' in row)).toBe(false);
    expect(data.memberResponseExtrema.values.M2).toMatchObject({elementId:'beam',position:0,value:-4,provenance:'solver-direct'});
    expect(data.memberResponseExtrema.values.uz).toBeUndefined();
    const response = queryPhysicalResponse(model,{...result,data},'beam',2,'right');
    expect(scalarResultQuantity(response,'M2','kN.m',true)).toBe(data.memberResponses[0].samples[1].M2);
    const markdown = resultTableMarkdown({runId:'native',results:{'case:D':{...result,data}}},'en');
    expect(markdown).toContain('| case:D | M2 | -4 | kN.m | beam | 0 | right | solver-direct |');
    expect(markdown).toContain('not exact continuous-field extrema');
    result.data.source={kind:'linear-combination',factors:{D:1.2,L:1.4}};
    const combination = enrichResultData(model,result,{kind:'combination',id:'U'});
    expect(combination.memberResponseExtrema.values.M2.provenance).toBe('linear-combination');
    expect(queryPhysicalResponse(model,result,'beam',2,'left').provenance).toBe('linear-combination');
  });

  test('commercial missing stations cannot fall back to brace interpolation or component envelopes', () => {
    const model = nativeModel();
    model.elements[0].type='brace';
    const result = {meta:{engineId:'builtin-yjk'},data:{units:{displacement:'m'},
      displacements:{a:{ux:0,uy:0,uz:0},b:{ux:.1,uy:0,uz:0}},forces:{beam:{axial:99}},
      memberResponses:[{id:'beam',state:'truss',samples:[{N:99}]}]}};
    const data=enrichResultData(model,result,{kind:'case',id:'D'});
    expect(data.memberResponses[0].state).toBe('unavailable');
    expect(data.memberResponseExtrema.values).toEqual({});
    expect(() => queryPhysicalResponse(model,result,'beam',2,'left')).toThrow('NATIVE_STATION_CONVENTIONS_UNVERIFIED');
  });

  test.each(['units','components','position','source','ambiguous-side'])('rejects invalid native station %s instead of enriching plausible values', defect => {
    const model=nativeModel();
    const result={data:{units:{force:'kN',moment:'kN.m'},forceSemantics:'simultaneous-signed-stations',
      nativeContext:{engine:'yjk',stationConventionsVerified:true},memberStations:{beam:[{positionM:2,side:'continuous',
        referenceFrame:'element-local',components:{N:1,Vy:2,Vz:3,T:4,My:5,Mz:6},source:'native-sdk'}]}}};
    if(defect==='units')result.data.units.force='N';
    if(defect==='components')delete result.data.memberStations.beam[0].components.My;
    if(defect==='position')result.data.memberStations.beam[0].positionM=5;
    if(defect==='source')delete result.data.memberStations.beam[0].source;
    if(defect==='ambiguous-side')result.data.memberStations.beam.push({...result.data.memberStations.beam[0],side:'left'});
    expect(enrichResultData(model,result,{kind:'case',id:'D'}).memberResponses[0].state).toBe('unavailable');
    expect(() => queryPhysicalResponse(model,result,'beam',2,'left')).toThrow();
  });
});

function nativeModel() {
  return {unit_system:'SI',coordinate_system:{dimension:'3d'},nodes:[{id:'a',x:0,y:0,z:3},{id:'b',x:4,y:0,z:3}],
    elements:[{id:'beam',type:'beam',nodes:['a','b']}],materials:[],sections:[],load_cases:[{id:'D',loads:[]}]};
}
