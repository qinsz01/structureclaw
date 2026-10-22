import { describe, expect, test } from '@jest/globals';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { conversationModelingUsage } from '../dist/agent-langgraph/session/snapshot.js';

const state = messages => ({ messages, runPolicy: { activeSkillIds: ['beam', 'generic'] }, draftState: { skillId: 'beam' } });
const usage = (events = [], startedToolCallIds = []) => ({ events, startedToolCallIds });
const receipt = (name, id, output) => new ToolMessage({ name, tool_call_id: id, content: JSON.stringify(output) });

describe('actual modelling usage in the current run', () => {
  test('allowed skills, previous drafts and assistant claims are not execution', () => {
    const messages = [new AIMessage('{"skillId":"beam"}'), receipt('extract_draft_params', 'old', { skillId: 'beam' }),
      receipt('run_analysis', 'current', { skillId: 'opensees-static', success: true })];
    expect(conversationModelingUsage(state(messages), usage([], ['current']))).toEqual({
      routedSkillId: null, usedSkillIds: [], builder: null,
    });
  });

  test('a routing decision alone is not an invoked skill', () => {
    expect(conversationModelingUsage(state([]), usage([{ kind: 'structural_routing', skillId: 'generic' }]))).toEqual({
      routedSkillId: 'generic', usedSkillIds: [], builder: null,
    });
  });

  test('actual extraction and building are deduplicated and stay separate from providers', () => {
    const events = [{ kind: 'structural_routing', skillId: 'generic' }, { kind: 'param_extractor', skillId: 'generic' },
      { kind: 'model_builder', builder: 'llm', skillId: 'generic' }, { kind: 'param_extractor', skillId: 'opensees-static' }];
    const input = state([]);
    const before = JSON.stringify({ input, events });
    expect(conversationModelingUsage(input, usage(events))).toEqual({ routedSkillId: 'generic', usedSkillIds: ['generic'], builder: 'llm' });
    expect(JSON.stringify({ input, events })).toBe(before);
  });

  test('an explicit model import does not invent a modelling skill', () => {
    expect(conversationModelingUsage(state([]), usage([{ kind: 'model_builder', builder: 'explicit', source: 'model' }]))).toEqual({
      routedSkillId: null, usedSkillIds: [], builder: 'explicit',
    });
  });

  test('historical receipts are usable only when their call IDs belong to this run', () => {
    const messages = [receipt('extract_draft_params', 'old', { skillId: 'beam' }),
      receipt('detect_structure_type', 'route', { skillId: 'generic', scopeExclusion: { skillId: 'beam' } }),
      receipt('extract_draft_params', 'extract', { structuralTypeMatch: { skillId: 'generic' }, canProceed: false })];
    expect(conversationModelingUsage(state(messages), usage([], ['route', 'extract']))).toEqual({
      routedSkillId: 'generic', usedSkillIds: ['generic'], builder: null,
    });
  });

  test('failed extraction receipts and an empty scope do not create usage', () => {
    const messages = [receipt('extract_draft_params', 'failed', { skillId: 'generic', success: false })];
    expect(conversationModelingUsage(state(messages), usage([], ['failed'])).usedSkillIds).toEqual([]);
    expect(conversationModelingUsage({ ...state(messages), runPolicy: { activeSkillIds: [] } },
      usage([{ kind: 'param_extractor', skillId: 'generic' }], ['failed']))).toEqual({ routedSkillId: null, usedSkillIds: [], builder: null });
    expect(conversationModelingUsage(state(messages), null)).toEqual({ routedSkillId: null, usedSkillIds: [], builder: null });
  });
});
