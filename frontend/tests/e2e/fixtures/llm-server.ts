import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

export type LlmMessage = {
  role?: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};
export type LlmRequest = {
  messages: LlmMessage[];
  tools?: Array<{ function: { name: string; description?: string } }>;
  stream?: boolean;
  model?: string;
};
type Reply = string | LlmMessage;
type Script = Reply | ((request: LlmRequest) => Reply | Promise<Reply>);

export function toolCall(name: string, args: Record<string, unknown>, id = `call_${randomUUID()}`): LlmMessage {
  return { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

/** Only the external LLM transport is scripted. All product APIs, graph state,
 * permissions, tools, persistence and engineering operations remain real. */
export async function startLlmFixture() {
  const requests: LlmRequest[] = [];
  const failures: string[] = [];
  const scripts: Script[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        throw new Error(`Unexpected fixture endpoint: ${request.method} ${request.url}`);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as LlmRequest;
      requests.push(body); // Never collect headers, credentials or application settings.
      const script = scripts.shift();
      if (script === undefined) throw new Error(`No scripted LLM response for request ${requests.length}`);
      const reply = typeof script === 'function' ? await script(body) : script;
      const message = typeof reply === 'string' ? { role: 'assistant', content: reply } : { role: 'assistant', ...reply };
      const id = `chatcmpl-e2e-${randomUUID()}`;
      const common = { id, created: Math.floor(Date.now() / 1000), model: 'e2e-scripted' };
      const finishReason = message.tool_calls?.length ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const event = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ ...common,
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message, type: 'fixture_script_error' } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, failures,
    enqueue: (...responses: Script[]) => { scripts.push(...responses); },
    pending: () => scripts.length,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
export type LlmFixture = Awaited<ReturnType<typeof startLlmFixture>>;

export async function configureFixtureLlm(request: APIRequestContext, fixture: LlmFixture) {
  if (process.env.SCLAW_E2E_LIVE === '1') throw new Error('LLM_FIXTURE_FORBIDDEN_IN_LIVE_MODE');
  const healthResponse = await request.get('/health');
  const health = await healthResponse.json();
  const database = await (await request.get('/api/v1/admin/database/status')).json();
  const server = new URL(healthResponse.url());
  if (server.hostname !== '127.0.0.1' || ['31415', '31416', '31615'].includes(server.port)
    || !String(health.instanceId).startsWith('playwright-')
    || !/[\\/]\.tmp[\\/]playwright-[^\\/]+[\\/]/.test(database.database?.databasePath ?? '')) {
    throw new Error('LLM_FIXTURE_REQUIRES_ISOLATED_PLAYWRIGHT_SERVER');
  }
  const response = await request.put('/api/v1/admin/llm', { data: {
    baseUrl: fixture.baseUrl, model: 'e2e-scripted', apiKey: 'e2e-fixture-not-a-secret', apiKeyMode: 'replace',
  } });
  if (!response.ok()) throw new Error(`Fixture LLM configuration failed: ${response.status()} ${await response.text()}`);
}
