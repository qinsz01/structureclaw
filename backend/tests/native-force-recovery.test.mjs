import {describe,test,expect} from '@jest/globals';
import {readFileSync} from 'node:fs';
import {enrichResultData,queryPhysicalResponse,scalarResultQuantity,resultTableMarkdown} from '../dist/engineering/result-data.js';

function cantilever() {
  const model={unit_system:'SI',coordinate_system:{dimension:'3d'},analysis_control:{self_weight:false},stories:[],
    nodes:[{id:'a',x:0,y:0,z:3},{id:'b',x:4,y:0,z:3}],elements:[{id:'beam',type:'beam',nodes:['a','b']}],materials:[],sections:[],
    load_cases:[{id:'D',loads:[{type:'distributed',element:'beam',start:1,end:3,wz:-2},
      {type:'point',element:'beam',position:2,fx:1,fy:2,fz:-4,mx:2,my:3,mz:1}]}]};
  const data={units:{force:'kN',moment:'kN.m'},forceSemantics:'simultaneous-signed-stations',nativeContext:{engine:'yjk',engineVersion:'test',
    physicalModelHash:'frozen',stiffnessHash:'same',settingsHash:'same',linearStatic:true,effectiveSettingsVerified:true,stationConventionsVerified:true},
    memberStations:{beam:[{positionM:0,side:'right',components:{N:1,Vy:-2,Vz:8,T:2,My:19,Mz:5}},
      {positionM:4,side:'left',components:{N:0,Vy:0,Vz:0,T:0,My:0,Mz:0}}].map(row=>({...row,referenceFrame:'element-local',
        localAxes:[[1,0,0],[0,1,0],[0,0,1]],source:{kind:'frozen-analytical-end-actions'}}))}};
  return {model,result:{success:true,selection:{kind:'case',id:'D'},data}};
}

describe('native force equilibrium recovery',()=>{
  test('partial line load and internal point force/moment retain real left/right cuts',()=>{
    const {model,result}=cantilever();
    expect(queryPhysicalResponse(model,result,'beam',1.5,'right').sample).toMatchObject({N:1,Vy:-2,Vz:7,T:2,My:7.25,Mz:2});
    const left=queryPhysicalResponse(model,result,'beam',2,'left'),right=queryPhysicalResponse(model,result,'beam',2,'right');
    expect(left.sample).toMatchObject({N:1,Vy:-2,Vz:6,T:2,My:4,Mz:1});
    expect(right.sample).toMatchObject({N:0,Vy:0,Vz:2,T:0,My:1,Mz:0});
    expect(right.provenance).toBe('mechanics-recovery');
    expect(right.method).toBe('section-equilibrium');
    expect(scalarResultQuantity(left,'My','N.m',true)).toBe(4000);
    expect(()=>scalarResultQuantity(right,'uz','mm',true)).toThrow('RESULT_COMPONENT_UNAVAILABLE');
    const data=enrichResultData(model,result,result.selection);
    expect(data.memberResponses[0].samples.filter(row=>row.x===2)).toHaveLength(2);
    expect(data.memberResponses[0].samples.find(row=>row.x===1.5)).toMatchObject({M2:7.25,provenance:'mechanics-recovery'});
    expect(data.memberResponses[0].samples.some(row=>'displacement'in row)).toBe(false);
  });

  test('linearly varying loads are integrated analytically',()=>{
    const {model,result}=cantilever();
    model.load_cases[0].loads=[{type:'distributed',element:'beam',distribution:'piecewise_linear',points:[{position:0,wz:0},{position:1,wz:-2}]}];
    result.data.memberStations.beam[0].components={N:0,Vy:0,Vz:4,T:0,My:32/3,Mz:0};
    const actual=queryPhysicalResponse(model,result,'beam',2,'right');
    expect(actual.sample.Vz).toBe(3);
    expect(actual.sample.My).toBeCloseTo(10/3,12);
  });

  test.each(['wrong-end','wrong-axes','missing-case','self-weight','floor-load','unverified-settings','missing-end'])('unverified %s cannot become a recovered force',defect=>{
    const {model,result}=cantilever();
    if(defect==='wrong-end')result.data.memberStations.beam[1].components.My=10;
    if(defect==='wrong-axes')result.data.memberStations.beam[0].localAxes[0]=[0,1,0];
    if(defect==='missing-case')result.selection.id='absent';
    if(defect==='self-weight')model.analysis_control.self_weight=true;
    if(defect==='floor-load')model.stories.push({floor_loads:[{value:1}]});
    if(defect==='unverified-settings')result.data.nativeContext.effectiveSettingsVerified=false;
    if(defect==='missing-end')result.data.memberStations.beam.pop();
    expect(()=>queryPhysicalResponse(model,result,'beam',1.5,'right')).toThrow('EXACT_NATIVE_STATION_UNAVAILABLE');
  });

  test('saved real YJK cases and combination preserve all native forces through query/chart/report',()=>{
    const fixture=JSON.parse(readFileSync(new URL('./fixtures/yjk-native-STD088-delivery.json',import.meta.url),'utf8'));
    for(const [id,source]of Object.entries({...fixture.cases,CX:fixture.combination})) {
      const selection={kind:id==='CX'?'combination':'case',id};
      const result={success:true,selection,meta:{engineId:'builtin-yjk',runId:fixture.nativeRun},data:source};
      const data=enrichResultData(fixture.model,result,selection);
      for(const [member,rows]of Object.entries(source.memberStations)) {
        for(const row of rows) {
          const response=queryPhysicalResponse(fixture.model,result,member,row.positionM,row.side==='left'?'left':'right');
          for(const [component,value]of Object.entries(row.components)) {
            expect(scalarResultQuantity(response,component,['T','My','Mz'].includes(component)?'kN.m':'kN',true)).toBe(value);
          }
        }
        const samples=data.memberResponses.find(item=>item.id===member).samples;
        expect(samples.some(sample=>sample.provenance==='mechanics-recovery')).toBe(true);
        expect(samples.some(sample=>'displacement'in sample)).toBe(false);
      }
      const report=resultTableMarkdown({runId:fixture.nativeRun,results:{[`${selection.kind}:${id}`]:{...result,data}}},'en');
      expect(report).toContain(`| ${selection.kind}:${id} | M2 |`);
      expect(report).toContain('kN.m');
    }
  });
  test('saved native partial/point loads and reversed endpoints retain independent values at arbitrary cuts',()=>{
    const f=JSON.parse(readFileSync(new URL('./fixtures/yjk-native-local-loads-delivery.json',import.meta.url),'utf8'));
    for(const [id,data] of Object.entries({...f.cases,MIX:f.combination})) {
      const factors=id==='MIX'?{PATCH:1.2,POINT:1.5}:{[id]:1};
      const end=Array.from({length:12},(_,index)=>Object.entries(factors).reduce((sum,[key,factor])=>sum+factor*f.reference[key][index],0));
      const result={success:true,selection:{kind:id==='MIX'?'combination':'case',id},data};
      for(const x of [0.731,1.234,1.7,2.431,3.711]) for(const side of ['left','right']) {
        const value=queryPhysicalResponse(f.model,result,f.member,x,side);
        const lineLength=Math.max(0,Math.min(x,3.5)-1),q=-7*(factors.PATCH||0);
        const point=(x>1.7||x===1.7&&side==='right')?-5*(factors.POINT||0):0;
        const expected={N:-end[0],Vy:end[1],Vz:end[2]+q*lineLength+point,T:-end[3],
          My:-end[4]-end[2]*x-q*lineLength*(x-1-lineLength/2)-point*(x-1.7),Mz:-end[5]+end[1]*x};
        for(const [component,wanted] of Object.entries(expected)) {
          expect(Math.abs(value.sample[component]-wanted)).toBeLessThanOrEqual(Math.max(f.absoluteTolerance,f.relativeTolerance*Math.abs(wanted)));
        }
        if(x!==1.7)expect(value.provenance).toBe('mechanics-recovery');
      }
      const left=queryPhysicalResponse(f.model,result,f.member,1.7,'left'),right=queryPhysicalResponse(f.model,result,f.member,1.7,'right');
      expect(right.sample.Vz-left.sample.Vz).toBeCloseTo(-5*(factors.POINT||0),5);
    }
  });
  test('a nearby cut is not snapped across the real point-load jump or outside the member',()=>{
    const f=JSON.parse(readFileSync(new URL('./fixtures/yjk-native-local-loads-delivery.json',import.meta.url),'utf8'));
    const result={success:true,selection:{kind:'case',id:'POINT'},data:f.cases.POINT};
    const left=queryPhysicalResponse(f.model,result,f.member,1.7,'left');
    const right=queryPhysicalResponse(f.model,result,f.member,1.7,'right');
    const before=queryPhysicalResponse(f.model,result,f.member,1.7-5e-10,'right');
    const after=queryPhysicalResponse(f.model,result,f.member,1.7+5e-10,'left');
    expect(before.provenance).toBe('mechanics-recovery');
    expect(after.provenance).toBe('mechanics-recovery');
    expect(before.sample.Vz).toBeCloseTo(left.sample.Vz,5);
    expect(after.sample.Vz).toBeCloseTo(right.sample.Vz,5);
    expect(after.sample.Vz-before.sample.Vz).toBeCloseTo(-5,5);
    const {model,result:beam}=cantilever();
    for(const [position,side]of [[4+5e-10,'left'],[0,'left'],[4,'right']]) {
      expect(()=>queryPhysicalResponse(model,beam,'beam',position,side)).toThrow('MEMBER_RESPONSE_UNAVAILABLE_OR_POSITION_INVALID');
    }
  });
  test('real PKPM adapter vectors feed exact queries, equilibrium, chart and report with original evidence',()=>{
    const f=JSON.parse(readFileSync(new URL('./fixtures/pkpm-native-STD086-delivery.json',import.meta.url),'utf8'));
    const result={success:true,selection:f.selection,meta:{engineId:'builtin-pkpm',runId:f.nativeRun},data:f.case};
    const data=enrichResultData(f.model,result,f.selection);
    for(const member of f.excerptMembers) {
      for(const cut of f.case.memberStations[member]) {
        const actual=queryPhysicalResponse(f.model,result,member,cut.positionM,cut.side==='left'?'left':'right');
        expect(actual.provenance).toBe('solver-direct');
        for(const [key,value]of Object.entries(cut.components))expect(actual.sample[key]).toBe(value);
      }
      const x=1.235,ref=f.reference[member],q=member.startsWith('c')?0:-8;
      const expected={N:-ref[0],Vy:ref[1],Vz:ref[2]+q*x,T:-ref[3],My:-ref[4]-ref[2]*x-q*x*x/2,Mz:-ref[5]+ref[1]*x};
      const actual=queryPhysicalResponse(f.model,result,member,x,'right');
      expect(actual.provenance).toBe('mechanics-recovery');
      for(const [key,value]of Object.entries(expected))expect(Math.abs(actual.sample[key]-value))
        .toBeLessThanOrEqual(Math.max(f.tolerance.forceKN,f.tolerance.relative*Math.abs(value)));
      const chart=data.memberResponses.find(row=>row.id===member);
      expect(chart.samples.some(row=>row.provenance==='mechanics-recovery')).toBe(true);
      expect(chart.samples.every(row=>row.displacement===undefined)).toBe(true);
    }
    expect(data.reactionSource.kind).toBe('derived-node-equilibrium');
    expect(Object.values(data.boundaryDisplacementSource).every(source=>source.kind==='prescribed-boundary')).toBe(true);
    const report=resultTableMarkdown({runId:f.nativeRun,results:{'case:D':{...result,data}}},'en');
    expect(report).toContain('| case:D | M2 |');
    expect(report).toContain('kN.m');
    expect(report).not.toContain('undefined');
  });
});
