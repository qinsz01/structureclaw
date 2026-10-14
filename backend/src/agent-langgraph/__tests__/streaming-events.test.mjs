import { describe, expect, test } from '@jest/globals';
import { AIMessage, ToolMessage } from '@langchain/core/messages';

describe('streaming: token events from "messages" mode', () => {
  test('emits a token chunk for text content in AIMessageChunk', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

    // Simulate LangGraph messages-mode event: [chunk, metadata]
    const { AIMessageChunk } = await import('@langchain/core/messages');
    const chunk = new AIMessageChunk({ content: 'Hello, world' });
    const chunks = langGraphEventToChunks([chunk, {}], 'messages');

    expect(chunks).toEqual([{ type: 'token', content: 'Hello, world' }]);
  });

  test('does not emit token chunks for empty AI message chunks', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const { AIMessageChunk } = await import('@langchain/core/messages');

    const emptyChunk = new AIMessageChunk({ content: '' });
    const chunks = langGraphEventToChunks([emptyChunk, {}], 'messages');
    expect(chunks).toEqual([]);
  });

  test('does not emit token chunks for AI message chunks with tool calls', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const { AIMessageChunk } = await import('@langchain/core/messages');

    const chunkWithToolCall = new AIMessageChunk({
      content: '',
      tool_calls: [{ id: 'tc1', name: 'build_model', args: {}, type: 'tool_call' }],
    });
    const chunks = langGraphEventToChunks([chunkWithToolCall, {}], 'messages');
    expect(chunks).toEqual([]);
  });

  test('handles bare message (not array) in messages mode', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const { AIMessageChunk } = await import('@langchain/core/messages');

    const chunk = new AIMessageChunk({ content: 'direct chunk' });
    const chunks = langGraphEventToChunks(chunk, 'messages');
    expect(chunks).toEqual([{ type: 'token', content: 'direct chunk' }]);
  });

  test('handles array content blocks in AI message chunk', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const { AIMessageChunk } = await import('@langchain/core/messages');

    const chunk = new AIMessageChunk({
      content: [{ type: 'text', text: 'block text' }],
    });
    const chunks = langGraphEventToChunks([chunk, {}], 'messages');
    expect(chunks).toEqual([{ type: 'token', content: 'block text' }]);
  });
});

describe('streaming: step_upsert events from "updates" mode', () => {
  test('emits step_upsert running when agent node returns tool calls', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

    const aiMsg = new AIMessage({
      content: '',
      tool_calls: [{ id: 'call-build', name: 'build_model', args: {}, type: 'tool_call' }],
    });
    const chunks = langGraphEventToChunks({ agent: { messages: [aiMsg] } }, 'updates');

    const stepChunk = chunks.find((c) => c.type === 'step_upsert');
    expect(stepChunk).toBeDefined();
    expect(stepChunk.step.status).toBe('running');
    expect(stepChunk.step.tool).toBe('build_model');
  });

  test('emits step_upsert done when tools node returns ToolMessage', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

    const toolMsg = new ToolMessage({
      content: JSON.stringify({ success: true }),
      tool_call_id: 'call-validate',
      name: 'validate_model',
    });
    const chunks = langGraphEventToChunks({ tools: { messages: [toolMsg] } }, 'updates');

    const stepChunk = chunks.find((c) => c.type === 'step_upsert');
    expect(stepChunk).toBeDefined();
    expect(stepChunk.step.status).toBe('done');
    expect(stepChunk.step.tool).toBe('validate_model');
  });

  test('emits result chunk when agent produces a final text response', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

    const aiMsg = new AIMessage('The analysis is complete.');
    const chunks = langGraphEventToChunks({ agent: { messages: [aiMsg] } }, 'updates');

    const resultChunk = chunks.find((c) => c.type === 'result');
    expect(resultChunk).toBeDefined();
    expect(resultChunk.content.response).toBe('The analysis is complete.');
    expect(resultChunk.content.mode).toBe('conversation');
  });

  test('emits step_upsert for multiple tool calls in one agent turn', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

    const aiMsg = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'c1', name: 'detect_structure_type', args: {}, type: 'tool_call' },
        { id: 'c2', name: 'extract_draft_params', args: {}, type: 'tool_call' },
        { id: 'c3', name: 'run_analysis', args: {}, type: 'tool_call' },
      ],
    });
    const chunks = langGraphEventToChunks({ agent: { messages: [aiMsg] } }, 'updates');

    const stepChunks = chunks.filter((c) => c.type === 'step_upsert');
    expect(stepChunks).toHaveLength(3);
    expect(stepChunks.map((c) => c.step.tool)).toEqual([
      'detect_structure_type', 'extract_draft_params', 'run_analysis',
    ]);
  });
});

describe('streaming: artifact_payload_sync from tools output', () => {
  test('emits artifact_payload_sync when nodeState contains model', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

    const toolMsg = new ToolMessage({
      content: JSON.stringify({ success: true }),
      tool_call_id: 'call-build',
      name: 'build_model',
    });
    const nodeState = { messages: [toolMsg], model: { nodes: {}, elements: {} } };
    const chunks = langGraphEventToChunks({ tools: nodeState }, 'updates');

    const artifactChunk = chunks.find((c) => c.type === 'artifact_payload_sync' && c.artifact === 'model');
    expect(artifactChunk).toBeDefined();
    expect(artifactChunk.model).toEqual({ nodes: {}, elements: {} });
  });

  test('emits artifact_payload_sync when nodeState contains analysisResult via Command', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const { Command } = await import('@langchain/langgraph');

    const toolMsg = new ToolMessage({
      content: JSON.stringify({ success: true }),
      tool_call_id: 'call-analysis',
      name: 'run_analysis',
    });
    const cmd = new Command({
      update: { messages: [toolMsg], analysisResult: { displacements: [] } },
    });
    const chunks = langGraphEventToChunks({ tools: [cmd] }, 'updates');

    const artifactChunk = chunks.find((c) => c.type === 'artifact_payload_sync' && c.artifact === 'analysis');
    expect(artifactChunk).toBeDefined();
    expect(artifactChunk.latestResult.analysis).toEqual({ displacements: [] });
  });

  test('does not emit artifact_payload_sync when tool output is not success JSON', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

    const toolMsg = new ToolMessage({
      content: 'not-json',
      tool_call_id: 'call-1',
      name: 'build_model',
    });
    const nodeState = { messages: [toolMsg], model: { nodes: {} } };
    const chunks = langGraphEventToChunks({ tools: nodeState }, 'updates');

    const artifactChunk = chunks.find((c) => c.type === 'artifact_payload_sync');
    expect(artifactChunk).toBeUndefined();
  });
});

describe('streaming: step_upsert from Command-array tools output', () => {
  test('extracts ToolMessages from mixed Command and plain-object array', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const { Command } = await import('@langchain/langgraph');

    const toolMsg = new ToolMessage({
      content: JSON.stringify({ success: true }),
      tool_call_id: 'call-build',
      name: 'build_model',
    });
    const cmd = new Command({ update: { messages: [toolMsg] } });
    const chunks = langGraphEventToChunks({ tools: [cmd] }, 'updates');

    const stepChunk = chunks.find((c) => c.type === 'step_upsert');
    expect(stepChunk).toBeDefined();
    expect(stepChunk.step.tool).toBe('build_model');
    expect(stepChunk.step.status).toBe('done');
  });

  test('extracts ToolMessages from multiple Commands in one array', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');
    const { Command } = await import('@langchain/langgraph');

    const cmd1 = new Command({
      update: { messages: [new ToolMessage({
        content: '{}', tool_call_id: 'c1', name: 'run_analysis',
      })] },
    });
    const cmd2 = new Command({
      update: { messages: [new ToolMessage({
        content: '{}', tool_call_id: 'c2', name: 'generate_report',
      })] },
    });
    const chunks = langGraphEventToChunks({ tools: [cmd1, cmd2] }, 'updates');

    const stepChunks = chunks.filter((c) => c.type === 'step_upsert');
    expect(stepChunks).toHaveLength(2);
    expect(stepChunks.map((c) => c.step.tool)).toEqual(['run_analysis', 'generate_report']);
  });
});

describe('streaming: interrupt events from "updates" mode', () => {
  test('emits interaction_update for __interrupt__ with question', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

    const event = {
      __interrupt__: [{ value: { question: 'What is the beam span?' } }],
    };
    const chunks = langGraphEventToChunks(event, 'updates');

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ type: 'summary_replace', summaryText: 'What is the beam span?' });
    expect(chunks[1].type).toBe('interaction_update');
    expect(chunks[1].content.resumeRequired).toBe(true);
    expect(chunks[1].content.questions[0].question).toBe('What is the beam span?');
  });

  test('emits interaction_update for single (non-array) __interrupt__', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

    const event = {
      __interrupt__: { value: { question: '请输入截面尺寸？' } },
    };
    const chunks = langGraphEventToChunks(event, 'updates');

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ type: 'summary_replace', summaryText: '请输入截面尺寸？' });
    expect(chunks[1].type).toBe('interaction_update');
    expect(chunks[1].content.questions[0].question).toBe('请输入截面尺寸？');
    expect(chunks[1].content.resumeRequired).toBe(true);
  });
});

describe('streaming: custom event passthrough', () => {
  test('passes through structured custom events as-is', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

    const customEvent = { type: 'phase_upsert', phaseId: 'phase-analysis', phase: { status: 'running' } };
    const chunks = langGraphEventToChunks(customEvent, 'custom');

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(customEvent);
  });

  test('converts string custom events to summary_replace', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

    const chunks = langGraphEventToChunks('分析进行中…', 'custom');

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ type: 'summary_replace', summaryText: '分析进行中…' });
  });

  test('ignores non-string, non-object custom events', async () => {
    const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

    expect(langGraphEventToChunks(null, 'custom')).toEqual([]);
    expect(langGraphEventToChunks(42, 'custom')).toEqual([]);
  });
});

describe('streaming: step_upsert for at least 5 tool types', () => {
  const toolPhaseMap = {
    detect_structure_type: 'understanding',
    extract_draft_params: 'understanding',
    build_model: 'modeling',
    validate_model: 'modeling',
    run_analysis: 'analysis',
    run_code_check: 'analysis',
    generate_report: 'report',
  };

  for (const [toolName, expectedPhase] of Object.entries(toolPhaseMap)) {
    test(`emits step_upsert for tool: ${toolName}`, async () => {
      const { langGraphEventToChunks } = await import('../../../dist/agent-langgraph/streaming.js');

      const toolMsg = new ToolMessage({
        content: JSON.stringify({ success: true }),
        tool_call_id: `call-${toolName}`,
        name: toolName,
      });
      const chunks = langGraphEventToChunks({ tools: { messages: [toolMsg] } }, 'updates');

      const stepChunk = chunks.find((c) => c.type === 'step_upsert');
      expect(stepChunk).toBeDefined();
      expect(stepChunk.step.tool).toBe(toolName);
      expect(stepChunk.step.status).toBe('done');
      expect(stepChunk.step.phase).toBe(expectedPhase);
    });
  }
});
