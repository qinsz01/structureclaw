import { describe, expect, test } from '@jest/globals';
import { invokeParamExtractor } from '../../../dist/agent-langgraph/param-extractor.js';
import { handler } from '../../../dist/agent-skills/structure-type/generic/handler.js';
import { EngineeringValidationError } from '../../../dist/engineering/validation-error.js';
import { createRunContext, withRunContext } from '../../../dist/runtime/run-context.js';
import { resolveRunPolicy } from '../../../dist/runtime/run-policy.js';

const plugin = {
  id: 'generic', name: { en: 'Generic', zh: '通用' },
  description: { en: 'Generic engineering draft', zh: '通用工程草稿' },
  stages: ['draft'], structureType: 'unknown', markdownByStage: { draft: 'Preserve supplied engineering values.' },
};
const logger = { info() {}, debug() {}, warn() {} };
const acceptedState = () => ({
  inferredType: 'frame', skillId: 'generic', updatedAt: 1,
  engineeringDraft: {
    geometry: { bayWidthsM: [6, 7.5, 6, 7.5], storyHeightsM: [4.2, 3.6, 3.6] },
    material: { family: 'concrete', grade: 'C30' },
    loads: [{ id: 'DL1', kind: 'line', magnitude: 27, unit: 'kN/m', direction: 'gravity', target: 'beam', location: { story: 1 } }],
  },
});
const patchWithLoad = changes => ({ engineeringDraft: { loads: [{
  id: 'DL1', kind: 'line', magnitude: 30, unit: 'kN/m', direction: 'gravity', target: 'beam', location: { story: 1 }, ...changes,
}] } });
const invalidDirection = () => patchWithLoad({ direction: '竖直向下' });
const acceptedPatch = () => patchWithLoad({ direction: 'gravity' });
const validateWithHandler = state => candidate => {
  const extracted = handler.extractDraft({ currentState: state, llmDraftPatch: candidate });
  handler.mergeState(state, extracted);
};
const extractorInput = (state, llm, extra = {}) => ({
  locale: 'zh', plugin, existingState: state, message: '确认以上参数，荷载均竖直向下。',
  traceLogger: logger, validatePatch: validateWithHandler(state), llm, ...extra,
});

describe('typed engineering validation in parameter extraction', () => {
  test('the real handler identifies the rejected direction field and value without changing accepted inputs', () => {
    const state = acceptedState(), before = structuredClone(state);
    let failure;
    try { validateWithHandler(state)(invalidDirection()); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(EngineeringValidationError);
    expect(failure.message).toContain('LOAD_DIRECTION_INVALID: engineeringDraft.loads[0].direction="竖直向下"');
    expect(failure.message).toContain('gravity or globalX/globalY/globalZ');
    expect(state).toEqual(before);
  });

  test.each(['zh', 'en'])('repairs a direction rejected by the real handler with bounded feedback (%s)', async locale => {
    const state = acceptedState(), before = structuredClone(state), prompts = [];
    const result = await invokeParamExtractor(extractorInput(state, { invoke: async prompt => {
      prompts.push(prompt);
      return { content: JSON.stringify(prompts.length === 1 ? invalidDirection() : acceptedPatch()) };
    } }, { locale }));
    expect(result).toEqual(acceptedPatch());
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('LOAD_DIRECTION_INVALID');
    expect(prompts[1]).toContain('engineeringDraft.loads[0].direction="竖直向下"');
    expect(prompts[1]).toContain('Rejected patch feedback');
    expect(state).toEqual(before);
  });

  test('three invalid responses end as invalid model output and preserve the accepted draft', async () => {
    const state = acceptedState(), before = structuredClone(state), prompts = [];
    let failure;
    try {
      await invokeParamExtractor(extractorInput(state, { invoke: async prompt => {
        prompts.push(prompt);
        return { content: JSON.stringify(invalidDirection()) };
      } }));
    } catch (error) { failure = error; }
    expect(failure.message).toMatch(/^LLM_PARAM_EXTRACTOR_INVALID_OUTPUT:/);
    expect(failure.message).toContain('LOAD_DIRECTION_INVALID');
    expect(failure.message).toContain('engineeringDraft.loads[0].direction="竖直向下"');
    expect(prompts).toHaveLength(3);
    expect(prompts.slice(1).every(prompt => prompt.includes('LOAD_DIRECTION_INVALID'))).toBe(true);
    expect(state).toEqual(before);
  });

  test.each([0, 1, 2])('typed validation obeys the shared repair budget of %i', async repairs => {
    const state = acceptedState(), before = structuredClone(state);
    const run = createRunContext(resolveRunPolicy({
      availableSkillIds: ['generic'], structureTypeSkillIds: ['generic'], availableToolIds: [],
      requested: { repair: { enabled: repairs > 0, maxRecoveriesPerTurn: repairs } },
    }));
    let calls = 0;
    await expect(withRunContext(run, () => invokeParamExtractor(extractorInput(state, { invoke: async () => {
      calls++;
      return { content: JSON.stringify(invalidDirection()) };
    } })))).rejects.toThrow(repairs === 2 ? 'LLM_PARAM_EXTRACTOR_INVALID_OUTPUT' : 'RECOVERY_BUDGET_EXHAUSTED');
    expect(calls).toBe(repairs + 1);
    expect(run.usage.recoveries).toBe(repairs);
    expect(state).toEqual(before);
  });

  test.each([
    ['LOAD_UNIT_REQUIRED', () => patchWithLoad({ unit: 'tons' })],
    ['INVALID_EXPLICIT_TOPOLOGY', () => ({ engineeringDraft: { topology: { nodes: [{ id: 'N1', x: 0, y: 0 }] } } })],
    ['INVALID_ENGINEERING_LOAD', () => patchWithLoad({ magnitude: 'not a number' })],
    ['INVALID_ANALYSIS_CONTROL', () => ({ engineeringDraft: { analysisControl: 'static' } })],
    ['INVALID_COORDINATE_SYSTEM', () => ({ engineeringDraft: { coordinateSystem: '2d' } })],
  ])('other real engineering validation errors also receive corrective feedback: %s', async (code, invalid) => {
    const state = acceptedState(), before = structuredClone(state), prompts = [];
    const result = await invokeParamExtractor(extractorInput(state, { invoke: async prompt => {
      prompts.push(prompt);
      return { content: JSON.stringify(prompts.length === 1 ? invalid() : acceptedPatch()) };
    } }));
    expect(result).toEqual(acceptedPatch());
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(code);
    expect(state).toEqual(before);
  });

  test.each([
    () => new Error('schema worker unavailable'),
    () => new TypeError('cannot read properties of undefined'),
    () => new Error('LOAD_DIRECTION_INVALID: untyped unexpected failure'),
  ])('untyped infrastructure or programming validation failures escape without a retry (%#)', async makeFailure => {
    const state = acceptedState(), before = structuredClone(state), failure = makeFailure();
    let calls = 0;
    await expect(invokeParamExtractor(extractorInput(state, { invoke: async () => {
      calls++;
      return { content: JSON.stringify(acceptedPatch()) };
    } }, { validatePatch: () => { throw failure; } }))).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(state).toEqual(before);
  });

  test('an upstream LLM error is reported once as infrastructure failure, not repaired as invalid input', async () => {
    const state = acceptedState(), before = structuredClone(state), failure = new Error('429 rate limit');
    let calls = 0;
    await expect(invokeParamExtractor(extractorInput(state, { invoke: async () => {
      calls++;
      throw failure;
    } }))).rejects.toMatchObject({ message: expect.stringContaining('LLM_PARAM_EXTRACTOR_INFRASTRUCTURE_ERROR'), cause: failure });
    expect(calls).toBe(1);
    expect(state).toEqual(before);
  });
});
