// Shared Jest wiring for characterization suites: one fake LLM + one isolated backend per file.
import { afterAll, beforeAll, describe, expect } from '@jest/globals';
import { startLlmFixture, requestText } from './llm-fixture.mjs';
import { openSeesSkipReason, resolveOpenSeesPython, startBackend } from './backend-host.mjs';

export const TURN_TIMEOUT_MS = 60_000;

/** describe() that skips (with a visible reason) when no OpenSees Python is available. */
export function describeWithOpenSees(name, fn) {
  const reason = openSeesSkipReason();
  if (reason) {
    console.warn(`[characterization] ${name}: ${reason}`);
    return describe.skip(`${name} (skipped: OpenSees unavailable)`, fn);
  }
  return describe(name, fn);
}

export function setupHarness() {
  const ctx = {};
  beforeAll(async () => {
    ctx.llm = await startLlmFixture();
    ctx.backend = await startBackend({ llmBaseUrl: ctx.llm.baseUrl, pythonBin: resolveOpenSeesPython() ?? '' });
  }, 120_000);
  afterAll(async () => {
    await ctx.backend?.close();
    await ctx.llm?.close();
  }, 60_000);
  return ctx;
}

/**
 * Run one chat turn with an ordered agent script and assert the transport contract:
 * no error events, the expected number of failed tool steps, every scripted reply consumed
 * and no fixture failures.
 */
export async function runTurn(ctx, body, script, { expectedToolErrors = 0, resume = false } = {}) {
  const firstRequest = ctx.llm.requests.length;
  ctx.llm.enqueue(...script);
  const turn = resume ? await ctx.backend.resume(body) : await ctx.backend.stream(body);
  const requests = ctx.llm.requests.slice(firstRequest);
  expect(ctx.llm.failures).toEqual([]);
  expect(ctx.llm.pending()).toBe(0);
  expect(turn.errors).toEqual([]);
  expect(turn.steps.filter(step => step.status === 'error')).toHaveLength(expectedToolErrors);
  return { ...turn, requests };
}

/** Internal responder from per-kind handlers; unknown kinds fail the fixture loudly. */
export function internalResponder(handlers) {
  return (body, record) => {
    const handler = handlers[record.kind];
    if (!handler) return undefined;
    const reply = handler(requestText(body), body, record);
    return typeof reply === 'string' || reply === undefined ? reply : JSON.stringify(reply);
  };
}

export function routerDecision(skillId, { action = 'switch_skill', confidence = 0.95, reason = 'characterization' } = {}) {
  const mappedType = { 'concrete-frame': 'frame', generic: 'unknown' }[skillId] ?? skillId;
  return { action, skillId, structuralTypeKey: skillId, mappedType, supportLevel: 'supported', confidence, reason };
}

/** Query a saved result through the same result-review endpoint the frontend workspace uses. */
export async function queryResult(ctx, conversationId, args) {
  const review = await ctx.backend.get(`/api/v1/agent/result-review/${conversationId}`);
  expect(review.status).toBe(200);
  const response = await ctx.backend.post(`/api/v1/agent/result-review/${conversationId}/tools`, {
    revisionToken: review.body.revisionToken, tool: 'query_results', args });
  expect(response.status).toBe(200);
  expect(response.body.success).toBe(true);
  return response.body.result;
}

export async function querySimplyBeamResponses(ctx, conversationId, { runId, resultKey = 'case:LC1', supports, member, positionM }) {
  const reactions = [];
  for (const nodeId of supports) {
    reactions.push((await queryResult(ctx, conversationId, { runId, resultKey, nodeId, field: 'reactions', component: 'fz', unit: 'kN',
      quantityId: `reaction-${nodeId}` })).quantity);
  }
  const moment = (await queryResult(ctx, conversationId, { runId, resultKey, elementId: member, positionM, side: 'right',
    field: 'forces', component: 'M2', unit: 'kN.m', quantityId: 'midspan-moment' })).quantity;
  const displacement = (await queryResult(ctx, conversationId, { runId, resultKey, elementId: member, positionM, side: 'right',
    field: 'displacements', component: 'uz', unit: 'mm', quantityId: 'midspan-displacement' })).quantity;
  return { reactions, moment, displacement };
}

/** Full tool result exactly as the agent LLM received it (SSE step output is truncated). */
export function toolResultSeenByAgent(requests, toolCallId) {
  for (const request of [...requests].reverse()) {
    if (request.kind !== 'agent') continue;
    const message = (request.body.messages ?? []).find(item => item.role === 'tool' && item.tool_call_id === toolCallId);
    if (!message) continue;
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    try { return JSON.parse(text); } catch { return text; }
  }
  throw new Error(`Tool result ${toolCallId} was never sent to the agent LLM`);
}
