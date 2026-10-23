import { describe, expect, test } from '@jest/globals';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AgentStateAnnotation } from '../../../dist/agent-langgraph/state.js';
import { executeToolsSequentially, pendingToolCalls } from '../../../dist/agent-langgraph/sequential-tools.js';
import { createBuildModelTool } from '../../../dist/agent-langgraph/tools/build-model.js';
import { tryBuildGenericModelWithLlm } from '../../../dist/agent-skills/structure-type/generic/llm-model-builder.js';
import { createRunContext, withRunContext } from '../../../dist/runtime/run-context.js';
import { resolveRunPolicy } from '../../../dist/runtime/run-policy.js';
import { genericFixtures } from '../../../tests/characterization/fixtures/generic-physics.mjs';

describe.each(['operation', 'physics'])('exhausted %s build is terminal', kind => {
  test('the failed receipt checkpoints once, retains artifacts and blocks queued extraction, building and analysis', async () => {
    let builds = 0, providerCalls = 0, subsequentCalls = 0;
    const candidate = kind === 'operation' ? { coordinate_system: { dimension: '2d' }, operations: [
      { id: 'invalid', op: 'nodal-load', selector: { ids: ['missing'] }, caseId: 'DL', vector: [0, 0, -10] },
    ] } : structuredClone(genericFixtures[0].model);
    const llm = { invoke: async () => { providerCalls++; return { content: JSON.stringify(candidate) }; } };
    const build = createBuildModelTool({ buildModel: async draft => {
      builds++;
      return tryBuildGenericModelWithLlm(llm, 'Apply every confirmed load.', draft, 'en');
    } });
    const forbidden = ['extract_draft_params', 'run_analysis'].map(name => tool(async () => { subsequentCalls++; return '{}'; },
      { name, description: 'Must not execute', schema: z.object({}) }));
    const graph = new StateGraph(AgentStateAnnotation)
      .addNode('tools', (state, config) => executeToolsSequentially([build, ...forbidden], state, config))
      .addEdge(START, 'tools')
      .addConditionalEdges('tools', state => pendingToolCalls(state).length ? 'tools' : END, ['tools', END])
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: randomUUID() } };
    const saved = { model: { retained: true }, modelRevision: 7, modelPending: false,
      analysisResult: { runId: 'retained-analysis' }, report: { markdown: 'Retained report' },
      draftState: { inferredType: 'unknown', skillId: 'generic', updatedAt: 1,
        engineeringDraft: { loads: [{ id: 'P', kind: 'nodal', magnitude: 10, unit: 'kN', direction: 'gravity', target: 'unresolved' }] } } };
    const before = structuredClone(saved);
    const run = createRunContext(resolveRunPolicy({ availableSkillIds: ['generic'], structureTypeSkillIds: ['generic'],
      availableToolIds: ['build_model', 'extract_draft_params', 'run_analysis'],
      defaultToolIds: ['build_model', 'extract_draft_params', 'run_analysis'],
      requested: { repair: { enabled: true, maxRecoveriesPerTurn: 2 } } }));
    await expect(withRunContext(run, () => graph.invoke({ ...saved, messages: [
      new HumanMessage('Keep the confirmed frame and loads, then build and analyze.'), new AIMessage({ content: '', tool_calls: [
        { id: 'first-build', name: 'build_model', args: {} },
        { id: 'rewrite', name: 'extract_draft_params', args: {} },
        { id: 'repeat-build', name: 'build_model', args: {} },
        { id: 'analyze', name: 'run_analysis', args: {} },
      ] }),
    ] }, config))).rejects.toThrow(kind === 'operation' ? 'OPERATION_SELECTOR_UNRESOLVED' : 'MODEL_PHYSICS_INVALID');
    expect(builds).toBe(1);
    expect(providerCalls).toBe(3);
    expect(run.usage.recoveries).toBe(2);
    expect(subsequentCalls).toBe(0);
    const state = (await graph.getState(config)).values;
    for (const [key, value] of Object.entries(saved)) expect(state[key]).toEqual(value);
    expect(saved).toEqual(before);
    const receipts = state.messages.filter(message => message.getType() === 'tool');
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0].content)).toMatchObject({ success: false, modelBuilt: false, terminal: true, nextAction: 'explain_failure' });
  });
});
