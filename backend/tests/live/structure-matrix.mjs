#!/usr/bin/env node
// Real-LLM product acceptance against a separately started backend. No fake
// provider, model fixtures, retries, secret lookup or automatic clarifications.
import fs from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import { args, BASE, json, queryResult } from './client.mjs';
import { cases } from './structure-matrix-cases.mjs';

const out = path.resolve(args.out ?? `.tmp/live-structure-${Date.now()}`);
if(!args['base-url']&&!process.env.SCLAW_LIVE_BASE_URL) throw new Error('LIVE_TEST_BASE_URL_REQUIRED: supply an isolated test backend with --base-url / 必须显式指定隔离测试服务地址');
await fs.mkdir(out, { recursive:true });
const selected = cases.filter(c => !args.cases || args.cases.split(',').includes(c.id));
if (!selected.length) throw new Error('NO_LIVE_CASES_SELECTED');
const records = [];
const save = (name, value) => fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2));
const engineId = engine => `builtin-${engine.split('-')[0]}`;
const assert = (record, pass, reason) => { if (!pass) record.failures.push(reason); };
const near = (a,b,atol=1e-7,rtol=1e-6) => Number.isFinite(a) && Math.abs(a-b) <= atol+rtol*Math.abs(b);
async function stream(body, file,route='/api/v1/chat/stream') {
  const response = await fetch(`${BASE}${route}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15*60_000)});
  if (!response.ok) throw new Error(`CHAT_HTTP_${response.status}: ${(await response.text()).slice(0,400)}`);
  const handle = await fs.open(file,'w');
  const decoder = new TextDecoder();
  let pending='', bytes=0;
  const result = {steps:[],errors:[],interactions:[]};
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length; pending += decoder.decode(chunk,{stream:true});
      const lines=pending.split('\n');pending=lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw=line.slice(5).trim();if (!raw || raw==='[DONE]') continue;
        const event=JSON.parse(raw);
        // Preserve source tool receipts and the answer, without duplicating the
        // large plot payload in every event. Saved run/model are archived once.
        if (event.type==='step_upsert') result.steps.push(event.step);
        if (event.type==='start') result.conversationId=event.content?.conversationId;
        if (event.type==='interaction_update') result.interactions.push(event);
        if (event.type==='error'||event.type==='presentation_error') result.errors.push(event);
        if (event.type==='result') result.response=event.content?.response;
        if (['start','step_upsert','interaction_update','error','presentation_error'].includes(event.type)) await handle.write(`${JSON.stringify(event)}\n`);
      }
    }
  } finally { await handle.close(); }
  return {...result,transportBytes:bytes};
}
async function verify(record, scenario) {
  const {conversationId}=record.turn;
  record.session=(await json('GET',`/api/v1/chat/conversation/${conversationId}/session`)).body;
  record.review=(await json('GET',`/api/v1/agent/input-review/${conversationId}`)).body;
  const failedIds=[...new Set(record.turn.steps.filter(s=>s.tool==='run_analysis'&&s.status==='error')
    .flatMap(s=>s.output?.match(/"runId":"([^"]+)"/)?.[1]??[]))];
  record.failedRuns=[];
  for(const id of failedIds) {const archived=await json('GET',`/runs/${id}`);assert(record,archived.status===200,`failed run ${id} was not retained`);record.failedRuns.push(archived.body);}
  const {session,review}=record, model=review?.model;
  for(const run of record.failedRuns)for(const result of Object.values(run.results??{})) {
    assert(record,result.success===false,'failed archive contains an unreported successful result');
    assert(record,result.meta?.engineId===engineId(scenario.engine)&&!result.meta?.fallbackFrom,'failed run used a different engine or fallback');
  }
  if(scenario.oracle.materialGrade&&model)for(const material of model.materials.filter(m=>model.elements.some(e=>e.material===m.id))) assert(record,material.grade===scenario.oracle.materialGrade,'confirmed material grade changed');
  const boundary=scenario.allowCapabilityRefusal;
  const failed=record.failedRuns.flatMap(run=>Object.values(run.results??{}));
  const capabilityRefused=boundary&&failed.length>0&&failed.every(result=>result.success===false&&result.error_code===boundary.code&&result.meta?.capability===boundary.capability);
  if(scenario.skillIdsExpected) assert(record,isDeepStrictEqual(session.policy?.activeSkillIds,scenario.skillIdsExpected),'skill scope was silently widened');
  assert(record,record.turn.errors.length===0,`stream errors: ${JSON.stringify(record.turn.errors).slice(0,500)}`);
  assert(record,!session.waitingForReply,`unexpected clarification: ${session.question}`);
  if(scenario.expect==='answered') {
    assert(record,record.turn.steps.length===0,'general conversation invoked tools against the request');
    assert(record,!model&&session.analysis?.current!==true&&session.report?.current!==true,'general conversation created engineering artifacts');
    assert(record,typeof record.turn.response==='string'&&record.turn.response.length>20,'general conversation produced no answer');
    record.actualOutcome='answered';return;
  }
  if(scenario.expect==='refused'||capabilityRefused) {
    record.actualOutcome='refused';
    assert(record,session.analysis?.current!==true,'refused task published a current analysis');
    assert(record,session.report?.current!==true,'refused task published a current report');
    assert(record,session.busy===false,'refused task left session busy');
    assert(record,typeof record.turn.response==='string'&&record.turn.response.length>20,'no usable explanation');
    if(scenario.allowedCodes&&record.turn.steps.some(s=>s.tool==='run_analysis')) assert(record,record.turn.steps.some(s=>scenario.allowedCodes.some(code=>s.output?.includes(code))), 'expected structured capability refusal was not observed');
    return;
  }
  assert(record,session.analysis?.current===true,'no current successful analysis');
  assert(record,scenario.reportRequested?session.report?.current===true:session.report?.current!==true,scenario.reportRequested?'requested report is not current':'unrequested report');
  if(scenario.reportRequested) assert(record,session.report.runId===session.analysis.runId,'report belongs to a different run');
  assert(record,!record.turn.steps.some(s=>s.tool==='run_code_check'),'unrequested code check');
  if(scenario.queryOnly) {
    assert(record,record.turn.steps.some(s=>s.tool==='query_results'&&s.status==='done'),'read-only follow-up did not query the saved result');
    assert(record,!record.turn.steps.some(s=>['run_analysis','build_model','extract_draft_params','generate_report','edit_model'].includes(s.tool)),'read-only follow-up performed an unrequested operation');
  }
  const used=session.modeling?.usedSkillIds??[];
  assert(record,scenario.expectSkillUse===false?used.every(id=>id===scenario.skill):JSON.stringify(used)===JSON.stringify([scenario.skill]),`used skills ${JSON.stringify(session.modeling)}`);
  assert(record,!!model,'no published model');
  if (!model) return;
  const o=scenario.oracle;
  if(o.nodes) assert(record,model.nodes.length===o.nodes,`node count ${model.nodes.length} != ${o.nodes}`);
  if(o.members) assert(record,model.elements.length===o.members,`member count ${model.elements.length} != ${o.members}`);
  if(o.extent) for(const [i,axis] of ['x','y','z'].entries()) assert(record,near(Math.max(...model.nodes.map(n=>n[axis]))-Math.min(...model.nodes.map(n=>n[axis])),o.extent[i]),`extent ${axis} differs`);
  if(o.axialBrace) assert(record,model.elements.some(e=>['truss','brace'].includes(e.type)),'axial brace replaced by frame member');
  if(o.truss) assert(record,model.elements.every(e=>['truss','brace'].includes(e.type)),'truss contains bending frame members');
  if(o.densityUnitWeight) for(const material of model.materials.filter(m=>model.elements.some(e=>e.material===m.id))) assert(record,near(material.rho*9.80665/1000,o.densityUnitWeight,1e-9),'unit weight conversion differs');
  if(!session.analysis?.current) return;
  if(o.roofTransfer) {
    const {width,height,pressure}=o.roofTransfer,caseD=model.load_cases.find(c=>c.id==='D');
    assert(record,!!caseD,'roof pressure lost source case D');
    const loads=caseD?.loads??[];
    assert(record,loads.length===2,'one-way rectangular roof must load the two supporting X beams');
    for(const load of loads) {
      const e=model.elements.find(e=>e.id===load.element),ends=e?.nodes.map(id=>model.nodes.find(n=>n.id===id));
      assert(record,load.type==='distributed'&&load.reference_frame!=='element-local'&&near(load.wz,-pressure*height/2),'roof transfer must retain global uniform beam loading');
      assert(record,ends?.every(n=>near(n.z,6))&&near(Math.abs(ends[1].x-ends[0].x),width)&&near(ends[0].y,ends[1].y),'roof pressure escaped its confirmed top floor/X support beams');
    }
  }
  record.run=(await json('GET',`/runs/${session.analysis.runId}`)).body;
  record.totals={};
  if(o.dynamic) {
    const results=Object.entries(record.run.results??{});
    assert(record,results.length>0,'no saved dynamic result');
    for(const [key,result] of results) {
      assert(record,result.success===true&&result.meta?.engineId==='builtin-opensees'&&!result.meta?.fallbackFrom,`${key}: dynamic engine/result differs`);
      if(o.dynamic.method==='modal') for(const [i,expected] of o.dynamic.frequencies.entries()) {
        const q=await queryResult(conversationId,{runId:session.analysis.runId,resultKey:key,field:'modal',modeNumber:i+1});
        assert(record,near(q.values?.frequency,expected,1e-8,1e-7),`modal frequency ${i+1}: ${q.values?.frequency} != ${expected}`);
      }
      else for(const timeIndex of [0,7,49,99]) for(const [field,referenceField,unit,scale] of [['displacements','u','mm',1000],['velocities','v','mm/s',1000],['accelerations','a','mm/s2',1000]]) {
        const q=await queryResult(conversationId,{runId:session.analysis.runId,resultKey:key,field,timeIndex,nodeId:'top',component:'ux',unit});
        assert(record,near(q.quantity?.value,o.dynamic.reference[timeIndex][referenceField]*scale,1e-7,1e-6),`${field}[${timeIndex}] differs from independent Newmark recurrence`);
        assert(record,near(q.quantity?.time,(timeIndex+1)*o.dynamic.dt,1e-12),'saved response time differs');
      }
    }
    return;
  }
  for(const [key,result] of Object.entries(record.run.results??{})) {
    assert(record,result.success===true,`${key}: failed result`);
    assert(record,result.meta?.engineId===engineId(scenario.engine),`${key}: wrong engine ${result.meta?.engineId}`);
    assert(record,(result.meta?.fallbackFrom??null)===null,`${key}: engine fallback`);
    const reactions=result.data?.reactions??{};
    const totals=['fx','fy','fz'].map(component=>Object.values(reactions).reduce((sum,row)=>sum+(row[component]??0),0));
    record.totals[key]=totals;
    const expected=o.totals?.[key]??o.total;
    if(expected) totals.forEach((v,i)=>assert(record,near(v,-expected[i],.002,2e-6),`${key}: reaction ${i} ${v} != ${-expected[i]}`));
    const expectedMoment=o.moments?.[key]??o.moment;
    if(expectedMoment) {
      const moment=[0,0,0];
      for(const [id,r] of Object.entries(reactions)) {
        const n=model.nodes.find(n=>n.id===id);
        if(!n)throw new Error(`Unknown support result ${id}`);
        moment[0]+=(r.mx??0)+n.y*(r.fz??0)-n.z*(r.fy??0);
        moment[1]+=(r.my??0)+n.z*(r.fx??0)-n.x*(r.fz??0);
        moment[2]+=(r.mz??0)+n.x*(r.fy??0)-n.y*(r.fx??0);
      }
      record.moments??={};record.moments[key]=moment;
      moment.forEach((v,i)=>assert(record,near(v,-expectedMoment[i],.003,3e-6),`${key}: moment equilibrium ${i} ${v} != ${-expectedMoment[i]}`));
    }
    if(o.axialFrame) {
      const a=o.axialFrame,expectedDz=-a.P*a.L/(a.E*1000*a.A);
      for(const n of model.nodes.filter(n=>near(n.z,a.L))) assert(record,near(result.data.displacements?.[n.id]?.uz,expectedDz,1e-9,1e-5),`${key}/${n.id}: axial PL/EA displacement differs`);
    }
    if(o.supportReactions) for(const [x,expectedReaction] of o.supportReactions) {
      const n=model.nodes.find(n=>near(n.x,x)&&n.restraints?.[2]);
      assert(record,!!n&&near(reactions[n.id]?.fz,expectedReaction),`${key}: reaction at x=${x} differs from ${expectedReaction}`);
    }
    const nodeId=Object.keys(reactions)[0];
    if(nodeId) {
      const q=await queryResult(conversationId,{runId:session.analysis.runId,resultKey:key,nodeId,field:'reactions',component:'fz',unit:'N'});
      assert(record,near(q.quantity?.value,reactions[nodeId].fz*1000,.01),`${key}: saved scalar unit conversion differs`);
    }
  }
  assert(record,Object.keys(record.totals).length>0,'saved run has no results');
  if(o.totals) assert(record,JSON.stringify(Object.keys(record.totals).sort())===JSON.stringify(Object.keys(o.totals).sort()),'requested cases/combinations were omitted or renamed');
  if(o.beam) {
    const b=o.beam, mid=model.nodes.find(n=>near(n.x,b.L/2)&&near(n.z,0));
    assert(record,!!mid,'no midpoint node');
    if(mid) {
      const key=Object.keys(record.run.results)[0], I=(b.B/1000)*(b.H/1000)**3/12;
      const dz=-b.P*b.L**3/(48*b.E*1000*I);
      const actual=record.run.results[key].data.displacements?.[mid.id]?.uz;
      record.beam={expectedDz:dz,actualDz:actual};
      assert(record,near(actual,dz,1e-9,1e-6),`midpoint PL³/48EI differs: ${actual} != ${dz}`);
      const supports=model.nodes.filter(n=>n.restraints?.[2]);
      for(const n of supports) assert(record,near(record.run.results[key].data.reactions?.[n.id]?.fz,b.P/2),`support ${n.id} reaction differs`);
    }
  }
}
const configuredLlm=await json('GET','/api/v1/admin/llm');
if(configuredLlm.status!==200||configuredLlm.body?.hasApiKey!==true)throw new Error('REAL_LLM_CONFIGURATION_REQUIRED / 测试后端必须配置真实LLM，本套测试不会跳过或使用离线替代');
await save('suite.json',{startedAt:new Date().toISOString(),backend:BASE,model:configuredLlm.body.model,scenarioIds:selected.map(c=>c.id),providerSource:'backend configuration'});
console.log(JSON.stringify({event:'suite-start',model:configuredLlm.body.model,cases:selected.length}));
for(const scenario of selected) {
  const record={id:scenario.id,scenario,startedAt:new Date().toISOString(),failures:[]};
  console.log(JSON.stringify({event:'case-start',id:scenario.id,engine:scenario.engine,skill:scenario.skill}));
  try {
    const context={locale:scenario.locale??'zh',runPolicy:{skillIds:[scenario.skill],routing:{mode:'fixed',skillId:scenario.skill},
      ...(scenario.skill==='generic'?{builder:'llm'}:{}),providers:{preferredIds:[scenario.engine],disabledIds:['opensees-static','pkpm-static','yjk-static','opensees-dynamic','opensees-seismic','opensees-nonlinear'].filter(id=>id!==scenario.engine)},...scenario.policy}};
    record.turn=await stream({message:scenario.prompt,context},path.join(out,`${scenario.id}.events.jsonl`));
    if(scenario.answer) {
      record.initialTurn=record.turn;
      record.initialSession=(await json('GET',`/api/v1/chat/conversation/${record.turn.conversationId}/session`)).body;
      assert(record,record.initialSession.waitingForReply===true,'missing physical input was not requested');
      assert(record,record.initialSession.analysis?.current!==true,'missing physical input produced a fabricated calculation');
      assert(record,record.turn.errors.length===0,'clarification produced a transport error');
      if(record.initialSession.waitingForReply) record.turn=await stream({conversationId:record.turn.conversationId,resumeValue:scenario.answer},path.join(out,`${scenario.id}.resume.events.jsonl`),'/api/v1/chat/stream/resume');
    }
    await verify(record,scenario);
    if(scenario.followUps && !record.failures.length) {
      record.followUps=[];
      for(const [index,follow] of scenario.followUps.entries()) {
        const previous=record.followUps.at(-1)??record;
        const next={id:`${scenario.id}-follow-${index+1}`,failures:[]};
        next.turn=await stream({conversationId:record.turn.conversationId,message:follow.message,context:{...context,runPolicy:{...context.runPolicy,...follow.policy}}},path.join(out,`${next.id}.events.jsonl`));
        await verify(next,{...scenario,...follow,expectSkillUse:false});
        assert(next,next.session.analysis.runId!==(follow.preserveRun?null:previous.session.analysis.runId),'edit did not produce a new run');
        if(follow.preserveRun)assert(next,next.session.analysis.runId===previous.session.analysis.runId,'report unnecessarily changed the analyzed run');
        if(follow.preserveRun)assert(next,isDeepStrictEqual(next.review.model,previous.review.model),'read-only follow-up changed the model');
        assert(next,JSON.stringify(next.review.model.load_cases.map(c=>c.id))===JSON.stringify(record.review.model.load_cases.map(c=>c.id)),'case IDs changed in follow-up');
        record.followUps.push(next);record.failures.push(...next.failures.map(f=>`${next.id}: ${f}`));
        if(next.failures.length)break;
      }
    }
  } catch(error) {record.failures.push(error.stack);}
  record.outcome=record.failures.length?'failed':record.actualOutcome??(scenario.expect==='refused'?'refused':'solved');record.goalCompleted=['solved','answered'].includes(record.outcome);record.finishedAt=new Date().toISOString();
  await save(`${scenario.id}.json`,record);
  records.push({id:record.id,outcome:record.outcome,goalCompleted:record.goalCompleted,conversationId:record.turn?.conversationId,failures:record.failures,startedAt:record.startedAt,finishedAt:record.finishedAt});
  await save('summary.json',records);
  console.log(JSON.stringify({event:'case-finished',...records.at(-1)}));
}
if(records.some(r=>r.outcome==='failed'))process.exitCode=1;
