import { describe, expect, test } from '@jest/globals';
import { AIMessage } from '@langchain/core/messages';
import { AGENT_TOOL_DEFINITIONS } from '../../../dist/agent-langgraph/tool-registry.js';
import { executeToolsSequentially } from '../../../dist/agent-langgraph/sequential-tools.js';
import { createReviewInputTool } from '../../../dist/agent-langgraph/model-tools.js';

describe('registered tool boundaries', () => {
  test.each(AGENT_TOOL_DEFINITIONS.map(def => [def.id, def]))('%s rejects invalid arguments without mutating committed engineering state', async (name, definition) => {
    const operation = definition.create({ skillRuntime: {}, workspaceRoot: process.cwd() });
    const shape = operation.schema.shape;
    const args = Object.fromEntries(Object.keys(shape).map(key => [key, null]));
    // build_model takes no arguments; its missing draft is an execution precondition.
    if (name !== 'build_model') expect(operation.schema.safeParse(args).success).toBe(false);
    const state = { messages: [new AIMessage({ id: `message-${name}`, content: '', tool_calls: [{ name, id: `invalid-${name}`, args }] })],
      model: { nodes: [], elements: [] }, modelRevision: 7, analysisResult: { runId: 'committed-run', success: true },
      report: { runId: 'committed-run' }, codeCheckResult: { completionStatus: 'complete' }, analysisRuns: {} };
    const before = JSON.stringify(state);
    const command = await executeToolsSequentially([operation], state, {});
    expect(command.update.messages[0].status).toBe('error');
    for (const key of ['model', 'draftState', 'modelRevision', 'analysisResult', 'codeCheckResult', 'report', 'requestScope']) {
      expect(command.update).not.toHaveProperty(key);
    }
    expect(JSON.stringify(state)).toBe(before);
  });

  test('one valid review action is not blocked by an empty optional exclusion list', async () => {
    const command = await createReviewInputTool().invoke({ resolutions: [{ field: 'nodes.A.x', value: 10, unit: 'm', reason: 'Confirmed by user' }],
      excludeSources: [] }, { toolCall: { id: 'review' }, configurable: { agentState: { lastUserMessage: 'x=10 m' } } });
    const payload = JSON.parse(command.update.messages[0].content);
    expect(payload.inputEvidence).toHaveLength(1);
    expect(payload.inputEvidence[0].resolution).toMatchObject({ value: 10, unit: 'm' });
    expect(createReviewInputTool().schema.safeParse({ resolutions: [], excludeSources: [] }).success).toBe(false);
  });
});
