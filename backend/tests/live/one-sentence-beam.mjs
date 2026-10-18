#!/usr/bin/env node
// LIVE acceptance against an already started backend and its configured LLM (not part of Jest).
//
//   npm run test:live --prefix backend -- [--base-url http://127.0.0.1:31415] [--locale zh|en|all]
//     [--runs 1] [--variant acceptance|beam|forces|continuous|portal|hn-no-thickness|original] [--out <dir>]
//
// acceptance (default) runs beam, forces and continuous.
// beam: one sentence "design a simply supported steel beam ... HN300×150×6.5×9" must finish in one turn
// with a current analysis and report, no run_code_check call and no clarification; reactions, midspan
// moment and deflection are compared with closed-form values. The follow-up "check against GB50017" must
// execute run_code_check without an interrupt, compute the strength checks with f=305 and fv=175 MPa
// (GB 50017-2017 Table 4.4.1, Q355, t=9 mm) and list the missing judgment inputs.
// forces / continuous / portal: see internal-forces.mjs. hn-no-thickness and original are exploratory.
// Skips (exit 0) when the backend has no LLM API key configured. Never prints credentials.
import fs from 'node:fs';
import path from 'node:path';
import { args, BASE, backendLlm, check, json, queryResult as queryResultRecord, questionCount, relErr, toolCalls, toolSequence, turn } from './client.mjs';
import { runContinuous, runForces, runPortal } from './internal-forces.mjs';

const LOCALES = (args.locale ?? 'all') === 'all' ? ['zh', 'en'] : [args.locale];
const RUNS = Math.max(1, Number(args.runs ?? 1));
const VARIANT = args.variant ?? 'acceptance';
const OUT = args.out;
const REL_TOL = 1e-6;
const ACCEPTANCE = ['beam', 'forces', 'continuous'];
const VARIANTS = VARIANT === 'acceptance' ? ACCEPTANCE : [VARIANT];

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

// SSE step outputs may be truncated; read the leading status fields as text.
const checkOutput = step => {
  const text = typeof step.output === 'string' ? step.output : '';
  const field = name => text.match(new RegExp(`"${name}":"([^"]*)"`))?.[1];
  return { skipped: text.includes('"skipped":true'), provider: field('provider'), completionStatus: field('completionStatus'),
    nextAction: field('nextAction'), hasCheckedItems: text.includes('"checkedItems"') };
};
const queryResult = async (conversationId, query) => (await queryResultRecord(conversationId, query)).quantity;

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
  // Strength checks use the Table 4.4.1 values for Q355 with a 9 mm flange, shown with their source.
  const reply = follow.response ?? '';
  check(failures, /305/.test(reply) && /175/.test(reply), 'the check reply does not show f=305 and fv=175 MPa');
  check(failures, /4\.4\.1/.test(reply), 'the check reply does not cite GB 50017-2017 Table 4.4.1');
  check(failures, /(φb|phi_b|整体稳定|lateral)/i.test(reply) && /(L\/n|挠度|deflection)/i.test(reply),
    'the check reply does not list the lateral-stability and deflection judgment inputs');
  return { locale, variant: 'beam', pass: failures.length === 0, failures, wallMs: { first: first.wallMs, check: follow.wallMs },
    questionCount: { first: questionCount(first), check: questionCount(follow) },
    conversationId: first.conversationId, offersCheckInFinalAnswer: offersCheck,
    toolSequence: { first: toolSequence(first), check: toolSequence(follow) },
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

const RUNNERS = {
  beam: runBeam, forces: runForces, continuous: runContinuous, portal: runPortal,
  'hn-no-thickness': locale => runExploratory(locale, PROMPTS['hn-no-thickness'][locale], [PROMPTS['hn-answer'][locale]]),
  original: locale => runExploratory(locale, PROMPTS.original[locale],
    [locale === 'zh' ? '荷载竖直向下；材料Q235钢，截面H400×200×8×13' : 'Load acts downward; Q235 steel, section H400×200×8×13']),
};
const EXPLORATORY = new Set(['hn-no-thickness', 'original', 'portal']);

async function main() {
  const llm = await backendLlm();
  if (llm.status !== 200 || llm.body?.hasApiKey !== true) {
    console.log(`[live] SKIPPED: no LLM API key configured for the backend at ${BASE}.`);
    return;
  }
  for (const variant of VARIANTS) if (!RUNNERS[variant]) throw new Error(`Unknown variant ${variant}`);
  console.log(`[live] backend ${BASE}, model ${llm.body.model}, variants ${VARIANTS.join(',')}, locales ${LOCALES.join(',')}, runs ${RUNS}`);
  const results = [];
  for (let run = 1; run <= RUNS; run += 1) {
    for (const variant of VARIANTS) {
      for (const locale of LOCALES) {
        let result;
        try {
          result = await RUNNERS[variant](locale);
        } catch (error) {
          result = { locale, variant, pass: false, failures: [error instanceof Error ? error.message : String(error)] };
        }
        result.variant ??= variant;
        result.run = run;
        results.push(result);
        const { finalAnswer: _a, checkAnswer: _c, followUpAnswer: _f, ...brief } = result;
        console.log(JSON.stringify(brief));
        if (OUT) {
          fs.mkdirSync(OUT, { recursive: true });
          fs.writeFileSync(path.join(OUT, `live-${variant}-${locale}-${run}.json`), JSON.stringify(result, null, 2));
        }
      }
    }
  }
  for (const variant of VARIANTS) {
    for (const locale of LOCALES) {
      const mine = results.filter(item => item.variant === variant && item.locale === locale);
      console.log(`[live] ${variant} ${locale}: ${mine.filter(item => item.pass).length}/${mine.length} passed${EXPLORATORY.has(variant) ? ' (exploratory)' : ''}`);
    }
  }
  if (results.some(item => !item.pass && !EXPLORATORY.has(item.variant))) process.exitCode = 1;
}

await main();
