import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AIMessage } from '@langchain/core/messages';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const previousDirectory = process.env.SCLAW_DATA_DIR;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-terminal-semantic-'));
process.env.SCLAW_DATA_DIR = directory;
const imagePath = path.join(directory, 'drawing.png');
fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5mQAAAAASUVORK5CYII=', 'base64'));
const prompts = [];
let responses = [], errorCode;
const extract = jest.fn();
const llm = await import('../../../dist/utils/llm.js');
jest.unstable_mockModule('../../../dist/utils/llm.js', () => ({ ...llm,
  createChatModel: () => ({ bindTools: () => ({ invoke: async messages => {
    prompts.push(messages); return responses.shift() ?? new AIMessage('Unexpected continuation');
  } }) }),
  createVisionChatModel: () => errorCode === 'VISION_MODEL_REQUIRED' ? null : ({ invoke: async () => { throw new Error('provider unavailable'); } }),
}));
jest.unstable_mockModule('../../../dist/agent-langgraph/param-extractor.js', () => ({ invokeParamExtractor: extract }));
const { LangGraphAgentService } = await import('../../../dist/agent-langgraph/agent-service.js');
const { handler } = await import('../../../dist/agent-skills/structure-type/generic/handler.js');
const manifest = { id: 'generic', domain: 'structure-type', structureType: 'unknown', stages: ['draft', 'model'],
  name: { en: 'Generic', zh: '通用' }, description: { en: 'General structural modelling', zh: '通用结构建模' } };
const plugin = { ...manifest, handler };
const buildModel = jest.fn();
const skillRuntime = { listSkillManifests: async () => [manifest], resolvePluginForType: async () => plugin, buildModel,
  detectStructuralTypeWithLlm: async () => {
    if (errorCode === 'STRUCTURE_TYPE_UNSUPPORTED') return { key: 'plate-slab', mappedType: 'unknown', supportLevel: 'unsupported',
      routingSource: 'llm-suggested', supportNote: 'The enabled skills cannot model this slab. / 已启用技能不支持该楼板。' };
    throw new Error(`${errorCode}: routing failed / 路由失败`);
  } };
const model = { schema_version: '2.0', nodes: [{ id: 'N1', x: 0, y: 0, z: 0 }, { id: 'N2', x: 10, y: 0, z: 0 }],
  elements: [{ id: 'B1', type: 'beam', nodes: ['N1', 'N2'], material: 'M1', section: 'S1' }],
  materials: [{ id: 'M1', E: 30000000, nu: 0.2 }], sections: [{ id: 'S1', A: 0.125, Iy: 0.0026041667, Iz: 0.0006510417, J: 0.001 }],
  supports: [{ node: 'N1', restraints: [true, true, true, false, false, false] }, { node: 'N2', restraints: [false, true, true, false, false, false] }],
  load_cases: [{ id: 'L1', loads: [{ type: 'distributed', element: 'B1', wz: -1 }] }] };
const draftState = { inferredType: 'unknown', structuralTypeKey: 'unknown', skillId: 'generic', supportLevel: 'supported',
  routingSource: 'scope-selected', updatedAt: 1, engineeringDraft: { structureType: 'beam', model } };
const retained = { draftState, model, modelRevision: 3, modelPending: false,
  analysisResult: { runId: 'old-result', success: true, results: { maxDisplacement: 42 } }, report: { markdown: 'Old report' } };
beforeEach(() => { prompts.length = 0; responses = []; buildModel.mockReset(); extract.mockReset();
  extract.mockImplementation(async () => { throw new Error(`${errorCode}: extraction failed / 提取失败`); }); });
afterAll(() => {
  if (previousDirectory === undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR = previousDirectory;
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test cleanup');
  fs.rmSync(directory, { recursive: true, force: true });
});

const cases = [
  ['extract_draft_params', 'FIELD_CONTRACT_UNRESOLVED'],
  ['detect_structure_type', 'STRUCTURE_TYPE_UNSUPPORTED'],
  ...['LLM_STRUCTURAL_ROUTER_REQUIRED', 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT', 'LLM_STRUCTURAL_ROUTER_INFRASTRUCTURE_ERROR'].map(code => ['detect_structure_type', code]),
  ...['LLM_PARAM_EXTRACTOR_CONFIGURATION_ERROR', 'LLM_PARAM_EXTRACTOR_INVALID_OUTPUT', 'LLM_PARAM_EXTRACTOR_INFRASTRUCTURE_ERROR'].map(code => ['extract_draft_params', code]),
  ...['VISION_MODEL_REQUIRED', 'VISION_MODEL_FAILED'].map(code => ['analyze_file', code]),
];

describe.each(['already queued', 'next model response'])('terminal semantic failures block dependent calls: %s', scheduling => {
  test.each(cases)('%s failure %s keeps the checkpoint and cannot reuse old successful results', async (name, code) => {
    errorCode = code;
    const conversationId = randomUUID(), service = new LangGraphAgentService(skillRuntime);
    const graph = await service.getGraph(), config = { configurable: { thread_id: conversationId } };
    await graph.updateState(config, retained, 'agent');
    const dependentCalls = [{ id: 'unsafe-build', name: 'build_model', args: {} }, { id: 'unsafe-analysis', name: 'run_analysis', args: {} }];
    responses = [new AIMessage({ content: '', tool_calls: [{ id: 'failure', name, args: name === 'analyze_file' ? { filePath: imagePath } : {} },
      ...(scheduling === 'already queued' ? dependentCalls : [])] }),
      new AIMessage({ content: '', tool_calls: dependentCalls }), new AIMessage('The revised model and analysis completed successfully.')];
    await expect(service.runFull({ conversationId, message: 'Change the beam load to 10 kN and recalculate', context: {
      locale: scheduling === 'already queued' ? 'zh' : 'en', runPolicy: { skillIds: ['generic'],
        tools: { enabledIds: [name, 'build_model', 'run_analysis'] } },
    } })).rejects.toThrow(code);
    const state = (await graph.getState(config)).values;
    for (const [key, value] of Object.entries(retained)) expect(state[key]).toEqual(value);
    expect(prompts).toHaveLength(1);
    expect(buildModel).not.toHaveBeenCalled();
    const toolMessages = state.messages.filter(message => message.getType() === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].name).toBe(name);
    expect(JSON.parse(toolMessages[0].content)).toMatchObject({ success: false, errorCode: code });
    expect(state.messages.some(message => String(message.content).includes('revised model and analysis completed'))).toBe(false);
    // The checkpointed failure belongs to this turn; a fresh user request may proceed.
    responses = [new AIMessage('The previous operation failed; the retained result is from the earlier model.')];
    const fresh = await service.runFull({ conversationId, message: 'Explain the previous failure', context: { runPolicy: { tools: { enabledIds: [] } } } });
    expect(fresh.messages.at(-1).content).toContain('previous operation failed');
  });
});
