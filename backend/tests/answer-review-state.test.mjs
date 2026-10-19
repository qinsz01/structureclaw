// Final-answer review against the current state: action claims bind to the current run, and
// placeholder-stiffness displacements are not evidence (docs/agent-architecture.md, guard layer).
import { describe, expect, test } from '@jest/globals';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

const { reviewFinalAnswer } = await import('../dist/agent-langgraph/delivery/answer-review.js');
const { beginAnalysisRequest } = await import('../dist/engineering/model-state.js');

test('historical tool values and statics derived from a clarification answer are evidence', () => {
  const messages = [new ToolMessage({ tool_call_id: 'past', content: '{"value":9.876}' }), new HumanMessage('Continue'),
    new ToolMessage({ tool_call_id: 'answer', content: JSON.stringify({ type: 'clarification_answered', answer: '10 m, 1 kN' }) })];
  expect(reviewFinalAnswer({ text: 'Reaction 0.5 kN; moment 2.5 kN·m; deflection 9.876 mm.', state: {}, messages,
    currentTurnMessages: messages.slice(1) }).numbers).toEqual([]);
});

test('a turn without analysis only appends a note and never asks the LLM to correct', async () => {
  const { reviewAndDeliverFinalAnswer } = await import('../dist/agent-langgraph/delivery/final-review.js');
  let calls = 0;
  const result = await reviewAndDeliverFinalAnswer({ response: new AIMessage('The report has been generated.'),
    state: { locale: 'en' }, messages: [], currentTurnMessages: [], ledger: { answerCorrections: 0 }, repairEnabled: true,
    log: { warn() {} }, reinvoke: async () => { calls++; throw new Error('unexpected correction'); },
    deliver: response => ({ message: response, final: true }) });
  expect(calls).toBe(0);
  expect(result.content).toContain('Note (result check)');
});

const model = { nodes: [{ id: 'A', x: 0, y: 0, z: 0 }, { id: 'B', x: 10, y: 0, z: 0 }], elements: [{ id: '1', type: 'beam', nodes: ['A', 'B'] }],
  materials: [], sections: [], load_cases: [] };

function current(extra = {}, data = { reactions: { A: { fz: 0.5 } }, displacements: { B: { uz: -0.0123 } } }, metadata) {
  const base = { model: metadata ? { ...model, metadata } : model, modelRevision: 0 };
  const pending = beginAnalysisRequest(base, 'settings');
  return { ...base, ...pending, analysisResult: { runId: 'r1', success: true, meta: { ...pending.analysisRequest }, data,
    ...(metadata ? { modelSnapshot: { metadata } } : {}) }, ...extra };
}
const review = (text, state) => reviewFinalAnswer({ text, state, messages: [new HumanMessage('beam 10 m, 1 kN'), new AIMessage(text)], currentTurnMessages: [] });
const claims = (text, state) => review(text, state).actions.map(row => row.action);

describe('claimed actions need the current state', () => {
  test('analysis: a current analysis, not a stale one', () => {
    expect(claims('静力分析已完成。', current())).toEqual([]);
    expect(claims('静力分析已完成。', { ...current(), model: { ...model, nodes: [] } })).toEqual(['analysis']);
    expect(claims('静力分析已完成。', { model })).toEqual(['analysis']);
  });

  test('report: a report of the current run', () => {
    expect(claims('The report has been generated and saved.', current({ report: { json: { meta: { runId: 'r1' } } } }))).toEqual([]);
    expect(claims('The report has been generated and saved.', current({ report: { json: { meta: { runId: 'old' } } } }))).toEqual(['report']);
    expect(claims('The report has been generated and saved.', current())).toEqual(['report']);
  });

  test('checks passed: a current code check whose complianceStatus is pass', () => {
    const check = complianceStatus => ({ codeCheckResult: { complianceStatus, meta: { runId: 'r1' } } });
    expect(claims('All checks passed.', current(check('pass')))).toEqual([]);
    expect(claims('All checks passed.', current(check('fail')))).toEqual(['check-passed']);
    expect(claims('All checks passed.', current({ codeCheckResult: { complianceStatus: 'pass', meta: { runId: 'old' } } }))).toEqual(['check-passed']);
  });
});

describe('placeholder runs are evidence without displacements', () => {
  test('a placeholder displacement is unverified; an ordinary one is verified', () => {
    const answer = 'Reaction 0.5 kN; midspan deflection 12.3 mm.';
    const placeholder = current({}, undefined, { stiffnessPlaceholder: { material: true, section: true } });
    expect(review(answer, placeholder).numbers.map(row => row.raw)).toEqual(['12.3 mm']);
    expect(review(answer, current()).numbers).toEqual([]);
  });
});
