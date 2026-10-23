import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AIMessage } from '@langchain/core/messages';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const previousDirectory = process.env.SCLAW_DATA_DIR;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-invalid-load-direction-'));
process.env.SCLAW_DATA_DIR = directory;

const outerPrompts = [], extractionPrompts = [];
let responses = [];
// Keep the real extractor, generic handler, draft validation and graph guards. Only
// provider calls are scripted: a valid user direction becomes an invalid LLM enum.
const invalidPatch = { engineeringDraft: {
  geometry: { storyHeightsM: [9, 9, 9] },
  loads: [{ id: 'P1', kind: 'nodal', magnitude: 5, unit: 'kN', direction: 'not-a-direction', target: 'N3_0' }],
} };
const llm = await import('../../../dist/utils/llm.js');
jest.unstable_mockModule('../../../dist/utils/llm.js', () => ({ ...llm,
  createChatModel: () => ({
    invoke: async prompt => {
      extractionPrompts.push(prompt);
      return { content: JSON.stringify(invalidPatch), response_metadata: { finish_reason: 'stop' } };
    },
    bindTools: () => ({ invoke: async messages => {
      outerPrompts.push(messages);
      return responses.shift() ?? new AIMessage('Unexpected outer continuation');
    } }),
  }),
}));

const { LangGraphAgentService } = await import('../../../dist/agent-langgraph/agent-service.js');
const { handler } = await import('../../../dist/agent-skills/structure-type/generic/handler.js');
const manifest = { id: 'generic', domain: 'structure-type', structureType: 'unknown', stages: ['draft', 'model'],
  name: { en: 'Generic', zh: '通用' }, description: { en: 'General structural modelling', zh: '通用结构建模' } };
const plugin = { ...manifest, handler, markdownByStage: {
  draft: fs.readFileSync(new URL('../../agent-skills/structure-type/generic/draft.md', import.meta.url), 'utf8'),
} };
const buildModel = jest.fn();
const detectStructuralTypeWithLlm = jest.fn();
const skillRuntime = { listSkillManifests: async () => [manifest], resolvePluginForType: async () => plugin,
  buildModel, detectStructuralTypeWithLlm };

const nodes = Array.from({ length: 4 }, (_, story) => [0, 1].map(x => ({ id: `N${story}_${x}`, x: x * 6, y: 0, z: story * 3 }))).flat();
const elements = [1, 2, 3].flatMap(story => [
  ...[0, 1].map(x => ({ id: `C${story}_${x}`, type: 'beam', nodes: [`N${story - 1}_${x}`, `N${story}_${x}`], material: 'M1', section: 'S1' })),
  { id: `B${story}`, type: 'beam', nodes: [`N${story}_0`, `N${story}_1`], material: 'M1', section: 'S1' },
]);
const model = { schema_version: '2.2.0', unit_system: 'SI', nodes, elements,
  materials: [{ id: 'M1', E: 206000000, nu: 0.3 }], sections: [{ id: 'S1', A: 0.01, Iy: 0.0001, Iz: 0.0001, J: 0.0001 }],
  supports: [0, 1].map(x => ({ node: `N0_${x}`, restraints: [true, true, true, true, true, true] })),
  load_cases: [{ id: 'L1', loads: [{ type: 'nodal', node: 'N3_0', fz: -1 }] }] };
const retained = {
  draftState: { inferredType: 'unknown', structuralTypeKey: 'unknown', skillId: 'generic', supportLevel: 'supported',
    routingSource: 'scope-selected', updatedAt: 1, engineeringDraft: { structureType: 'frame',
      geometry: { storyHeightsM: [3, 3, 3], bayWidthsM: [6] },
      loads: [{ id: 'P1', kind: 'nodal', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'N3_0' }], model } },
  model, modelRevision: 3, modelPending: false,
  analysisResult: { runId: 'accepted-old-result', success: true, results: { maxDisplacement: 0.001 } },
  codeCheckResult: { completionStatus: 'complete', runId: 'accepted-old-result' },
  report: { markdown: 'Accepted report for the earlier 1 kN load.' },
};

beforeEach(() => {
  outerPrompts.length = 0; extractionPrompts.length = 0; responses = [];
  buildModel.mockReset(); detectStructuralTypeWithLlm.mockReset();
});
afterAll(() => {
  if (previousDirectory === undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR = previousDirectory;
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test cleanup');
  fs.rmSync(directory, { recursive: true, force: true });
});

describe.each(['already queued', 'next outer response'])('invalid load extraction is terminal: %s', scheduling => {
  test('bounded real validation preserves accepted state and blocks rewrites, building and analysis', async () => {
    const conversationId = randomUUID(), service = new LangGraphAgentService(skillRuntime);
    const graph = await service.getGraph(), config = { configurable: { thread_id: conversationId } };
    const snapshot = structuredClone(retained);
    await graph.updateState(config, snapshot, 'agent');
    const forbidden = [
      { id: 'rewrite-extraction', name: 'extract_draft_params', args: { message: 'Use direction gravity and try a different wording.' } },
      { id: 'unsafe-build', name: 'build_model', args: {} },
      { id: 'unsafe-analysis', name: 'run_analysis', args: {} },
    ];
    responses = [new AIMessage({ content: '', tool_calls: [
      { id: 'invalid-extraction', name: 'extract_draft_params', args: { message: 'ASSISTANT_RESTATEMENT_SHOULD_NOT_REPLACE_USER_EVIDENCE' } },
      ...(scheduling === 'already queued' ? forbidden : []),
    ] }), new AIMessage({ content: '', tool_calls: forbidden }), new AIMessage('The new analysis succeeded.')];
    const message = '保留三层框架原有几何，将N3_0节点集中荷载改为5kN，方向竖直向下，然后重新分析。';
    await expect(service.runFull({ conversationId, message, context: { locale: 'zh', runPolicy: {
      skillIds: ['generic'], repair: { enabled: true, maxRecoveriesPerTurn: 2 },
      tools: { enabledIds: ['extract_draft_params', 'build_model', 'run_analysis'] },
    } } })).rejects.toThrow('LLM_PARAM_EXTRACTOR_INVALID_OUTPUT');

    expect(extractionPrompts).toHaveLength(3);
    for (const prompt of extractionPrompts) {
      expect(prompt).toContain(message);
      expect(prompt).not.toContain('ASSISTANT_RESTATEMENT_SHOULD_NOT_REPLACE_USER_EVIDENCE');
    }
    for (const prompt of extractionPrompts.slice(1)) {
      expect(prompt).toContain('Rejected patch feedback');
      expect(prompt).toContain('LOAD_DIRECTION_INVALID');
    }
    expect(outerPrompts).toHaveLength(1);
    expect(buildModel).not.toHaveBeenCalled();
    expect(detectStructuralTypeWithLlm).not.toHaveBeenCalled();

    const state = (await graph.getState(config)).values;
    for (const [key, value] of Object.entries(snapshot)) expect(state[key]).toEqual(value);
    expect(retained).toEqual(snapshot);
    expect(state.selectedSkillIds).toEqual(['generic']);
    const toolMessages = state.messages.filter(item => item.getType() === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].tool_call_id).toBe('invalid-extraction');
    const failure = JSON.parse(toolMessages[0].content);
    expect(failure).toMatchObject({ success: false, errorCode: 'LLM_PARAM_EXTRACTOR_INVALID_OUTPUT',
      canProceed: false, nextAction: 'report_internal_error' });
    expect(failure.message).toContain('LOAD_DIRECTION_INVALID');
    expect(state.runUsage).toMatchObject({ toolCalls: 1, recoveries: 2 });
    const events = state.runUsage.events;
    expect(events.filter(event => event.kind === 'tool_started').map(event => event.name)).toEqual(['extract_draft_params']);
    expect(events.filter(event => event.kind === 'param_extractor').map(event => [event.attempt, event.outcome]))
      .toEqual([[1, 'invalid_patch'], [2, 'invalid_patch'], [3, 'invalid_patch']]);
    expect(events.some(event => event.kind === 'guard' && event.guard === 'no-progress')).toBe(false);
    expect(state.messages.some(item => String(item.content).includes('The new analysis succeeded.'))).toBe(false);
  });
});
