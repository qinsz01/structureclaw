import { describe, expect, test } from '@jest/globals';
import { AIMessage, AIMessageChunk, ToolMessage } from '@langchain/core/messages';

describe('LangGraph streaming adapter', () => {
  test('incomplete check hides unverified model tokens until the guarded final response', async () => {
    const { streamGraphToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    async function* events() {
      yield ['updates', { tools: { codeCheckResult: { completionStatus: 'incomplete' } } }];
      yield ['messages', [new AIMessageChunk('FALSE PASS'), { langgraph_node: 'agent' }]];
      yield ['updates', { agent: { messages: [new AIMessage('Code checking is incomplete.')] } }];
    }
    const chunks = [];
    for await (const chunk of streamGraphToChunks(events(), ['messages', 'updates'],
      { conversationId: 'fixture', traceId: 'check-truth', startedAt: new Date(0).toISOString() })) chunks.push(chunk);
    expect(JSON.stringify(chunks)).not.toContain('FALSE PASS');
    expect(chunks.find(chunk => chunk.type === 'result').content.response).toBe('Code checking is incomplete.');
  });
  test.each([
    { status: 'error', content: 'MEMBER_POSITION_REQUIRED' },
    { content: '{"success":false,"errorCode":"RECOVERY_BUDGET_EXHAUSTED"}' },
    { content: '{"valid":false,"message":"Missing units"}' },
  ])('shows tool failures consistently with the run ledger: %j', async (payload) => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const { toolMessageFailure } = await import('../../../dist/utils/tool-outcome.js');
    const message = new ToolMessage({ name: 'query_results', tool_call_id: 'query', ...payload });
    const chunks = langGraphEventToChunks({ tools: { messages: [message] } }, 'updates');
    const step = chunks.find(chunk => chunk.type === 'step_upsert').step;
    expect(step.status).toBe('error');
    expect(step.errorMessage).toBe(toolMessageFailure(message));
  });

  test('keeps main-agent tables accompanying clarification tool calls and excludes nested JSON', async () => {
    const { streamGraphToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const table = '| Result | Value |\n| --- | --- |\n| Midspan deflection | -1.51699029 mm |';
    const question = 'Continue creating the report?';
    async function* events() {
      yield ['messages', [new AIMessageChunk('{"action":"switch_skill"}'), { langgraph_node: 'tools' }]];
      yield ['updates', { agent: { messages: [new AIMessage({ content: table, tool_calls: [
        { id: 'ask', name: 'ask_user_clarification', args: { question }, type: 'tool_call' },
      ] })] } }];
      yield ['updates', { __interrupt__: [{ value: { question, options: ['Continue', 'Skip'] } }] }];
    }
    const chunks = [];
    for await (const chunk of streamGraphToChunks(events(), ['messages', 'updates'],
      { conversationId: 'fixture', traceId: 'table-fixture', startedAt: new Date(0).toISOString() })) chunks.push(chunk);
    expect(chunks.filter(chunk => chunk.type === 'summary_replace').map(chunk => chunk.summaryText)).toEqual([table, table]);
    expect(chunks.find(chunk => chunk.type === 'interaction_update').content).toEqual(expect.objectContaining({
      guidanceText: `${table}\n\n${question}`, resumeRequired: true,
    }));
    expect(JSON.stringify(chunks)).not.toContain('switch_skill');
    expect(chunks.some(chunk => chunk.type === 'done')).toBe(false);
  });

  test('streams only main-agent text and hides nested router and extraction JSON', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const internal = new AIMessageChunk('{"action":"switch_skill","skillId":"beam"}');
    expect(langGraphEventToChunks([internal, { langgraph_node: 'tools' }], 'messages')).toEqual([]);
    const response = new AIMessageChunk('The beam is ready for analysis.');
    expect(langGraphEventToChunks([response, { langgraph_node: 'agent' }], 'messages')).toEqual([
      { type: 'token', content: 'The beam is ready for analysis.' },
    ]);
  });

  test('a clarification replaces an earlier internal blocker in the streamed presentation', async () => {
    const { streamGraphToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const question = '请补充梁的材料牌号和截面尺寸。';
    async function* events() {
      yield ['updates', { tools: { messages: [new ToolMessage({ name: 'extract_draft_params', tool_call_id: 'extract',
        content: JSON.stringify({ canProceed: false, reason: 'templateProperties; do not build_model',
          clarificationQuestions: [{ question }] }) })] } }];
      yield ['updates', { __interrupt__: [{ value: { question, options: ['Q235，100×200 mm矩形截面'] } }] }];
    }
    const chunks = [];
    for await (const chunk of streamGraphToChunks(events(), ['messages', 'updates', 'custom'],
      { conversationId: 'fixture', traceId: 'clarification-fixture', startedAt: new Date(0).toISOString() })) chunks.push(chunk);
    expect(chunks.filter(chunk => chunk.type === 'summary_replace').map(chunk => chunk.summaryText)).toEqual([question, question]);
    expect(chunks.find(chunk => chunk.type === 'interaction_update').content.questions[0].question).toBe(question);
    expect(chunks.some(chunk => chunk.type === 'done')).toBe(false);
  });

  test('invalidates the displayed result when the model changes', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const chunks = langGraphEventToChunks({ tools: {
      analysisResult: null, report: null,
      messages: [new ToolMessage({ name: 'edit_model', tool_call_id: 'move', content: '{"success":true}' })],
    } }, 'updates');
    expect(chunks).toEqual(expect.arrayContaining([
      { type: 'artifact_payload_sync', artifact: 'analysis', invalidated: true },
      { type: 'artifact_payload_sync', artifact: 'report', invalidated: true },
    ]));
  });
  test('emits a summary when extract_draft_params cannot proceed', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const chunks = langGraphEventToChunks({
      tools: {
        messages: [
          new ToolMessage({
            name: 'extract_draft_params',
            tool_call_id: 'call-extract',
            content: JSON.stringify({
              canProceed: false,
              reason: '草稿仍缺少关键参数：floorLoads。',
            }),
          }),
        ],
      },
    }, 'updates');

    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'summary_replace',
        summaryText: '草稿仍缺少关键参数：floorLoads。',
      }),
    ]));
  });

  test('emits a summary when memory rejects draft parameter storage', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const chunks = langGraphEventToChunks({
      tools: {
        messages: [
          new ToolMessage({
            name: 'memory',
            tool_call_id: 'call-memory',
            content: JSON.stringify({
              success: false,
              message: 'Current draft parameters cannot be stored in memory.',
            }),
          }),
        ],
      },
    }, 'updates');

    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'summary_replace',
        summaryText: 'Current draft parameters cannot be stored in memory.',
      }),
    ]));
  });

  test('does not emit summaries for generic tool failure messages', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const chunks = langGraphEventToChunks({
      tools: {
        messages: [
          new ToolMessage({
            name: 'run_analysis',
            tool_call_id: 'call-analysis',
            content: JSON.stringify({
              success: false,
              message: 'OpenSees failed while reading C:\\\\tmp\\\\internal\\\\model.tcl',
            }),
          }),
        ],
      },
    }, 'updates');

    expect(chunks.some((chunk) => chunk.type === 'summary_replace')).toBe(false);
  });

  test('sanitizes and truncates user-actionable tool blocker summaries', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const chunks = langGraphEventToChunks({
      tools: {
        messages: [
          new ToolMessage({
            name: 'memory',
            tool_call_id: 'call-memory',
            content: JSON.stringify({
              success: false,
              message: `Draft params at C:\\\\tmp\\\\internal\\\\draft.json cannot be stored. ${'x'.repeat(300)}`,
            }),
          }),
        ],
      },
    }, 'updates');

    const summary = chunks.find((chunk) => chunk.type === 'summary_replace');
    expect(summary).toBeDefined();
    expect(summary.summaryText).toContain('[path]');
    expect(summary.summaryText).not.toContain('C:\\\\tmp');
    expect(summary.summaryText.length).toBeLessThanOrEqual(240);
  });
});
