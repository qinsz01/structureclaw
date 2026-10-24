import { describe, expect, test } from '@jest/globals';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { langGraphEventToChunks, streamGraphToChunks } from '../../../dist/agent-langgraph/streaming.js';

const receipt = id => new ToolMessage({ name: 'query_results', tool_call_id: id, content: '{"success":true}' });
const context = { conversationId: 'isolated', traceId: 'artifact-repetition', startedAt: new Date(0).toISOString() };

describe('unchanged artifact delivery', () => {
  test('multiple tool receipts preserve every step and deliver the shared artifact only once', () => {
    const analysisResult = { runId: 'run', data: { forces: { beam: { N: 42 } } } };
    const chunks = langGraphEventToChunks({ tools: { messages: [receipt('a'), receipt('b')], analysisResult } }, 'updates');
    expect(chunks.filter(chunk => chunk.type === 'step_upsert')).toHaveLength(2);
    expect(chunks.filter(chunk => chunk.type === 'artifact_payload_sync')).toEqual([
      { type: 'artifact_payload_sync', artifact: 'analysis', latestResult: { analysis: analysisResult } },
    ]);
  });

  test('deduplicates exact copies, preserves same-run changes and invalidation, and retains full final artifacts', async () => {
    const initial = { runId: 'run', selectedResultKey: 'case:D', data: { forces: { beam: { N: 42 } } } };
    const changed = { ...initial, data: { forces: { beam: { N: 43 } } } };
    const report = { runId: 'run', markdown: '# Verified analysis' };
    const saved = structuredClone({ initial, changed, report });
    async function* events() {
      for (const analysisResult of [initial, structuredClone(initial), changed, null, null, changed]) {
        yield ['updates', { tools: { messages: [receipt('step')], analysisResult } }];
      }
      yield ['updates', { tools: { messages: [receipt('report')], analysisResult: changed, report } }];
      yield ['updates', { agent: { messages: [new AIMessage('Complete.')] } }];
    }
    const chunks = [];
    for await (const chunk of streamGraphToChunks(events(), ['updates'], context)) chunks.push(chunk);
    const analysis = chunks.filter(chunk => chunk.type === 'artifact_payload_sync' && chunk.artifact === 'analysis');
    expect(analysis).toEqual([
      { type: 'artifact_payload_sync', artifact: 'analysis', latestResult: { analysis: initial } },
      { type: 'artifact_payload_sync', artifact: 'analysis', latestResult: { analysis: changed } },
      { type: 'artifact_payload_sync', artifact: 'analysis', invalidated: true },
      { type: 'artifact_payload_sync', artifact: 'analysis', latestResult: { analysis: changed } },
    ]);
    expect(chunks.filter(chunk => chunk.type === 'step_upsert')).toHaveLength(7);
    expect(chunks.find(chunk => chunk.type === 'result').content).toEqual(expect.objectContaining({ analysis: changed, report }));
    expect({ initial, changed, report }).toEqual(saved);
    expect(chunks.at(-1).type).toBe('done');
  });
});
