// Independent references are fixed before invoking the candidate: stress=M/W,
// axial stability=N/(phi*A*f), Euler-Bernoulli P*L^3/(48*E*I), and singly
// reinforced rectangular RC capacity alpha1*fc*b*x*(h0-x/2).
import assert from 'node:assert/strict';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { AnalysisExecutionService } from '../dist/services/analysis-execution.js';
import { CodeCheckExecutionService } from '../dist/services/code-check-execution.js';
import { buildCodeCheckInput } from '../dist/agent-skills/code-check/entry.js';

const protocol = createLocalStructureProtocolClient();
const analysis = new AnalysisExecutionService(undefined, async () => {});
const checker = new CodeCheckExecutionService();
const close = (a,b) => assert.ok(Number.isFinite(a) && Math.abs(a-b) <= 1e-8+Math.abs(b)*1e-8, `${a} != ${b}`);
const coord = { semantics:'global-z-up',version:1,dimension:'2d',plane:'xz',dof_order:['ux','uy','uz','rx','ry','rz'] };
const beam = (P, concrete=false) => ({
  schema_version:'2.2.0',unit_system:'SI',coordinate_system:coord,
  nodes:[{id:'a',x:0,y:0,z:0,restraints:[true,true,true,true,false,true]},
    {id:'b',x:4,y:0,z:0,restraints:[false,true,true,true,false,true]}],
  elements:[{id:'member',type:'beam',nodes:['a','b'],material:'m',section:'s',
    ...(concrete ? {concrete_grade:'C30',rebar_grade:'HRB400'}:{}),
    design:{l0:4000,phi_b:.9,beta1:1,lambdaLimit:150,deflectionLimitN:250,serviceability_result_keys:['case:S'],
      ...(concrete ? {h0:550,alpha_cr:1.9,crackWidthLimit:.3,reinforcement:{confirmed:true,source:'independent-test-input',
        values:{As:1256,Asv:157,stirrup_spacing:150,stirrup_dia:10,main_dia:20,cover:30,crack_cover:30,bar_count:4,sn:60}}}:{})}}],
  materials:[{id:'m',name:concrete?'C30':'elastic steel',E:concrete?30000:200000,nu:concrete?.2:.3,rho:concrete?2500:7850,G:concrete?12500:70000,
    ...(concrete ? {grade:'C30'}:{design:{f:300,fv:175}})}],
  sections:[{id:'s',name:'explicit rectangle',type:'rectangular',shape:{kind:'rectangular',B:concrete?300:200,H:concrete?600:400}}],
  load_cases:[{id:'S',type:'other',loads:[{id:'p',type:'point',element:'member',position:2,fz:-P},
    // Both supports settle 20 mm: this must not become member bending deflection.
    {id:'sa',type:'displacement',node:'a',uz:-.02},{id:'sb',type:'displacement',node:'b',uz:-.02}]}],
  analysis_control:{self_weight:false,rigid_floor:false},
});

async function calculate(raw,code) {
  const converted = await protocol.post('/convert',{model:raw,source_format:'structuremodel-v2',target_format:'structuremodel-v2',target_schema_version:'2.2.0'});
  const model = converted.data.model;
  const run = await analysis.analyze({model,type:'static',engineId:'builtin-opensees',parameters:{loadCaseIds:['S']}});
  assert.equal(run.success,true,JSON.stringify(run));
  const selected = run.results['case:S'];
  const input = buildCodeCheckInput({traceId:'native-code-check',designCode:code,model,analysis:selected,analysisParameters:{}});
  assert.equal(input.context.source.runId,run.runId);
  const result = await checker.codeCheck(input);
  const items = result.details.flatMap(row => row.checks.flatMap(group => group.items));
  return {model,run,input,result,item:name=>items.find(row=>row.item===name)};
}

const passed = await calculate(beam(100),'GB50017');
assert.equal(passed.item('正应力').status,'pass');
assert.equal(passed.item('挠度').status,'pass');
close(passed.item('正应力').inputs.demand,100e6/((.2*.4**3/12)/.2*1e9));
const expectedDeflectionMm = 100*4**3/(48*200000000*(.2*.4**3/12))*1000;
close(passed.item('挠度').inputs.demand,expectedDeflectionMm);
assert.equal(passed.item('挠度').calculationInputs.deflectionResponse.definition,'transverse-displacement-relative-to-endpoint-chord');
const failed = await calculate(beam(4000),'GB50017');
assert.equal(failed.item('正应力').status,'fail');
assert.equal(failed.item('挠度').status,'fail');
const missingBeam = beam(100); delete missingBeam.materials[0].design.f;
const missing = await calculate(missingBeam,'GB50017');
assert.equal(missing.item('正应力').status,'input_required');
assert.equal(missing.item('正应力').utilization,null);

function column(P) {
  const model = beam(100); model.nodes[1]={id:'b',x:0,y:0,z:3,restraints:[false,true,false,true,false,true]};
  model.nodes[0].restraints=[true,true,true,true,true,true];
  model.elements[0].type='column';model.elements[0].design={phi_axial:.8,l0:3000,lambdaLimit:150};
  model.load_cases[0].loads=[{id:'p',type:'nodal',node:'b',fz:-P}];
  return model;
}
const goodColumn=await calculate(column(500),'GB50017');
assert.equal(goodColumn.item('轴压稳定').status,'pass');
close(goodColumn.item('轴压稳定').inputs.demand,500000);
close(goodColumn.item('轴压稳定').inputs.capacity,.8*.08*1e6*300);
assert.equal((await calculate(column(25000),'GB50017')).item('轴压稳定').status,'fail');
const missingColumn=column(500);delete missingColumn.elements[0].design.phi_axial;
assert.equal((await calculate(missingColumn,'GB50017')).item('轴压稳定').status,'input_required');

const rc=await calculate(beam(50,true),'GB50010');
const x=360*1256/(14.3*300), capacity=14.3*300*x*(550-x/2);
assert.equal(rc.item('正截面受弯').status,'pass');close(rc.item('正截面受弯').inputs.capacity,capacity);
assert.equal((await calculate(beam(300,true),'GB50010')).item('正截面受弯').status,'fail');
const missingRC=beam(50,true);delete missingRC.elements[0].design.reinforcement.values.As;
assert.equal((await calculate(missingRC,'GB50010')).item('正截面受弯').status,'input_required');

const rotated=beam(100);rotated.elements[0].rotation_angle=90;
const rotationRun=await calculate(rotated,'GB50017');
close(rotationRun.item('挠度').inputs.demand,expectedDeflectionMm*4);
close(rotationRun.item('正应力').inputs.demand,37.5);
assert.equal(rotationRun.input.context.elementData.member.section.effectiveBendingAxis,'section-z');
console.log(JSON.stringify({status:'passed',nativeRuns:10,checks:['steel beam pass/fail/missing','steel column pass/fail/missing',
  'RC beam pass/fail/missing','relative deflection excludes support settlement','2D principal section rotation',
  'V2.2 design properties and run provenance','engineering demand/capacity units'],tolerance:{absolute:1e-8,relative:1e-8}},null,2));
