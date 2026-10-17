#!/usr/bin/env node
// LIVE acceptance against an already started backend and its configured LLM (not part of Jest).
//
//   npm run test:live --prefix backend -- [--base-url http://127.0.0.1:31415] [--locale zh|en|all]
//                                         [--runs 1] [--variant beam|hn-no-thickness|original] [--out <dir>]
//
// beam (default): one sentence "design a simply supported steel beam ... HN300×150×6.5×9" must finish in
// one turn with a current analysis and report, no run_code_check call and no clarification; reactions,
// midspan moment and deflection are compared with closed-form values. The follow-up "check against
// GB50017" must execute run_code_check and deliver performed checks plus missing inputs without an
// interrupt. hn-no-thickness and original are exploratory runs that record what happens.
// Skips (exit 0) when the backend has no LLM API key configured. Never prints credentials.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) => {
  if (item.startsWith('--')) pairs.push([item.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : 'true']);
  return pairs;
}, []));
const BASE = (args['base-url'] ?? process.env.SCLAW_LIVE_BASE_URL ?? 'http://127.0.0.1:31415').replace(/\/$/, '');
const LOCALES = (args.locale ?? 'all') === 'all' ? ['zh', 'en'] : [args.locale];
const RUNS = Math.max(1, Number(args.runs ?? 1));
const VARIANT = args.variant ?? 'beam';
const OUT = args.out;
const TURN_TIMEOUT_MS = 15 * 60_000;
const REL_TOL = 1e-6;

const PROMPTS = {
  beam: {
    zh: '设计一个简支钢梁，跨度6m，跨中集中荷载10kN，Q355，HN300×150×6.5×9',
    en: 'Design a simply supported steel beam, span 6 m, 10 kN point load at midspan, Q355, HN300×150×6.5×9',
  },
  check: { zh: '按GB50017验算', en: 'Check it against GB50017' },
  'hn-no-thickness': {
    zh: '设计一个简支钢梁，跨度6m，跨中集中荷载10kN，Q355，HN300×150',
    en: 'Design a simply supported steel beam, span 6 m, 10 kN point load at midspan, Q355, HN300×150',
  },
  'hn-answer': { zh: '腹板厚6.5mm，翼缘厚9mm', en: 'Web thickness 6.5 mm, flange thickness 9 mm' },
  original: { zh: '设计一个简支梁，跨度10m，梁中间荷载1kN', en: 'Design a simply supported beam, span 10 m, 1 kN load at the middle of the beam' },
};
const BEAM = { P: 10, L: 6, H: 300, B: 150, tw: 6.5, tf: 9 };

async function json(method, url, body) {
  const response = await fetch(`${BASE}${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

/** POST an SSE chat turn and collect its events. */
async function turn(route, body) {
  const started = Date.now();
  const response = await fetch(`${BASE}${route}`, { method: 'POST', signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`SSE ${route} failed: ${response.status} ${text.slice(0, 500)}`);
  const events = text.split('\n').filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim()).filter(data => data && data !== '[DONE]')
    .flatMap(data => { try { return [JSON.parse(data)]; } catch { return []; } });
  const steps = events.filter(event => event.type === 'step_upsert').map(event => event.step ?? {});
  const result = [...events].reverse().find(event => event.type === 'result');
  return {
    wallMs: Date.now() - started, events, steps,
    conversationId: body.conversationId ?? events.find(event => event.type === 'start')?.content?.conversationId,
    interactions: events.filter(event => event.type === 'interaction_update'),
    errors: events.filter(event => event.type === 'error' || event.type === 'presentation_error'),
    response: result?.content?.response ?? null,
  };
}

const toolCalls = (t, name) => t.steps.filter(step => step.tool === name && step.status === 'done');
// SSE step outputs may be truncated; read the leading status fields as text.
const checkOutput = step => {
  const text = typeof step.output === 'string' ? step.output : '';
  const field = name => text.match(new RegExp(`"${name}":"([^"]*)"`))?.[1];
  return { skipped: text.includes('"skipped":true'), provider: field('provider'), completionStatus: field('completionStatus'),
    nextAction: field('nextAction'), hasCheckedItems: text.includes('"checkedItems"') };
};
const relErr = (actual, expected) => Math.abs(actual - expected) / Math.abs(expected);

async function queryResult(conversationId, query) {
  const review = await json('GET', `/api/v1/agent/result-review/${conversationId}`);
  if (review.status !== 200) throw new Error(`result-review ${review.status}`);
  const response = await json('POST', `/api/v1/agent/result-review/${conversationId}/tools`, {
    revisionToken: review.body.revisionToken, tool: 'query_results', args: query });
  if (response.status !== 200 || response.body?.success !== true) throw new Error(`query_results failed: ${JSON.stringify(response.body).slice(0, 400)}`);
  return response.body.result.quantity;
}

/** Sharp-corner H section strong-axis inertia (m⁴). */
function sharpCornerI({ H, B, tw, tf }) {
  const hw = H - 2 * tf;
  return (tw * hw ** 3 / 12 + 2 * (B * tf ** 3 / 12 + B * tf * ((hw + tf) / 2) ** 2)) / 1e12;
}

/** Reactions, |M| and deflection at midspan from the saved run, located through the built model. */
async function beamResponses(conversationId, runId) {
  const { model } = (await json('GET', `/api/v1/agent/input-review/${conversationId}`)).body;
  const nodes = model.nodes;
  const xs = nodes.map(node => node.x);
  const span = Math.max(...xs) - Math.min(...xs);
  const mid = nodes.find(node => Math.abs(node.x - Math.min(...xs) - span / 2) < 1e-9);
  if (!mid) throw new Error('No node at midspan');
  const supports = nodes.filter(node => Array.isArray(node.restraints) && node.restraints[2] === true);
  const element = model.elements.find(item => item.nodes[1] === mid.id) ?? model.elements.find(item => item.nodes[0] === mid.id);
  const start = nodes.find(node => node.id === element.nodes[0]);
  const positionM = Math.abs(mid.x - start.x);
  const resultKey = model.load_cases?.length === 1 ? `case:${model.load_cases[0].id}` : undefined;
  const base = { runId, ...(resultKey ? { resultKey } : {}) };
  const reactions = [];
  for (const support of supports) {
    reactions.push((await queryResult(conversationId, { ...base, nodeId: support.id, field: 'reactions', component: 'fz', unit: 'kN',
      quantityId: `live-reaction-${support.id}` })).value);
  }
  const moment = (await queryResult(conversationId, { ...base, elementId: element.id, positionM, side: positionM > 0 ? 'right' : 'left',
    field: 'forces', component: 'M2', unit: 'kN.m', quantityId: 'live-midspan-moment' })).value;
  const deflection = (await queryResult(conversationId, { ...base, elementId: element.id, positionM, side: positionM > 0 ? 'right' : 'left',
    field: 'displacements', component: 'uz', unit: 'mm', quantityId: 'live-midspan-displacement' })).value;
  const material = model.materials.find(item => item.id === element.material);
  const section = model.sections.find(item => item.id === element.section);
  return { span, reactions, moment, deflection, E: material.E, sectionIy: section?.properties?.Iy, section, selfWeight: model.analysis_control?.self_weight };
}

function check(failures, condition, message) { if (!condition) failures.push(message); }

async function runBeam(locale) {
  const failures = [];
  const first = await turn('/api/v1/chat/stream', { message: PROMPTS.beam[locale], context: { locale } });
  check(failures, first.errors.length === 0, `stream errors: ${JSON.stringify(first.errors).slice(0, 300)}`);
  check(failures, first.interactions.length === 0 && toolCalls(first, 'ask_user_clarification').length === 0
    && !first.steps.some(step => step.tool === 'ask_user_clarification'), 'clarification requested (not one turn)');
  check(failures, !first.steps.some(step => step.tool === 'run_code_check'), 'run_code_check was called without an explicit request');
  for (const tool of ['build_model', 'run_analysis', 'generate_report']) check(failures, toolCalls(first, tool).length > 0, `${tool} did not complete`);
  const session = (await json('GET', `/api/v1/chat/conversation/${first.conversationId}/session`)).body;
  check(failures, session?.analysis?.current === true, `analysis not current: ${JSON.stringify(session?.analysis)}`);
  check(failures, session?.report?.current === true, `report not current: ${JSON.stringify(session?.report)}`);
  check(failures, session?.waitingForReply === false, 'session still waiting for a reply');
  const offersCheck = /GB\s*50017|验算|校核|code[- ]check/i.test(first.response ?? '');
  let values;
  if (session?.analysis?.runId) {
    values = await beamResponses(first.conversationId, session.analysis.runId);
    const I = sharpCornerI(BEAM);
    const expectedDeflectionMm = BEAM.P * BEAM.L ** 3 / (48 * values.E * 1000 * I) * 1000;
    check(failures, values.reactions.length === 2 && values.reactions.every(value => relErr(Math.abs(value), BEAM.P / 2) < REL_TOL),
      `reactions ${JSON.stringify(values.reactions)} != 5 kN`);
    check(failures, relErr(Math.abs(values.moment), BEAM.P * BEAM.L / 4) < REL_TOL, `|M| ${values.moment} != 15 kN·m`);
    check(failures, relErr(Math.abs(values.deflection), expectedDeflectionMm) < REL_TOL,
      `deflection ${values.deflection} mm != PL³/(48EI) ${expectedDeflectionMm} mm (E=${values.E} MPa, I=${I} m⁴, model Iy=${values.sectionIy})`);
    values.expectedDeflectionMm = expectedDeflectionMm;
    check(failures, values.selfWeight !== true, 'model enabled self-weight although the request did not ask for it');
  }
  const follow = await turn('/api/v1/chat/stream', { conversationId: first.conversationId, message: PROMPTS.check[locale], context: { locale } });
  const executedChecks = toolCalls(follow, 'run_code_check').map(checkOutput).filter(output => !output.skipped && output.provider);
  check(failures, follow.errors.length === 0, `follow-up stream errors: ${JSON.stringify(follow.errors).slice(0, 300)}`);
  check(failures, follow.interactions.length === 0 && !follow.steps.some(step => step.tool === 'ask_user_clarification'), 'check follow-up interrupted for clarification');
  check(failures, executedChecks.length > 0, 'run_code_check did not execute on the explicit request');
  const lastCheck = executedChecks.at(-1);
  if (lastCheck) {
    check(failures, lastCheck.nextAction !== 'ask_user_clarification', `check nextAction ${lastCheck.nextAction}`);
    check(failures, lastCheck.hasCheckedItems, 'check output lacks checkedItems');
    if (lastCheck.completionStatus !== 'complete') {
      check(failures, /未执行|not performed/i.test(follow.response ?? ''), 'final reply does not list the checks not performed and their missing inputs');
    }
  }
  return { locale, variant: 'beam', pass: failures.length === 0, failures, wallMs: { first: first.wallMs, check: follow.wallMs },
    conversationId: first.conversationId, offersCheckInFinalAnswer: offersCheck,
    toolSequence: { first: first.steps.filter(step => step.status !== 'running').map(step => `${step.tool}:${step.status}`),
      check: follow.steps.filter(step => step.status !== 'running').map(step => `${step.tool}:${step.status}`) },
    values, checkSummary: lastCheck ?? null,
    finalAnswer: first.response, checkAnswer: follow.response };
}

/** Exploratory: record clarifications until the conversation completes (at most `maxTurns`). */
async function runExploratory(locale, prompt, answers) {
  const turns = [];
  let current = await turn('/api/v1/chat/stream', { message: prompt, context: { locale } });
  const conversationId = current.conversationId;
  turns.push(current);
  for (const answer of answers) {
    if (!current.interactions.length) break;
    current = await turn('/api/v1/chat/stream/resume', { conversationId, resumeValue: answer });
    turns.push(current);
  }
  const session = (await json('GET', `/api/v1/chat/conversation/${conversationId}/session`)).body;
  return { locale, variant: VARIANT, conversationId, clarifications: turns.filter(t => t.interactions.length).length,
    questions: turns.flatMap(t => t.interactions.map(event => event.content?.questions?.map(q => q.question))).flat(),
    analysisCurrent: session?.analysis?.current === true, reportCurrent: session?.report?.current === true,
    codeCheckCalled: turns.some(t => t.steps.some(step => step.tool === 'run_code_check')),
    wallMs: turns.map(t => t.wallMs), toolSequence: turns.map(t => t.steps.filter(step => step.status !== 'running').map(step => `${step.tool}:${step.status}`)),
    finalAnswer: current.response };
}

async function main() {
  let llm;
  try { llm = await json('GET', '/api/v1/admin/llm'); }
  catch (error) { console.error(`[live] backend not reachable at ${BASE}: ${error.message}`); process.exit(1); }
  if (llm.status !== 200 || llm.body?.hasApiKey !== true) {
    console.log(`[live] SKIPPED: no LLM API key configured for the backend at ${BASE}.`);
    return;
  }
  console.log(`[live] backend ${BASE}, model ${llm.body.model}, variant ${VARIANT}, locales ${LOCALES.join(',')}, runs ${RUNS}`);
  const results = [];
  for (let run = 1; run <= RUNS; run += 1) {
    for (const locale of LOCALES) {
      let result;
      try {
        if (VARIANT === 'beam') result = await runBeam(locale);
        else if (VARIANT === 'hn-no-thickness') result = await runExploratory(locale, PROMPTS['hn-no-thickness'][locale], [PROMPTS['hn-answer'][locale]]);
        else if (VARIANT === 'original') result = await runExploratory(locale, PROMPTS.original[locale],
          [locale === 'zh' ? '荷载竖直向下；材料Q235钢，截面H400×200×8×13' : 'Load acts downward; Q235 steel, section H400×200×8×13']);
        else throw new Error(`Unknown variant ${VARIANT}`);
      } catch (error) {
        result = { locale, variant: VARIANT, pass: false, failures: [error instanceof Error ? error.message : String(error)] };
      }
      result.run = run;
      results.push(result);
      const { finalAnswer: _a, checkAnswer: _c, ...brief } = result;
      console.log(JSON.stringify(brief));
      if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, `live-${VARIANT}-${locale}-${run}.json`), JSON.stringify(result, null, 2));
      }
    }
  }
  if (VARIANT === 'beam') {
    for (const locale of LOCALES) {
      const mine = results.filter(item => item.locale === locale);
      console.log(`[live] ${locale}: ${mine.filter(item => item.pass).length}/${mine.length} passed`);
    }
    if (results.some(item => !item.pass)) process.exitCode = 1;
  }
}

await main();
