// Fake OpenAI-compatible LLM transport for characterization tests.
// Ported from frontend/tests/e2e/fixtures/llm-server.ts. ONLY the provider transport is
// scripted; the Fastify API, LangGraph graph, tools, persistence, OpenSees and reports are real.
//
// Two kinds of requests reach the provider:
//   - agent turns: the LangGraph chat model, always offered `tools`. These consume the
//     ordered `enqueue()` script queue so a test pins the exact agent tool-call sequence.
//   - internal calls: structural-type router, parameter extractor, LLM model builder, etc.
//     They are answered by the `internal` responder (a function inspecting the request), so
//     their count/order does not have to be predicted by the test.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

let callCounter = 0;

/** Build an assistant tool-call message. A deterministic id keeps snapshots stable. */
export function toolCall(name, args, id = `call_${name}_${++callCounter}`) {
  return { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

export function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
}

/** Concatenated text of every message in a request (used to classify internal calls). */
export function requestText(body) {
  return (body.messages ?? []).map(messageText).join('\n');
}

export function systemPrompt(body) {
  return (body.messages ?? []).filter(message => message.role === 'system' || message.role === 'developer').map(messageText).join('\n');
}

export function offeredToolNames(body) {
  return (body.tools ?? []).map(item => item.function?.name ?? item.name).filter(Boolean).sort();
}

/** Coarse classification used for recording and for picking internal responders. */
export function classifyRequest(body) {
  if (Array.isArray(body.tools) && body.tools.length > 0) return 'agent';
  const text = requestText(body);
  if (text.includes('Request goal / 本次所求结果')) return 'param-extractor';
  if (/"action": "continue_current\|switch_skill/.test(text)) return 'structural-router';
  return 'internal-other';
}

export async function startLlmFixture() {
  const requests = [];
  const failures = [];
  const scripts = [];
  let internal = null;

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        throw new Error(`Unexpected fixture endpoint: ${request.method} ${request.url}`);
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const kind = classifyRequest(body);
      // Never collect headers, credentials or application settings.
      const record = { kind, body, index: requests.length };
      requests.push(record);
      let reply;
      if (kind === 'agent') {
        const script = scripts.shift();
        if (script === undefined) throw new Error(`No scripted agent LLM response for request ${requests.length}`);
        reply = typeof script === 'function' ? await script(body, record) : script;
      } else {
        if (!internal) throw new Error(`No internal responder for ${kind} request ${requests.length}: ${requestText(body).slice(0, 400)}`);
        reply = await internal(body, record);
        if (reply === undefined) throw new Error(`Internal responder declined ${kind} request ${requests.length}: ${requestText(body).slice(0, 400)}`);
      }
      record.reply = reply;
      writeCompletion(response, body, reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message, type: 'fixture_script_error' } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    failures,
    /** Ordered replies for agent (tool-offering) requests. */
    enqueue: (...responses) => { scripts.push(...responses); },
    /** Responder for internal (non-agent) requests: (body, record) => reply | undefined. */
    setInternal: (fn) => { internal = fn; },
    pending: () => scripts.length,
    clearPending: () => { scripts.length = 0; },
    agentRequests: () => requests.filter(item => item.kind === 'agent'),
    close: () => new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

function writeCompletion(response, body, reply) {
  const message = typeof reply === 'string' ? { role: 'assistant', content: reply } : { role: 'assistant', ...reply };
  const id = `chatcmpl-characterization-${randomUUID()}`;
  const common = { id, created: Math.floor(Date.now() / 1000), model: 'characterization-scripted' };
  const finishReason = message.tool_calls?.length ? 'tool_calls' : 'stop';
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (body.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ ...common,
      object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    event({ role: 'assistant', content: message.content ?? '', ...(message.tool_calls?.length ? {
      tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })),
    } : {}) });
    event({}, finishReason);
    response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [], usage })}\n\n`);
    response.end('data: [DONE]\n\n');
  } else {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finishReason }], usage }));
  }
}
