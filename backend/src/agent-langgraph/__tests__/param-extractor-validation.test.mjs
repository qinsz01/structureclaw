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
  test.each(['direct', 'wrapped'])('rejects misplaced canonical fields before accepting a %s patch', async style => {
    const state = acceptedState(), before = structuredClone(state), prompts = [], validated = [];
    const corrected = acceptedPatch();
    const misplaced = { engineeringDraft: { geometry: { lengthM: 8 } }, loads: corrected.engineeringDraft.loads,
      loadCases: [{ id: 'D', type: 'dead', loads: [] }], analysis: { type: 'static', engineTarget: 'pkpm' },
      analysisControl: { self_weight: false } };
    const result = await invokeParamExtractor(extractorInput(state, { invoke: async prompt => {
      prompts.push(prompt);
      return { content: JSON.stringify(prompts.length === 1
        ? style === 'wrapped' ? { draftPatch: { engineeringDraft: misplaced.engineeringDraft },
          ...Object.fromEntries(Object.entries(misplaced).filter(([key]) => key !== 'engineeringDraft')) } : misplaced
        : corrected) };
    } }, { validatePatch: candidate => { validated.push(candidate); validateWithHandler(state)(candidate); } }));
    expect(result).toEqual(corrected);
    expect(validated).toEqual([corrected]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('DRAFT_ENVELOPE_INVALID');
    for (const key of ['loads', 'loadCases', 'analysis', 'analysisControl']) expect(prompts[1]).toContain(`"${key}"`);
    expect(state).toEqual(before);
  });

  test('persistent misplaced fields fail explicitly without persisting an incomplete draft', async () => {
    const state = acceptedState(), before = structuredClone(state);
    let calls = 0, validations = 0;
    await expect(invokeParamExtractor(extractorInput(state, { invoke: async () => {
      calls++;
      return { content: JSON.stringify({ engineeringDraft: {}, loads: acceptedPatch().engineeringDraft.loads }) };
    } }, { validatePatch: () => { validations++; } }))).rejects.toThrow('DRAFT_ENVELOPE_INVALID');
    expect(calls).toBe(3);
    expect(validations).toBe(0);
    expect(state).toEqual(before);
  });

  test.each(['all+1', 'all+2', 'node-x0y1+2', 'made-up-role'])('repairs invalid formal frame role %s before it becomes confirmed state', async nodeRole => {
    const state = acceptedState(), before = structuredClone(state), prompts = [];
    const valid = { engineeringDraft: { loads: [{ id: 'N', kind: 'nodal', magnitude: 50, unit: 'kN',
      direction: 'gravity', location: { nodeRole: 'all', story: 1 } }] } };
    const invalid = structuredClone(valid);
    invalid.engineeringDraft.loads[0].location.nodeRole = nodeRole;
    const result = await invokeParamExtractor(extractorInput(state, { invoke: async prompt => {
      prompts.push(prompt);
      return { content: JSON.stringify(prompts.length === 1 ? invalid : valid) };
    } }));
    expect(result).toEqual(valid);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('LOAD_NODE_ROLE_INVALID');
    expect(prompts[1]).toContain(JSON.stringify(nodeRole));
    expect(prompts[1]).toContain('{"nodeRole":"all","story":1}');
    expect(state).toEqual(before);
  });

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

  test.each([false, true])('a later repair retains earlier field diagnostics without extra attempts (patchMode=%s)', async patchMode => {
    const state = acceptedState(), before = structuredClone(state), prompts = [];
    const result = await invokeParamExtractor(extractorInput(state, { invoke: async prompt => {
      prompts.push(prompt);
      if (prompts.length === 1) return { content: JSON.stringify(patchWithLoad({ unit: 'tons' })) };
      if (prompts.length === 2) return { content: JSON.stringify(invalidDirection()) };
      // Reproduces alternating invalid representations if the earlier
      // diagnostic is lost, while all engineering facts remain unchanged.
      return { content: JSON.stringify(prompt.includes('LOAD_UNIT_REQUIRED') && prompt.includes('LOAD_DIRECTION_INVALID')
        ? acceptedPatch() : patchWithLoad({ unit: 'tons' })) };
    } }, { patchMode }));
    expect(result).toEqual(acceptedPatch());
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('LOAD_UNIT_REQUIRED');
    expect(prompts[2]).toContain('LOAD_DIRECTION_INVALID');
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
