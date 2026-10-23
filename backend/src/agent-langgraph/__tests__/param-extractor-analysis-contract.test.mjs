import { describe, expect, test } from '@jest/globals';
import { invokeParamExtractor } from '../../../dist/agent-langgraph/param-extractor.js';
import { handler } from '../../../dist/agent-skills/structure-type/generic/handler.js';
import { normalizeEngineeringDraft } from '../../../dist/agent-runtime/engineering-draft.js';
import { EngineeringValidationError } from '../../../dist/engineering/validation-error.js';
import { draftContract } from '../../../dist/engineering/draft-contract.js';

const plugin = { id: 'generic', name: { en: 'Generic', zh: '通用' }, description: {},
  stages: ['draft'], structureType: 'unknown', markdownByStage: {} };
const logger = { info() {}, debug() {}, warn() {} };
const originalState = () => ({ inferredType: 'frame', skillId: 'generic', updatedAt: 1,
  engineeringDraft: { geometry: { bayWidthsM: [6, 7.5] }, analysis: {
    type: 'static', engineTarget: 'pkpm', loadCombinations: [{ id: 'C1', factors: { DL: 1 } }],
  } } });
const patch = analysis => ({ engineeringDraft: { analysis } });
const validAnalysis = () => ({ type: 'static', engineTarget: 'pkpm', loadCombinations: [{ id: 'C1', factors: { DL: 1.3, LL: 1.5 } }] });
const validate = state => candidate => handler.mergeState(state, handler.extractDraft({ currentState: state, llmDraftPatch: candidate }));

describe('analysis and load-combination extraction boundary', () => {
  test.each([
    ['INVALID_ANALYSIS', 'static'],
    ['INVALID_ANALYSIS_TYPE', { type: 'frame' }],
    ['INVALID_ANALYSIS_ENGINE', { engineTarget: 'unknown-engine' }],
    ['INVALID_LOAD_COMBINATION', { loadCombinations: '1.3DL+1.5LL' }],
    ['INVALID_LOAD_COMBINATION', { loadCombinations: ['1.3DL+1.5LL'] }],
    ['INVALID_LOAD_COMBINATION', { loadCombinations: [{ id: 'valid', factors: { DL: 1.3 } }, '1.5LL'] }],
    ['INVALID_LOAD_COMBINATION', { loadCombinations: [{ id: 'C1', factors: {} }] }],
    ['INVALID_LOAD_COMBINATION', { loadCombinations: [{ id: 'C1', factors: { DL: 1.3, LL: 'invalid' } }] }],
    ['INVALID_LOAD_COMBINATION', { loadCombinations: [{ id: 'C1', factors: { ' ': 1 } }] }],
    ['INVALID_LOAD_COMBINATION', { loadCombinations: [{ id: 'C1', factors: { DL: 1, ' DL ': 2 } }] }],
  ])('rejects the whole candidate instead of dropping invalid analysis input: %s (%#)', (code, analysis) => {
    const state = originalState(), before = structuredClone(state);
    let failure;
    try { validate(state)(patch(analysis)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(EngineeringValidationError);
    expect(failure.message).toMatch(new RegExp(`^${code}:`));
    expect(failure.message).toContain('engineeringDraft.analysis');
    expect(state).toEqual(before);
  });

  test('the real handler repairs both errors in the live-shaped output within three attempts', async () => {
    const state = originalState(), before = structuredClone(state), prompts = [];
    const outputs = [
      patch({ type: 'frame', engineTarget: 'pkpm', loadCombinations: ['1.3DL+1.5LL'] }),
      patch({ type: 'static', engineTarget: 'pkpm', loadCombinations: ['1.3DL+1.5LL'] }),
      patch(validAnalysis()),
    ];
    const result = await invokeParamExtractor({ locale: 'zh', plugin, existingState: state,
      message: '按方案进行静力分析，组合1.3DL+1.5LL。', traceLogger: logger, validatePatch: validate(state),
      llm: { invoke: async prompt => { prompts.push(prompt); return { content: JSON.stringify(outputs[prompts.length - 1]) }; } },
    });
    expect(result).toEqual(patch(validAnalysis()));
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('INVALID_ANALYSIS_TYPE');
    expect(prompts[2]).toContain('INVALID_LOAD_COMBINATION');
    expect(prompts[2]).toContain('loadCombinations[0]');
    expect(state).toEqual(before);
  });

  test('persistent string combinations end as invalid model output without replacing confirmed combinations', async () => {
    const state = originalState(), before = structuredClone(state);
    let calls = 0;
    await expect(invokeParamExtractor({ locale: 'en', plugin, existingState: state,
      message: 'Use combination 1.3DL+1.5LL.', traceLogger: logger, validatePatch: validate(state),
      llm: { invoke: async () => { calls++; return { content: JSON.stringify(patch({ loadCombinations: ['1.3DL+1.5LL'] })) }; } },
    })).rejects.toThrow(/^LLM_PARAM_EXTRACTOR_INVALID_OUTPUT:.*INVALID_LOAD_COMBINATION/);
    expect(calls).toBe(3);
    expect(state).toEqual(before);
  });

  test('preserves signed and zero factors; empty arrays remain explicit clearing and omission preserves accepted combinations', () => {
    const combinations = [{ id: 'C1', factors: { DL: 1.3, LL: 0, WX: -1.5 } }];
    expect(normalizeEngineeringDraft({ analysis: { loadCombinations: combinations } }).analysis.loadCombinations).toEqual(combinations);
    const state = originalState();
    expect(validate(state)(patch({})).engineeringDraft.analysis).toEqual(state.engineeringDraft.analysis);
    expect(validate(state)(patch({ loadCombinations: [] })).engineeringDraft.analysis.loadCombinations).toEqual([]);
  });

  test.each(['zh', 'en'])('focused prompts expose valid analysis enums and structured combination factors (%s)', async locale => {
    let prompt;
    await invokeParamExtractor({ locale, plugin, existingState: originalState(), message: 'Confirm the combination.', traceLogger: logger,
      llm: { invoke: async value => { prompt = value; return { content: '{}' }; } },
    });
    const fields = draftContract.properties.analysis.properties;
    expect(prompt).toContain(`analysis:{type:${fields.type.enum.join('|')},engineTarget:${fields.engineTarget.enum.join('|')}`);
    expect(prompt).toContain('loadCombinations:[{id:string,factors:{loadCaseId:number}}]');
    expect(prompt).toContain('PATCH ONLY');
    expect(prompt.length).toBeLessThan(10000);
  });
});
