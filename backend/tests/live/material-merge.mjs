// Real-provider regression. Run only against an explicitly selected isolated backend.
import fs from 'node:fs';
import path from 'node:path';
import { args, BASE, json, turn, queryResult } from './client.mjs';

if (!args['base-url'] || !args['data-dir'] || BASE !== 'http://127.0.0.1:31605') {
  throw new Error('Use --base-url http://127.0.0.1:31605 --data-dir <isolated SCLAW_DATA_DIR>');
}
const results = [];
// Fixture assertion only: confirm the dimensions the UI received, never supply missing candidates.
const offeredDimensions = text => {
  const numbers = String(text ?? '').match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return numbers.some((_, index) => [200, 100, 7, 11.4].every((value, offset) => numbers[index + offset] === value));
};
for (let index = 1; index <= Number(args.runs ?? 3); index++) {
  const started = Date.now();
  const failures = [], turns = [], questions = [], answerRoutes = [], runIds = new Set();
  let session, conversationId, deflectionMm, confirmationDelivery;
  const readSession = async () => {
    const value = (await json('GET', `/api/v1/chat/conversation/${conversationId}/session`)).body;
    if (value.usage?.runId) runIds.add(value.usage.runId);
    return value;
  };
  try {
    const first = await turn('/api/v1/chat/stream', { message: '设计一个简支梁，跨度10m，梁中间荷载1kN', context: { locale: 'zh' } });
    turns.push(first);
    conversationId = first.conversationId;
    for (let answerIndex = 0; answerIndex < 2; answerIndex++) {
      session = await readSession();
      questions.push(session.waitingForReply ? session.question : turns.at(-1).response);
      let answer = '材料Q235钢，截面工字钢I20a';
      if (answerIndex === 1) {
        const delivered = turns.at(-1).interactions.at(-1)?.content;
        const sseQuestion = delivered?.questions?.map(item => item.question).join('\n');
        confirmationDelivery = { question: session.question, options: session.options,
          sseQuestion, sseOptions: delivered?.options };
        if (!session.waitingForReply || !offeredDimensions(session.question) || !offeredDimensions(sseQuestion)) {
          throw new Error('The interface did not offer 200×100×7×11.4 mm in the confirmation question');
        }
        if (JSON.stringify(session.options ?? []) !== JSON.stringify(delivered?.options ?? [])) {
          throw new Error('SSE and session delivered different confirmation options');
        }
        answer = session.options?.find(offeredDimensions) ?? '确认采用上述尺寸。';
        confirmationDelivery.answer = answer;
      }
      answerRoutes.push(session.waitingForReply ? 'resume' : 'message');
      turns.push(await (session.waitingForReply
        ? turn('/api/v1/chat/stream/resume', { conversationId, resumeValue: answer })
        : turn('/api/v1/chat/stream', { conversationId, message: answer, context: { locale: 'zh' } })));
    }
    session = await readSession();
    if (session.waitingForReply) failures.push(`Extra clarification: ${session.question}`);
    if (!session.analysis?.current) failures.push('No current analysis');
    else {
      const review = (await json('GET', `/api/v1/agent/input-review/${conversationId}`)).body;
      const mid = review.model.nodes.find(node => Math.abs(node.x - 5) < 1e-9);
      const value = await queryResult(conversationId, { runId: session.analysis.runId, field: 'displacements',
        nodeId: mid.id, component: 'uz', unit: 'mm', quantityId: `material-merge-${index}` });
      deflectionMm = Math.abs(value.quantity.value);
      if (Math.abs(deflectionMm - 4.295) > .0005) failures.push(`Unexpected deflection: ${deflectionMm}`);
    }
  } catch (error) { failures.push(error.message); }
  const wallMs = Date.now() - started, systemMs = turns.reduce((sum, item) => sum + item.wallMs, 0);
  if (systemMs >= 180000) failures.push('System time exceeded three minutes');
  if (turns.some(item => item.errors.length)) failures.push('SSE errors');
  const events = [...runIds].flatMap(runId => {
    const recordPath = path.join(args['data-dir'], 'run-records', `${runId}.json`);
    return fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')).usage.events : [];
  });
  const extracts = events.filter(event => event.kind === 'draft_extraction_result');
  const failedExtracts = events.filter(event => event.kind === 'tool_finished' && event.name === 'extract_draft_params' && !event.success);
  const extractCalls = events.filter(event => event.kind === 'tool_started' && event.name === 'extract_draft_params').length;
  if (extracts.some(event => !event.applied.length)) failures.push('Extraction applied nothing');
  if (failedExtracts.length) failures.push('Extraction failed without applying inputs');
  if (!extracts.length) failures.push('Missing extraction diagnostics');
  const row = { run: index, conversationId, runId: session?.usage?.runId, runIds: [...runIds], wallMs, systemMs,
    answers: turns.length - 1, answerRoutes, questions, confirmationDelivery,
    deflectionMm, extractCalls, failedExtracts, extracts: extracts.map(({ applied, unapplied, status }) => ({ applied, unapplied, status })),
    patches: events.filter(event => event.kind === 'param_extractor' && event.mode === 'patch')
      .map(({ attempt, durationMs, finishReason, usage, maxOutputTokens, outcome }) => ({ attempt, durationMs, finishReason,
        reasoningTokens: usage?.reasoningTokens, maxOutputTokens, outcome })),
    wireControls: events.filter(event => event.kind === 'llm_request_options' && event.responseFormat === 'json_object'),
    maxAgentPromptChars: Math.max(0, ...events.filter(event => event.kind === 'llm_finished' && event.messageCount > 1).map(event => event.promptChars)),
    failures, passed: !failures.length };
  results.push(row);
  if (args.out) fs.writeFileSync(args.out, JSON.stringify({ results }, null, 2) + '\n');
  console.log(JSON.stringify({ ...row, extracts: undefined, wireControls: undefined, questions: undefined }));
}
process.exitCode = results.every(row => row.passed) ? 0 : 1;
