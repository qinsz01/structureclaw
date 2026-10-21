import { describe, expect, test } from '@jest/globals';
import { createAskUserClarificationTool } from '../../../dist/agent-langgraph/tools.js';
import { resolveRunPolicy } from '../../../dist/runtime/run-policy.js';
import { createRunContext, withRunContext } from '../../../dist/runtime/run-context.js';
import { normalizeClarificationOptions } from '../../../dist/utils/clarification-options.js';

const policy = resolveRunPolicy({ availableSkillIds: [], availableToolIds: ['ask_user_clarification'],
  defaultToolIds: ['ask_user_clarification'], executionOwner: 'external', requested: { repair: { enabled: false } } });
const ask = async optionsJson => JSON.parse(await withRunContext(createRunContext(policy),
  () => createAskUserClarificationTool().invoke({ question: 'Confirm A or B / 请确认 A 或 B', optionsJson })));

describe('clarification option contract', () => {
  test.each(['["truncated', 'null', '{}', '[]', '', '[null,42,{}]', '["A"] trailing prose', '["A"],["B"]'])(
    'unrecoverable or empty options return an actionable error without interrupting (%s)', async optionsJson => {
    // No graph context: interrupt() would throw if the invalid question reached the user.
    const output = JSON.parse(await createAskUserClarificationTool().invoke({ question: 'Confirm A / 确认 A', optionsJson }));
    expect(output).toMatchObject({ success: false, errorCode: 'CLARIFICATION_OPTIONS_INVALID',
      reason: 'INVALID_OR_EMPTY_OPTIONS', nextAction: 'resend_clarification' });
    expect(output.hint).toContain('question text');
    expect(output.hint).toContain('问题正文');
    expect(output).not.toHaveProperty('type');
    expect(output).not.toHaveProperty('options');
  });

  test.each([
    ['native array', ['A', 'B']],
    ['JSON array', '["A","B"]'],
    ['extra closing brace from the live failure', '["A","B"]}'],
    ['extra brackets and trailing commas', '["A","B"]],,'],
    ['duplicate and trailing comma', '["A",,"B",]'],
    ['leading comma', '[,"A","B"]'],
    ['redundant outer brackets', '[["A","B"]]'],
    ['missing final bracket', '["A","B"'],
    ['object choices with trailing commas', '[{"label":"A",},{"text":"B",},]'],
    ['answer objects from the live provider', [{ answer: 'A', paramKey: 'material' }, { answer: 'B', paramKey: 'material' }]],
    ['stray internal closer', '["A",} "B"]'],
  ])('delivers nonempty choices after bounded repair: %s', async (_label, optionsJson) => {
    expect(await ask(optionsJson)).toMatchObject({ type: 'clarification_needed', options: ['A', 'B'] });
  });

  test('repair leaves quoted punctuation and escaped quotes intact', async () => {
    const options = ['A: ],}, commas,,', 'B: "quoted" \\ path', '尺寸 200×100×7×11.4 mm'];
    expect(normalizeClarificationOptions(JSON.stringify(options) + '},')).toEqual(options);
  });

  test('repair is bounded by punctuation edits, input length and redundant nesting', () => {
    expect(normalizeClarificationOptions('["A"]' + ']'.repeat(8))).toEqual(['A']);
    expect(normalizeClarificationOptions('["A"]' + ']'.repeat(9))).toEqual([]);
    expect(normalizeClarificationOptions(JSON.stringify(['A'.repeat(16384)]) + '}')).toEqual([]);
    expect(normalizeClarificationOptions('['.repeat(10) + '"A"' + ']'.repeat(10))).toEqual([]);
  });

  test('an open-ended question may omit options entirely', async () => {
    expect(await ask(undefined)).toMatchObject({ type: 'clarification_needed' });
    expect(await ask(undefined)).not.toHaveProperty('options');
  });

  test('filtering all unsupported choices returns a structured error rather than an empty list', async () => {
    const output = JSON.parse(await withRunContext(createRunContext(policy), () => createAskUserClarificationTool().invoke({
      question: 'Confirm HN400×200?', optionsJson: ['Confirm HN400×200'],
    }, { configurable: { agentState: { draftState: { inferredType: 'beam',
      engineeringDraft: { sections: { beam: 'HN400×200' } } } } } })));
    expect(output).toMatchObject({ success: false, errorCode: 'CLARIFICATION_OPTIONS_INVALID', reason: 'NO_SUPPORTED_OPTIONS' });
    expect(output).not.toHaveProperty('options');
  });

  test('the tool instructs the agent to repeat candidate values in the question in both languages', () => {
    expect(createAskUserClarificationTool().description).toContain('MUST also appear in the question text');
    expect(createAskUserClarificationTool().description).toContain('也必须写入问题正文');
  });

  test('short acceptance options are bound to the exact displayed draft candidates', async () => {
    const shape = { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 };
    const output = JSON.parse(await withRunContext(createRunContext(policy), () => createAskUserClarificationTool().invoke({
      question: '请核对助手记忆的尺寸 200×100×7×11.4 mm。', optionsJson: ['确认', '另填'],
      candidateOptions: [{ sectionId: 'S1', field: 'shape', optionIndex: 0 }],
    }, { configurable: { agentState: { draftState: { inferredType: 'beam', engineeringDraft: {
      sectionRecords: [{ id: 'S1', shape, extra: { provenance: { shape: 'llm-table' } } }],
    } } } } })));
    expect(output.sectionCandidates).toEqual([{ id: expect.stringMatching(/^candidate:/), sectionId: 'S1', field: 'shape',
      values: shape, optionIds: ['option-1'] }]);
    expect(output.clarificationId).toMatch(/^clarification:/);
  });

  test('newly offered dimensions bind a number-free external reply without a prior draft candidate', async () => {
    const { conversationSectionEvidence } = await import('../../../dist/agent-langgraph/tools/input-message.js');
    const { assertConfirmedSectionInputs } = await import('../../../dist/engineering/section-provenance.js');
    const values = { H: 200, B: 100, tw: 7, tf: 11.4 };
    const output = JSON.parse(await withRunContext(createRunContext(policy), () => createAskUserClarificationTool().invoke({
      question: 'Please verify assistant-recalled dimensions 200×100×7×11.4 mm.', optionsJson: ['确认', 'Other'],
      candidateOptions: [{ sectionId: 'S1', field: 'shape', optionIndex: 0, values }],
    })));
    expect(output.sectionCandidates).toHaveLength(1);
    const messages = [{ role: 'tool', name: 'ask_user_clarification', content: JSON.stringify(output) }];
    const section = { id: 'S1', shape: { kind: 'I', ...values }, extra: { provenance: { shape: 'user' } } };
    expect(() => assertConfirmedSectionInputs({ sections: [section] }, conversationSectionEvidence({ messages }))).toThrow();
    messages.push({ role: 'human', content: '确认' });
    expect(() => assertConfirmedSectionInputs({ sections: [section] }, conversationSectionEvidence({ messages }))).not.toThrow();
    expect(() => assertConfirmedSectionInputs({ sections: [{ ...section, shape: { ...section.shape, tw: 8 } }] },
      conversationSectionEvidence({ messages }))).toThrow();
  });

  test('normalizes provider object choices before exposing them to a UI or host', async () => {
    const policy = resolveRunPolicy({ availableSkillIds: [], availableToolIds: ['ask_user_clarification'],
      defaultToolIds: ['ask_user_clarification'], executionOwner: 'external' });
    const output = await withRunContext(createRunContext(policy), () => createAskUserClarificationTool().invoke({
      candidateOptions: [{ sectionId: 'S1', field: 'shape', optionIndex: 0, values: { B: 100, H: 200 } }],
      question: 'Material and section?', optionsJson: JSON.stringify([
        { label: ' Q235, 100×200 mm ', value: 'alternative' }, { label: 'C30, 250×500 mm' },
        { label: '', text: 'Explicit elastic properties' }, { value: 'Other section' },
        ' Q235, 100×200 mm ', null, 42, { label: {} }, '',
      ]),
    }));
    expect(JSON.parse(output).options).toEqual(['Q235, 100×200 mm', 'C30, 250×500 mm', 'Explicit elastic properties', 'Other section']);
  });

  test.each(['Confirm columns 400×400 mm and beams 250×500 mm?', '确认柱400×400毫米、梁250×500毫米？'])(
    'rejects an unbound numeric proposal before asking the user: %s', async question => {
      const result = JSON.parse(await createAskUserClarificationTool().invoke({ question }));
      expect(result.errorCode).toBe('SECTION_CANDIDATES_REQUIRED');
      expect(result).not.toHaveProperty('type');
      expect(result.hint).toContain('candidateOptions');
      const repaired = JSON.parse(await withRunContext(createRunContext(policy), () => createAskUserClarificationTool().invoke({
        question, candidateOptions: [
          { sectionId: 'column', field: 'shape', optionIndex: 0, values: { B: 400, H: 400 } },
          { sectionId: 'beam', field: 'shape', optionIndex: 0, values: { B: 250, H: 500 } },
        ],
      })));
      expect(repaired.type).toBe('clarification_needed');
      expect(repaired.sectionCandidates).toHaveLength(2);
    });
});
