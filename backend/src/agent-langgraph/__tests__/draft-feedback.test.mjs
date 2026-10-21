import fs from 'node:fs';
import { expect, jest, test } from '@jest/globals';
const extract = jest.fn();
jest.unstable_mockModule('../../../dist/agent-langgraph/param-extractor.js', () => ({ invokeParamExtractor: extract }));

test('compact extraction reports applied/unapplied fields, persists full state, and no-op retries do not reset the guard', async () => {
  const { handler } = await import('../../../dist/agent-skills/structure-type/beam/handler.js');
  const { createExtractDraftParamsTool } = await import('../../../dist/agent-langgraph/tools.js');
  const { guardLedger, NO_PROGRESS_LIMIT } = await import('../../../dist/agent-langgraph/guards/tool-guards.js');
  const { executeToolsSequentially } = await import('../../../dist/agent-langgraph/sequential-tools.js');
  const { createRunContext, withRunContext } = await import('../../../dist/runtime/run-context.js');
  const { resolveRunPolicy } = await import('../../../dist/runtime/run-policy.js');
  const { AIMessage } = await import('@langchain/core/messages');
  const saved = JSON.parse(fs.readFileSync(new URL('../../../tests/fixtures/material-merge-session.json', import.meta.url), 'utf8'));
  const plugin = { id: 'beam', structureType: 'beam', manifest: { structuralTypeKeys: ['beam'] }, handler };
  const tool = createExtractDraftParamsTool({ resolvePluginForType: async () => plugin,
    detectStructuralTypeWithLlm: async () => ({ key: 'beam', mappedType: 'beam', skillId: 'beam', supportLevel: 'supported', routingSource: 'llm-suggested' }) });
  const state = { structuralTypeKey: 'beam', draftState: saved.extractions[5].nextState, locale: 'zh',
    requestScope: { responses: ['forces', 'reactions', 'displacements'], design: false, report: false, outputs: [] } };
  extract.mockResolvedValue({ engineeringDraft: { material: { grade: 'Q235' } },
    unapplied: [{ field: 'unsupported', reason: 'NO_SCHEMA_FIELD', message: 'No matching field / 无对应字段' }] });
  const command = await tool.invoke({ message: saved.answers[1] }, { toolCall: { id: 'material' }, configurable: { agentState: state } });
  const output = JSON.parse(command.update.messages[0].content);
  expect(output).toMatchObject({ status: 'partial', applied: expect.arrayContaining(['engineeringDraft.materials["M1"].grade']),
    unapplied: expect.arrayContaining([expect.objectContaining({ reason: 'NO_SCHEMA_FIELD' })]),
    notes: [expect.objectContaining({ reason: 'MISPLACED_SECTION_MATERIALS' })] });
  for (const key of ['nextState', 'engineeringDraft', 'llmDraftPatch']) expect(output).not.toHaveProperty(key);
  expect(command.update.draftState.engineeringDraft.materials[0].grade).toBe('Q235');
  const context = createRunContext(resolveRunPolicy({ availableSkillIds: ['beam'], availableToolIds: ['extract_draft_params'],
    defaultToolIds: ['extract_draft_params'] }));
  let current = { ...state, ...command.update, analysisResult: { runId: 'kept' }, modelPending: false };
  extract.mockResolvedValue({ engineeringDraft: { material: { grade: 'Q235' } } });
  for (let index = 0; index < NO_PROGRESS_LIMIT; index++) {
    const next = await withRunContext(context, () => executeToolsSequentially([tool], { ...current, messages: [new AIMessage({ content: '',
      tool_calls: [{ id: `noop-${index}`, name: 'extract_draft_params', args: { message: `Same evidence restatement ${index}` } }] })] },
    { configurable: {} }));
    expect(JSON.parse(next.update.messages[0].content)).toMatchObject({ status: 'no_change', applied: [], unapplied: [] });
    expect(next.update).not.toHaveProperty('analysisResult');
    current = { ...current, ...next.update };
  }
  expect(guardLedger(context).stop).toEqual({ reason: 'no-progress', calls: NO_PROGRESS_LIMIT });
  expect(current.analysisResult).toEqual({ runId: 'kept' });
}, 60000);
