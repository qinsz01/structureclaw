import { expect, test } from '@jest/globals';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createServer } from 'node:http';
import { CompatibleChatOpenAICompletions, wrapWithLlmLogging } from '../dist/utils/llm.js';
import { createRunContext, withRunContext } from '../dist/runtime/run-context.js';
import { resolveRunPolicy } from '../dist/runtime/run-policy.js';

const encode = value => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const delta = (value, finish) => ({ id: 'stream-fixture', object: 'chat.completion.chunk', model: 'fixture',
  choices: [{ index: 0, delta: value, finish_reason: finish ?? null }] });
const chunks = [delta({}), delta({ reasoning_content: 'Private reasoning fixture' }),
  delta({ content: 'Read the current model.' }),
  delta({ tool_calls: [{ index: 0, id: 'call-read', type: 'function', function: { name: 'query_model', arguments: '{"collection":' } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: '"sections"}' } }] }, 'tool_calls'),
  { id: 'stream-fixture', choices: [], usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168,
    completion_tokens_details: { reasoning_tokens: 21 } } },
];

test.each([false, true])('roleless deltas preserve complete calls and usage (callback streaming=%s)', async callbackStreaming => {
  const requests = [];
  const fields = { apiKey: 'fixture', model: 'fixture', streaming: true, maxRetries: 0,
    configuration: { fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(new ReadableStream({ start(controller) {
        chunks.forEach(row => controller.enqueue(encode(row)));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    } } };
  const model = wrapWithLlmLogging(new ChatOpenAI({ ...fields, completions: new CompatibleChatOpenAICompletions(fields) }), () => 'fixture');
  const query = tool(async () => { throw Error('A model invocation must not execute a tool'); }, { name: 'query_model', description: 'Read model', schema: z.object({ collection: z.string() }) });
  const runtime = createRunContext(resolveRunPolicy({ availableSkillIds: [], availableToolIds: ['query_model'], defaultToolIds: ['query_model'] }));
  const options = callbackStreaming ? { callbacks: [{ name: 'graph-stream', lc_prefer_streaming: true, handleLLMNewToken() {} }] } : undefined;
  const result = await withRunContext(runtime, () => model.bindTools([query]).invoke([new HumanMessage('Read the section')], options));
  expect(requests).toHaveLength(1);
  expect(requests[0].stream).toBe(true);
  expect(result).toBeInstanceOf(AIMessage);
  expect(result).not.toBeInstanceOf(AIMessageChunk);
  expect(result.content).toBe('Read the current model.');
  expect(result.tool_calls).toEqual([{ name: 'query_model', args: { collection: 'sections' }, id: 'call-read', type: 'tool_call' }]);
  expect(result.additional_kwargs.reasoning_content).toBe('Private reasoning fixture');
  expect(result.usage_metadata).toMatchObject({ input_tokens: 123, output_tokens: 45, total_tokens: 168 });
  expect(runtime.usage.llmCalls).toBe(1);
  expect(runtime.usage.events.filter(row => row.kind === 'llm_finished')).toMatchObject([{ success: true, usage: { totalTokens: 168 } }]);
  // The persisted assistant remains valid input for a subsequent tool-response turn.
  await model.bindTools([query]).invoke([new HumanMessage('Read'), result,
    new ToolMessage({ content: '{}', tool_call_id: 'call-read' })]);
  expect(requests[1].messages[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call-read', function: { name: 'query_model', arguments: '{"collection":"sections"}' } }] });
});

test('a broken stream never publishes a partially assembled tool call or retries its execution', async () => {
  let calls = 0;
  const model = new CompatibleChatOpenAICompletions({ model: 'fixture', apiKey: 'fixture', streaming: true, maxRetries: 0,
    configuration: { fetch: async () => { calls++;
      let cursor = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (cursor < 4) controller.enqueue(encode(chunks[cursor++]));
        else controller.error(new Error('stream interrupted'));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    } } });
  await expect(model.invoke('Read')).rejects.toThrow('stream interrupted');
  expect(calls).toBe(1);
});

test('streaming continues a slow live response past the header timeout and cancellation rejects partial calls', async () => {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(encode(chunks[0]));
    let cursor = 1;
    const timer = setInterval(() => {
      if (cursor < chunks.length) response.write(encode(chunks[cursor++]));
      else { clearInterval(timer); response.end('data: [DONE]\n\n'); }
    }, 60);
    response.once('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const model = new CompatibleChatOpenAICompletions({ model: 'fixture', apiKey: 'fixture', streaming: true, timeout: 120, maxRetries: 0,
      configuration: { baseURL: `http://127.0.0.1:${server.address().port}/v1` } });
    const start = Date.now();
    const result = await model.invoke('Read');
    expect(Date.now() - start).toBeGreaterThan(120);
    expect(result.tool_calls).toHaveLength(1);
    expect(result).toBeInstanceOf(AIMessage);
    const tracked = wrapWithLlmLogging(model, () => 'fixture');
    await expect(tracked.invoke('Read', { signal: AbortSignal.timeout(200),
      callbacks: [{ name: 'graph-stream', lc_prefer_streaming: true, handleLLMNewToken() {} }] })).rejects.toThrow();
    expect(calls).toBe(2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
