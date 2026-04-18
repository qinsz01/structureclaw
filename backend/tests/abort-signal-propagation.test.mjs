import { describe, expect, test } from '@jest/globals';
import { renderSummary } from '../dist/services/agent-result.js';
import { tryRepairModel } from '../dist/services/agent-validation.js';
import { AgentSkillExecutor } from '../dist/agent-runtime/executor.js';
import { tryBuildGenericModelWithLlm } from '../dist/agent-skills/structure-type/generic/llm-model-builder.js';

describe('abort signal propagation for LLM calls', () => {
  test('renderSummary forwards AbortSignal to llm.invoke', async () => {
    const controller = new AbortController();
    const calls = [];
    const llm = {
      invoke: async (_prompt, options) => {
        calls.push(options);
        return { content: 'ok' };
      },
    };

    await renderSummary(llm, '总结结果', 'fallback', 'zh', { summary: {} }, undefined, controller.signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  test('tryRepairModel forwards AbortSignal to llm.invoke', async () => {
    const controller = new AbortController();
    const calls = [];
    const llm = {
      invoke: async (_prompt, options) => {
        calls.push(options);
        return { content: '{"schema_version":"1.0.0"}' };
      },
    };

    await tryRepairModel(llm, { schema_version: '1.0.0' }, 'bad model', 'zh', controller.signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  test('AgentSkillExecutor forwards AbortSignal to llm.invoke', async () => {
    const controller = new AbortController();
    const calls = [];
    const llm = {
      invoke: async (_prompt, options) => {
        calls.push(options);
        return {
          content: JSON.stringify({
            inferredType: 'beam',
            draftPatch: {
              inferredType: 'beam',
              lengthM: 10,
              supportType: 'simply-supported',
              loadKN: 1,
              loadType: 'point',
              loadPosition: 'midspan',
            },
          }),
        };
      },
    };

    const executor = new AgentSkillExecutor(llm);
    await executor.execute({
      message: '设计一个简支梁，跨度10m，梁中间荷载1kN',
      locale: 'zh',
      existingState: undefined,
      selectedSkill: {
        id: 'beam',
        name: { zh: '梁', en: 'Beam' },
        description: { zh: '梁', en: 'Beam' },
        triggers: ['beam'],
        markdownByStage: { draft: 'beam draft' },
      },
      signal: controller.signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  test('tryBuildGenericModelWithLlm forwards AbortSignal to llm.invoke', async () => {
    const controller = new AbortController();
    const calls = [];
    const llm = {
      invoke: async (_prompt, options) => {
        calls.push(options);
        return {
          content: JSON.stringify({
            schema_version: '1.0.0',
            unit_system: 'SI',
            nodes: [
              { id: 'N1', x: 0, y: 0, z: 0 },
              { id: 'N2', x: 10, y: 0, z: 0 },
            ],
            elements: [
              { id: 'E1', type: 'beam', nodes: ['N1', 'N2'] },
            ],
            materials: [],
            sections: [],
            load_cases: [{ id: 'LC1', loads: [] }],
            load_combinations: [{ id: 'ULS', factors: { LC1: 1.0 } }],
          }),
        };
      },
    };

    await tryBuildGenericModelWithLlm(
      llm,
      '设计一个简支梁，跨度10m，梁中间荷载1kN',
      {
        inferredType: 'beam',
        skillId: 'generic',
        structuralTypeKey: 'beam',
        updatedAt: Date.now(),
      },
      'zh',
      undefined,
      controller.signal,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBe(controller.signal);
  });
});
