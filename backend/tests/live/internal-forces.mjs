// LIVE internal-force acceptance (imported by one-sentence-beam.mjs; not part of Jest).
//
// forces: "计算一个简支梁的内力，跨度10m，跨中集中荷载1kN" (zh/en) must be answered in one turn with no
// question, no report, no code check and no displacement: reactions 0.5 kN, |M| 2.5 kN·m at midspan. The
// follow-up "那挠度呢" must ask for the real material and section instead of reusing the run.
// continuous: two-span 2×6 m beam, 10 kN/m, forces only: no question, the equal-EI assumption stated,
// support moment 45 kN·m (hogging), reactions 22.5/75/22.5 kN.
// portal: exploratory "门式刚架的内力" run that records what happens.
import { check, queryResult, questionCount, relErr, runModel, toolCalls, toolSequence, turn, json } from './client.mjs';

const REL_TOL = 1e-6;
export const FORCE_PROMPTS = {
  forces: {
    zh: '计算一个简支梁的内力，跨度10m，跨中集中荷载1kN',
    en: 'Compute the internal forces of a simply supported beam, span 10 m, 1 kN point load at midspan',
  },
  deflection: { zh: '那挠度呢', en: 'And the deflection?' },
  continuous: {
    zh: '计算一根两跨连续梁的内力，每跨6m，满跨均布荷载10kN/m',
    en: 'Compute the internal forces of a two-span continuous beam, each span 6 m, uniform load 10 kN/m on both spans',
  },
  portal: {
    zh: '计算一个门式刚架的内力，跨度12m，柱高6m，屋面均布荷载5kN/m',
    en: 'Compute the internal forces of a portal frame, span 12 m, column height 6 m, roof uniform load 5 kN/m',
  },
};

// A displacement value presented in prose (e.g. "挠度 3.2 mm", "deflection of 0.02 m").
const DISPLACEMENT_VALUE = /(挠度|位移|变形|deflection|displacement)[^。.\n]{0,24}?\d+(?:\.\d+)?\s*(?:mm|m)(?![a-z²³/])/i;
export function displacementValueClaims(answer) {
  return [...answer.matchAll(new RegExp(DISPLACEMENT_VALUE.source, 'gi'))].map(match => match[0])
    .filter(claim => !/^(?:(?:挠度|位移|变形)(?:点|位置).*?(?:距|位于|在)|(?:deflection|displacement)\s+(?:point|location).*?\b(?:at|located|from)\b)/i.test(claim));
}
const EQUAL_EI = /(EI|刚度)[^。.\n]{0,30}(相同|相等|一致|equal|same|identical|uniform)|(相同|相等|equal|same|identical|uniform)[^。.\n]{0,30}(EI|刚度|stiffness)/i;
const ASKS_PROPERTIES = /(材料|截面|牌号|material|section)/i;

function commonFirstTurnChecks(failures, first) {
  check(failures, first.errors.length === 0, `stream errors: ${JSON.stringify(first.errors).slice(0, 300)}`);
  check(failures, questionCount(first) === 0, 'a clarification was requested');
  check(failures, !first.steps.some(step => step.tool === 'run_code_check'), 'run_code_check was called');
  check(failures, toolCalls(first, 'run_analysis').length > 0, 'run_analysis did not complete');
  check(failures, !displacementValueClaims(first.response ?? '').length, 'the answer presents a displacement value');
}

async function supportReactions(conversationId, runId, model) {
  const supports = model.nodes.filter(node => Array.isArray(node.restraints) && node.restraints[2] === true).sort((a, b) => a.x - b.x);
  const reactions = [];
  for (const node of supports) {
    reactions.push((await queryResult(conversationId, { runId, nodeId: node.id, field: 'reactions', component: 'fz', unit: 'kN' })).quantity.value);
  }
  return { supports, reactions };
}

async function momentAt(conversationId, runId, model, x) {
  const element = model.elements.find(item => {
    const [a, b] = item.nodes.map(id => model.nodes.find(node => node.id === id));
    return Math.min(a.x, b.x) - 1e-9 <= x && x <= Math.max(a.x, b.x) + 1e-9 && Math.abs(a.z - b.z) < 1e-9 && Math.abs(a.z) < 1e-9;
  });
  const start = model.nodes.find(node => node.id === element.nodes[0]);
  const positionM = Math.abs(x - start.x);
  return (await queryResult(conversationId, { runId, elementId: element.id, positionM, side: positionM > 0 ? 'left' : 'right',
    field: 'forces', component: 'M2', unit: 'kN.m' })).quantity.value;
}

/** Simple-beam forces, then the deflection follow-up. */
export async function runForces(locale) {
  const failures = [];
  const first = await turn('/api/v1/chat/stream', { message: FORCE_PROMPTS.forces[locale], context: { locale } });
  commonFirstTurnChecks(failures, first);
  const session = (await json('GET', `/api/v1/chat/conversation/${first.conversationId}/session`)).body;
  check(failures, session?.analysis?.current === true, `analysis not current: ${JSON.stringify(session?.analysis)}`);
  check(failures, session?.report?.current !== true, 'a report was generated for a forces-only request');
  let values;
  if (session?.analysis?.runId) {
    const runId = session.analysis.runId;
    const model = await runModel(first.conversationId, runId);
    const { reactions } = await supportReactions(first.conversationId, runId, model);
    const moment = await momentAt(first.conversationId, runId, model, 5);
    values = { reactions, moment };
    check(failures, reactions.length === 2 && reactions.every(value => relErr(Math.abs(value), 0.5) < REL_TOL), `reactions ${JSON.stringify(reactions)} != 0.5 kN`);
    check(failures, relErr(Math.abs(moment), 2.5) < REL_TOL, `|M| ${moment} != 2.5 kN·m`);
    const displacement = await json('POST', `/api/v1/agent/result-review/${first.conversationId}/tools`, {
      revisionToken: (await json('GET', `/api/v1/agent/result-review/${first.conversationId}`)).body.revisionToken,
      tool: 'query_results', args: { runId, nodeId: model.nodes.find(node => Math.abs(node.x - 5) < 1e-9)?.id ?? model.nodes[1].id,
        field: 'displacements', component: 'uz', unit: 'mm' } });
    check(failures, displacement.body?.success !== true, 'the forces-only run still exposes a displacement');
  }
  const follow = await turn('/api/v1/chat/stream', { conversationId: first.conversationId, message: FORCE_PROMPTS.deflection[locale], context: { locale } });
  const questions = follow.interactions.flatMap(event => event.content?.questions?.map(q => `${q.label ?? ''} ${q.question ?? ''}`) ?? []);
  check(failures, follow.errors.length === 0, `follow-up stream errors: ${JSON.stringify(follow.errors).slice(0, 300)}`);
  check(failures, questions.some(text => ASKS_PROPERTIES.test(text)) || ASKS_PROPERTIES.test(follow.response ?? ''),
    'the deflection follow-up did not ask for the material and section');
  check(failures, !displacementValueClaims(follow.response ?? '').length, 'the follow-up presents a displacement from the placeholder run');
  return { variant: 'forces', locale, pass: failures.length === 0, failures, wallMs: { first: first.wallMs, followUp: follow.wallMs },
    questionCount: { first: questionCount(first), followUp: questionCount(follow) }, conversationId: first.conversationId,
    toolSequence: { first: toolSequence(first), followUp: toolSequence(follow) }, values, followUpQuestions: questions,
    finalAnswer: first.response, followUpAnswer: follow.response };
}

/** Two-span continuous beam, forces only. */
export async function runContinuous(locale) {
  const failures = [];
  const first = await turn('/api/v1/chat/stream', { message: FORCE_PROMPTS.continuous[locale], context: { locale } });
  commonFirstTurnChecks(failures, first);
  const session = (await json('GET', `/api/v1/chat/conversation/${first.conversationId}/session`)).body;
  check(failures, session?.analysis?.current === true, `analysis not current: ${JSON.stringify(session?.analysis)}`);
  check(failures, session?.report?.current !== true, 'a report was generated for a forces-only request');
  check(failures, EQUAL_EI.test(first.response ?? ''), 'the equal-EI assumption is not stated');
  let values;
  if (session?.analysis?.runId) {
    const runId = session.analysis.runId;
    const model = await runModel(first.conversationId, runId);
    const { supports, reactions } = await supportReactions(first.conversationId, runId, model);
    const moment = await momentAt(first.conversationId, runId, model, 6);
    values = { supportX: supports.map(node => node.x), reactions, supportMoment: moment };
    check(failures, reactions.length === 3 && relErr(Math.abs(reactions[0]), 22.5) < REL_TOL && relErr(Math.abs(reactions[1]), 75) < REL_TOL
      && relErr(Math.abs(reactions[2]), 22.5) < REL_TOL, `reactions ${JSON.stringify(reactions)} != 22.5/75/22.5 kN`);
    check(failures, relErr(Math.abs(moment), 45) < REL_TOL, `|M_support| ${moment} != 45 kN·m`);
  }
  return { variant: 'continuous', locale, pass: failures.length === 0, failures, wallMs: { first: first.wallMs },
    questionCount: { first: questionCount(first) }, conversationId: first.conversationId,
    toolSequence: { first: toolSequence(first) }, values, finalAnswer: first.response };
}

/** Exploratory portal frame: record questions, tools, the equal-EI statement and the answer. */
export async function runPortal(locale) {
  const first = await turn('/api/v1/chat/stream', { message: FORCE_PROMPTS.portal[locale], context: { locale } });
  const session = (await json('GET', `/api/v1/chat/conversation/${first.conversationId}/session`)).body;
  return { variant: 'portal', locale, pass: first.errors.length === 0 && questionCount(first) === 0 && session?.analysis?.current === true
      && EQUAL_EI.test(first.response ?? ''), wallMs: { first: first.wallMs }, questionCount: { first: questionCount(first) },
    equalEiStated: EQUAL_EI.test(first.response ?? ''), analysisCurrent: session?.analysis?.current === true,
    reportCurrent: session?.report?.current === true, conversationId: first.conversationId,
    toolSequence: { first: toolSequence(first) }, finalAnswer: first.response };
}
