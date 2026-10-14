import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRunPolicy, runPolicyInputSchema } from '../../../dist/runtime/run-policy.js';
import { createRunContext, withRunContext, requestRecovery, reserveToolCall, recordToolOutcome, reserveLlmCall, snapshotRunUsage } from '../../../dist/runtime/run-context.js';
const available = { availableSkillIds: ['beam', 'generic', 'opensees-static'], availableToolIds: ['build_model', 'edit_model', 'run_analysis', 'query_results', 'generate_report', 'ask_user_clarification', 'memory'], defaultToolIds: ['build_model', 'edit_model', 'run_analysis', 'query_results', 'generate_report', 'ask_user_clarification', 'memory'] };
const policy = (requested = {}, extra = {}) => resolveRunPolicy({ ...available, requested, ...extra });

describe('run policy contract and aggregate accounting', () => {
  test('default, empty, permission intersection and field provenance have distinct meanings', () => {
    expect(policy().budgets.maxToolCallsPerTurn).toBe(200);
    expect(policy().repair).toEqual({ enabled: true, maxRecoveriesPerTurn: 2 });
    expect(policy({ skillIds: [], tools: { enabledIds: [] } })).toMatchObject({ activeSkillIds: [], activeToolIds: [] });
    const restricted = policy({ skillIds: ['beam', 'generic'], budgets: { maxToolCallsPerTurn: 100 } }, { allowedSkillIds: ['beam'], maxToolCallsPerTurn: 50 });
    expect(restricted.activeSkillIds).toEqual(['beam']);
    expect(restricted.deniedSkillIds).toEqual(['generic']);
    expect(restricted.fieldSources['budgets.maxToolCallsPerTurn']).toBe('server-limit');
    expect(restricted.budgets.maxToolCallsPerTurn).toBe(50);
    expect(policy({}, { legacy: { skillIds: [] } }).activeSkillIds).toEqual([]);
  });
  test('unknown fields, conflicting boundary aliases, invalid fixed routes and external context claims fail', () => {
    expect(() => runPolicyInputSchema.parse({ magicalFallback: true })).toThrow();
    expect(() => policy({ skillIds: ['beam'] }, { legacy: { skillIds: [] } })).toThrow('RUN_POLICY_CONFLICT');
    expect(() => policy({ skillIds: [], routing: { mode: 'fixed', skillId: 'beam' } })).toThrow('FIXED_SKILL_OUTSIDE_SCOPE');
    expect(() => policy({ context: { history: 'current-turn' } }, { executionOwner: 'external' })).toThrow('HOST_CONTEXT_CONTROL_UNSUPPORTED');
    expect(policy({}, { executionOwner: 'external' }).enforcement).toMatchObject({ hostLoop: 'external', conversationText: 'external', llmBudget: 'structureclaw-calls' });
  });
  test('history and persistent memory are independent; disabling memory also removes its tool', () => {
    const value = policy({ context: { memoryScopes: [], history: 'full' } });
    expect(value.context.history).toBe('full');
    expect(value.activeToolIds).not.toContain('memory');
    const restricted = policy({ context: { memoryScopes: ['conversation', 'workspace'] } }, { allowedMemoryScopes: ['conversation'] });
    expect(restricted.context.memoryScopes).toEqual(['conversation']);
    expect(restricted.fieldSources['context.memoryScopes']).toBe('server-limit');
    const context = createRunContext(restricted);
    expect(() => { context.policy.context.memoryScopes.push('workspace'); }).toThrow();
  });
  test('internal and tool-level corrections share two extra recoveries', () => {
    const context = createRunContext(policy());
    withRunContext(context, () => {
      reserveToolCall('build_model', 'first');
      requestRecovery('invalid internal model');
      recordToolOutcome('build_model', 'first', 'invalid revised candidate');
      reserveToolCall('edit_model', 'second');
      expect(context.usage.recoveries).toBe(2);
      recordToolOutcome('edit_model', 'second', 'wrong connection');
      expect(() => reserveToolCall('build_model', 'third')).toThrow('RECOVERY_BUDGET_EXHAUSTED');
      expect(() => reserveToolCall('run_analysis', 'bypass')).toThrow('UNRESOLVED_MODEL_FAILURE');
      reserveToolCall('query_results', 'read');
    });
  });
  test('recovery disabled still permits the complete successful engineering chain', () => {
    const context = createRunContext(policy({ repair: { enabled: false } }));
    withRunContext(context, () => {
      for (const name of ['build_model', 'run_analysis', 'query_results', 'edit_model', 'generate_report']) {
        reserveToolCall(name, name); recordToolOutcome(name, name);
      }
      expect(context.usage.toolCalls).toBe(5);
      expect(() => requestRecovery('failed model')).toThrow('RECOVERY_BUDGET_EXHAUSTED');
    });
  });
  test.each(['run_analysis', 'query_results'])('repair off rejects all engineering mutations after %s fails, without spending new reservations', failed => {
    const mutations = ['detect_structure_type', 'extract_draft_params', 'build_model', 'validate_model', 'edit_model', 'undo_model',
      'review_input', 'set_session_config', 'run_analysis', 'run_code_check'];
    const permitted = [...new Set([...available.availableToolIds, ...mutations, 'query_model'])];
    const value = resolveRunPolicy({ ...available, availableToolIds: permitted, defaultToolIds: permitted,
      requested: { repair: { enabled: false } } });
    const context = createRunContext(value);
    withRunContext(context, () => {
      reserveToolCall(failed, 'initial-failure');
      recordToolOutcome(failed, 'initial-failure', 'invalid request');
      for (const name of mutations) expect(() => reserveToolCall(name, `blocked-${name}`)).toThrow('RECOVERY_BUDGET_EXHAUSTED');
      expect(context.usage.toolCalls).toBe(1);
      expect(context.usage.startedToolCallIds).toEqual(['initial-failure']);
      expect(context.usage.recoveries).toBe(0);
      reserveToolCall('query_model', 'inspect');
      recordToolOutcome('query_model', 'inspect');
      reserveToolCall('ask_user_clarification', 'ask');
      expect(context.usage.toolCalls).toBe(3);
      expect(context.usage.pendingFailures[failed]).toBe('invalid request');
    });
  });
  test('resume takes the durable reservation over an older checkpoint and cannot reset counters or reissue a job', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-policy-'));
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('unsafe test cleanup');
    try {
      const value = policy();
      const context = createRunContext(value, { journalDir: directory });
      const stale = snapshotRunUsage(context);
      withRunContext(context, () => { reserveToolCall('run_analysis', 'native-job'); requestRecovery('internal'); reserveLlmCall('test'); });
      const resumed = createRunContext(value, { runId: context.usage.runId, usage: stale, journalDir: directory, resume: true });
      expect(resumed.usage).toMatchObject({ toolCalls: 1, recoveries: 1, llmCalls: 1 });
      expect(() => withRunContext(resumed, () => reserveToolCall('run_analysis', 'native-job'))).toThrow('TOOL_OUTCOME_UNKNOWN');
      expect(() => createRunContext(policy({ builder: 'llm' }), { runId: context.usage.runId, usage: stale, journalDir: directory, resume: true })).toThrow('RUN_POLICY_RESUME_CONFLICT');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  test('concurrent contexts count independent internal calls and enforce configured limits', async () => {
    const contexts = [createRunContext(policy({ budgets: { maxLlmCallsPerTurn: 1 } })), createRunContext(policy({ repair: { enabled: false } }))];
    await Promise.all(contexts.map(context => withRunContext(context, async () => { await Promise.resolve(); reserveLlmCall('test'); })));
    expect(contexts.map(item => item.usage.llmCalls)).toEqual([1, 1]);
    expect(() => withRunContext(contexts[0], () => reserveLlmCall('extra'))).toThrow('LLM_CALL_BUDGET_EXHAUSTED');
  });
});
