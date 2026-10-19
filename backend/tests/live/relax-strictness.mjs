// Opt-in live replay, including the round-3 user-confirmation decision (option A).
// Requires an already running isolated backend; never starts or restarts a service.
import fs from 'node:fs';
import path from 'node:path';
import { args, BASE, check, json, queryResult, turn } from './client.mjs';
import { extractUnitNumbers } from '../../dist/agent-langgraph/delivery/answer-integrity.js';

const out = args.out;
const dataDir = args['data-dir'];
if (!out || !dataDir || !BASE.includes(':31585')) throw new Error('Use --out, --data-dir and isolated --base-url http://127.0.0.1:31585');
fs.mkdirSync(out, { recursive: true });
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2));
const cases = [
  ...Array.from({ length: 3 }, (_, i) => ({ id: `catalogue-${i + 1}`, answer: 'Q235钢，工字钢 I20a', catalogue: true })),
  ...Array.from({ length: 2 }, (_, i) => ({ id: `geometry-${i + 1}`, answer: 'Q235，I20a 尺寸 200×100×7×11.4', catalogue: false })),
].filter(item => !args.case || item.id === args.case);
const summaries = [];
for (const item of cases) {
  const failures = [];
  const evidence = { case: item, baseUrl: BASE, failures, turns: [] };
  try {
    const first = await turn('/api/v1/chat/stream', { message: '设计一个简支梁，跨度10m，梁中间荷载1kN', context: { locale: 'zh' } });
    evidence.turns.push(first);
    const conversationId = first.conversationId;
    evidence.conversationId = conversationId;
    write(`${item.id}.json`, evidence);
    const waiting = (await json('GET', `/api/v1/chat/conversation/${conversationId}/session`)).body;
    const runIds = new Set([waiting.usage.runId]);
    const second = waiting.waitingForReply
      ? await turn('/api/v1/chat/stream/resume', { conversationId, resumeValue: item.answer })
      : await turn('/api/v1/chat/stream', { conversationId, message: item.answer, context: { locale: 'zh' } });
    evidence.turns.push(second);
    let session = (await json('GET', `/api/v1/chat/conversation/${conversationId}/session`)).body;
    runIds.add(session.usage.runId);
    if (item.catalogue) {
      evidence.beforeConfirmation = { session, model: (await json('GET', `/api/v1/agent/input-review/${conversationId}`)).body.model };
      check(failures, !waiting.analysis?.current && !session.analysis?.current
        && evidence.turns.every(t => !t.steps.some(step => step.tool === 'run_analysis' && step.status === 'done')), 'calculation occurred before section confirmation');
      check(failures, second.interactions.length === 1 && session.waitingForReply, 'exactly one dimension confirmation was not requested');
      const firstQuestion = JSON.stringify(first.interactions);
      check(failures, first.interactions.length === 0 || first.interactions.length === 1
        && /材料|material/i.test(firstQuestion) && /截面|section/i.test(firstQuestion), 'first clarification was not material and section together');
      check(failures, /尺寸|厚|dimension|thickness/i.test(JSON.stringify(second.interactions)), 'confirmation question does not ask for dimensions');
      if (session.waitingForReply) {
        evidence.confirmationAnswer = '确认：Q235，I20a 尺寸 200×100×7×11.4 mm，以上尺寸由我提供。';
        write(`${item.id}.json`, evidence);
        evidence.turns.push(await turn('/api/v1/chat/stream/resume', { conversationId, resumeValue: evidence.confirmationAnswer }));
        session = (await json('GET', `/api/v1/chat/conversation/${conversationId}/session`)).body;
        runIds.add(session.usage.runId);
      }
    }
    evidence.session = session;
    evidence.persisted = (await json('GET', `/api/v1/chat/conversation/${conversationId}`)).body;
    evidence.model = (await json('GET', `/api/v1/agent/input-review/${conversationId}`)).body.model;
    const recordPath = path.join(dataDir, 'run-records', `${session.usage.runId}.json`);
    const recordPaths = [...runIds].map(id => path.join(dataDir, 'run-records', `${id}.json`));
    const records = recordPaths.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
    const record = records.find(row => row.usage.runId === session.usage.runId);
    evidence.runRecords = records;
    evidence.runRecordPaths = recordPaths;
    evidence.runRecord = record;
    evidence.runRecordPath = recordPath;
    const questions = evidence.turns.reduce((n, t) => n + t.interactions.length, 0);
    const wallMs = evidence.turns.reduce((n, t) => n + t.wallMs, 0);
    evidence.metrics = { questions, llmCalls: records.reduce((sum, row) => sum + row.usage.llmCalls, 0),
      recoveries: Math.max(...records.map(row => row.usage.recoveries)), wallMs,
      extractors: records.flatMap(row => row.usage.events.filter(event => event.kind === 'param_extractor')) };
    check(failures, item.catalogue ? questions >= 1 && questions <= 2 && evidence.turns.length === 3
      && evidence.turns[2].interactions.length === 0 : questions <= 1 && second.interactions.length === 0,
    'unexpected clarification count or extra question after confirmed dimensions');
    check(failures, wallMs < 300000, 'system time exceeds five minutes');
    check(failures, session.analysis?.current && !session.waitingForReply, 'no completed current analysis');
    check(failures, records.every(row => row.usage.recoveries <= 1), 'more than one recovery');
    check(failures, !JSON.stringify(records).includes('RECOVERY_BUDGET_EXHAUSTED'), 'recovery budget exhausted');
    const visible = evidence.turns.map(t => t.response ?? '').join('\n');
    evidence.transcript = evidence.turns.map(t => ({ questions: t.interactions, answer: t.response }));
    evidence.adequacyClaimCandidates = evidence.turns.flatMap((t, turnIndex) => (t.response ?? '').split('\n')
      .filter(line => /满足.*要求|符合.*规范|安全|合格|富余|adequate|complies|compliant|\bsafe\b|passes? (?:the )?(?:code|check)/i.test(line))
      .map(excerpt => ({ turn: turnIndex + 1, excerpt })));
    check(failures, !/预算|纠错次数|重置.*(?:次数|预算)|另发.*消息|send a new message|budget/i.test(visible), 'internal budget mechanics exposed');
    check(failures, evidence.turns.every(t => !t.errors.length), 'SSE error');
    if (session.analysis?.current) {
      const model = evidence.model;
      const nodes = model.nodes;
      const mid = nodes.find(node => Math.abs(node.x - 5) < 1e-8);
      const supports = nodes.filter(node => node.restraints?.[2]);
      const element = model.elements.find(row => row.nodes.includes(mid?.id));
      const start = nodes.find(node => node.id === element?.nodes[0]);
      const base = { runId: session.analysis.runId, resultKey: `case:${model.load_cases[0].id}` };
      const reactions = [];
      for (const support of supports) reactions.push((await queryResult(conversationId, {
        ...base, nodeId: support.id, field: 'reactions', component: 'fz', unit: 'kN', quantityId: `accept-R-${support.id}`,
      })).quantity);
      const atMid = { ...base, elementId: element.id, positionM: Math.abs(5 - start.x), side: 'right' };
      const moment = (await queryResult(conversationId, { ...atMid, field: 'forces', component: 'M2', unit: 'kN.m', quantityId: 'accept-M' })).quantity;
      const deflection = (await queryResult(conversationId, { ...atMid, field: 'displacements', component: 'uz', unit: 'mm', quantityId: 'accept-u' })).quantity;
      const section = model.sections.find(row => row.id === element.section);
      const material = model.materials.find(row => row.id === element.material);
      const expectedDeflectionMm = 1000 * 10 ** 3 / (48 * material.E * 1e6 * section.properties.Iy) * 1000;
      evidence.values = { reactions, moment, deflection, expectedDeflectionMm, section, material };
      check(failures, reactions.length === 2 && reactions.every(row => Math.abs(row.value - .5) < 1e-6), 'R differs from 0.5 kN');
      check(failures, Math.abs(Math.abs(moment.value) - 2.5) < 1e-6, 'M differs from 2.5 kN.m');
      check(failures, Math.abs(Math.abs(deflection.value) / expectedDeflectionMm - 1) < 1e-6, 'deflection does not use the adopted inertia');
      const claims = extractUnitNumbers(visible.replace(/\*\*|__/g, ''));
      for (const [family, baseValue] of [['force', 500], ['moment', 2500], ['length', expectedDeflectionMm / 1000]]) {
        check(failures, claims.some(row => row.family === family && Math.abs(Math.abs(row.value) * row.scale / baseValue - 1) < .03), `answer omits requested ${family} result`);
      }
      check(failures, /圆角|尖角|sharp.corner/i.test(visible), 'sharp-corner assumption not shown');
      check(failures, Math.abs(section.properties.Iy / 2.35452664e-5 - 1) < 1e-9
        && section.extra?.derived_properties?.fields?.includes('Iy')
        && section.extra?.provenance?.shape === 'user', 'confirmed user-dimension inertia was not derived by the system');
    }
  } catch (error) { failures.push(error.message); }
  evidence.pass = failures.length === 0;
  write(`${item.id}.json`, evidence);
  summaries.push({ id: item.id, pass: evidence.pass, failures, ...evidence.metrics, evidence: path.join(out, `${item.id}.json`) });
  write('summary.json', summaries);
  console.log(`[${evidence.pass ? 'PASS' : 'FAIL'}] ${item.id}: ${JSON.stringify({ ...evidence.metrics, failures })}`);
}
process.exitCode = summaries.every(row => row.pass) ? 0 : 1;
