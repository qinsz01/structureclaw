// Shared HTTP/SSE client for the LIVE acceptance scripts (not part of Jest). Never prints credentials.
export const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) => {
  if (item.startsWith('--')) pairs.push([item.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : 'true']);
  return pairs;
}, []));
export const BASE = (args['base-url'] ?? process.env.SCLAW_LIVE_BASE_URL ?? 'http://127.0.0.1:31415').replace(/\/$/, '');
const TURN_TIMEOUT_MS = 15 * 60_000;

export async function json(method, url, body) {
  const response = await fetch(`${BASE}${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

/** POST an SSE chat turn and collect its events. */
export async function turn(route, body) {
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

export const toolCalls = (t, name) => t.steps.filter(step => step.tool === name && step.status === 'done');
export const toolSequence = t => t.steps.filter(step => step.status !== 'running').map(step => `${step.tool}:${step.status}`);
/** Clarification interrupts plus ask_user_clarification calls of one turn. */
export const questionCount = t => Math.max(t.interactions.length, t.steps.filter(step => step.tool === 'ask_user_clarification' && step.status !== 'running').length);
export const relErr = (actual, expected) => Math.abs(actual - expected) / Math.abs(expected);
export function check(failures, condition, message) { if (!condition) failures.push(message); }

export async function queryResult(conversationId, query) {
  const review = await json('GET', `/api/v1/agent/result-review/${conversationId}`);
  if (review.status !== 200) throw new Error(`result-review ${review.status}`);
  const response = await json('POST', `/api/v1/agent/result-review/${conversationId}/tools`, {
    revisionToken: review.body.revisionToken, tool: 'query_results', args: query });
  if (response.status !== 200 || response.body?.success !== true) throw new Error(`query_results failed: ${JSON.stringify(response.body).slice(0, 400)}`);
  return response.body.result;
}

/** The model of the current run: the built model, else the run's own snapshot. */
export async function runModel(conversationId, runId) {
  const review = (await json('GET', `/api/v1/agent/input-review/${conversationId}`)).body;
  if (review?.model?.nodes) return review.model;
  return (await queryResult(conversationId, { runId, field: 'reactions', includeModelSnapshot: true })).modelSnapshot;
}

export async function backendLlm() {
  try { return await json('GET', '/api/v1/admin/llm'); }
  catch (error) { console.error(`[live] backend not reachable at ${BASE}: ${error.message}`); process.exit(1); }
}
